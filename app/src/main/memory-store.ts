import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { SETTINGS_DIR, writePrivateFile } from "./config.js";
import type { WoWAgentDB } from "./lua-reader.js";

/**
 * Per-character memory, stored as plain JSON files under
 * ~/.wow-agent/memory/<version>/<character>/:
 *   notes.json    long-term notes the AI saved with its `remember` tool
 *   history.json  a compact text transcript of the last conversation
 */

const MEMORY_DIR = path.join(SETTINGS_DIR, "memory");

export const MAX_NOTES = 100;
export const MAX_NOTE_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_TEXT = 6000;

export interface MemoryNote {
  id: string;
  text: string;
  created: number;
}

/** A user or assistant turn reduced to its text. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /** Fields needed to hand an assistant turn back to the AI library. */
  api?: string;
  provider?: string;
  model?: string;
}

export interface MemoryScope {
  versionId: string;
  /** Folder-safe key, e.g. "thrallina-stormforge", or "_no-character". */
  characterKey: string;
  /** Human-readable label, e.g. "Thrallina (Stormforge)". */
  label: string;
}

function safeSegment(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return cleaned || "_";
}

export function scopeFor(versionId: string, db: WoWAgentDB | null): MemoryScope {
  const player = db?.game_state?.player;
  if (!player || typeof player.name !== "string" || !player.name) {
    return { versionId, characterKey: "_no-character", label: "No character synced yet" };
  }
  const realm = typeof player.realm === "string" ? player.realm : "";
  return {
    versionId,
    characterKey: safeSegment(player.name) + (realm ? `-${safeSegment(realm)}` : ""),
    label: realm ? `${player.name} (${realm})` : player.name,
  };
}

export function sameScope(a: MemoryScope | null, b: MemoryScope | null): boolean {
  return !!a && !!b && a.versionId === b.versionId && a.characterKey === b.characterKey;
}

function scopeDir(scope: MemoryScope): string {
  // Both segments are sanitized, so the result cannot leave MEMORY_DIR.
  return path.join(MEMORY_DIR, safeSegment(scope.versionId), safeSegment(scope.characterKey));
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    // Corrupted or unreadable: start fresh rather than crash
  }
  return fallback;
}

function writeJson(scope: MemoryScope, name: string, data: unknown): void {
  const dir = scopeDir(scope);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFile(path.join(dir, name), JSON.stringify(data, null, 2));
}

// --- Notes ---

export function loadNotes(scope: MemoryScope): MemoryNote[] {
  const notes = readJson<unknown>(path.join(scopeDir(scope), "notes.json"), []);
  if (!Array.isArray(notes)) return [];
  return notes.filter(
    (n): n is MemoryNote =>
      !!n && typeof n.id === "string" && typeof n.text === "string" && typeof n.created === "number",
  );
}

/** Normalize note text: one line, trimmed, length-capped. */
export function cleanNoteText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH);
}

export function addNote(scope: MemoryScope, text: string): MemoryNote {
  const cleaned = cleanNoteText(text);
  if (!cleaned) throw new Error("The note is empty.");
  const notes = loadNotes(scope);
  const existing = notes.find((n) => n.text.toLowerCase() === cleaned.toLowerCase());
  if (existing) return existing;
  if (notes.length >= MAX_NOTES) {
    throw new Error(
      `Memory is full (${MAX_NOTES} notes). Forget notes that are no longer useful before adding more.`,
    );
  }
  const note: MemoryNote = {
    id: crypto.randomBytes(3).toString("hex"),
    text: cleaned,
    created: Date.now(),
  };
  notes.push(note);
  writeJson(scope, "notes.json", notes);
  return note;
}

export function removeNote(scope: MemoryScope, id: string): boolean {
  const notes = loadNotes(scope);
  const remaining = notes.filter((n) => n.id !== id);
  if (remaining.length === notes.length) return false;
  writeJson(scope, "notes.json", remaining);
  return true;
}

export function clearNotes(scope: MemoryScope): void {
  if (loadNotes(scope).length > 0) writeJson(scope, "notes.json", []);
}

/** The notes as a block for the system prompt, or "" when there are none. */
export function formatNotesForPrompt(scope: MemoryScope, notes: MemoryNote[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map(
    (n) => `- [${n.id}] (${new Date(n.created).toISOString().slice(0, 10)}) ${n.text}`,
  );
  return `<memory character="${scope.label.replace(/"/g, "'")}">\n${lines.join("\n")}\n</memory>`;
}

// --- Conversation history ---

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "image") return "[screenshot]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Reduce the agent's message list to a small, valid text transcript:
 * user and assistant text only (no system prompt, tool calls, tool results or
 * image data), strictly alternating, starting with a user turn and ending
 * with a completed assistant turn.
 */
export function toTranscript(messages: readonly unknown[]): TranscriptMessage[] {
  const turns: TranscriptMessage[] = [];

  for (const raw of messages) {
    const m = raw as Record<string, any>;
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) continue;

    const text = textOf(m.content).trim().slice(0, MAX_HISTORY_TEXT);
    if (!text) continue;

    const turn: TranscriptMessage = {
      role: m.role,
      text,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
    };
    if (m.role === "assistant") {
      turn.api = m.api;
      turn.provider = m.provider;
      turn.model = m.model;
    }

    // Merge consecutive turns from the same side (text before and after a tool call, retries).
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) {
      last.text = `${last.text}\n\n${turn.text}`.slice(0, MAX_HISTORY_TEXT);
      Object.assign(last, { api: turn.api ?? last.api, provider: turn.provider ?? last.provider, model: turn.model ?? last.model });
    } else {
      turns.push(turn);
    }
  }

  while (turns.length > 0 && turns[turns.length - 1].role !== "assistant") turns.pop();
  let recent = turns.slice(-MAX_HISTORY_MESSAGES);
  while (recent.length > 0 && recent[0].role !== "user") recent = recent.slice(1);
  return recent;
}

export function loadTranscript(scope: MemoryScope): TranscriptMessage[] {
  const saved = readJson<unknown>(path.join(scopeDir(scope), "history.json"), []);
  if (!Array.isArray(saved)) return [];
  // Re-validate through the same reducer so a hand-edited file cannot break the chat.
  return toTranscript(
    saved.map((t: any) => ({
      role: t?.role,
      content: typeof t?.text === "string" ? t.text : "",
      timestamp: t?.timestamp,
      api: t?.api,
      provider: t?.provider,
      model: t?.model,
    })),
  );
}

export function saveTranscript(scope: MemoryScope, messages: readonly unknown[]): void {
  writeJson(scope, "history.json", toTranscript(messages));
}

export function clearTranscript(scope: MemoryScope): void {
  const file = path.join(scopeDir(scope), "history.json");
  if (fs.existsSync(file)) writeJson(scope, "history.json", []);
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Turn a saved transcript back into messages the agent can continue from. */
export function toAgentMessages(
  transcript: TranscriptMessage[],
  fallback: { api: string; provider: string; model: string },
): any[] {
  return transcript.map((t) =>
    t.role === "user"
      ? { role: "user", content: t.text, timestamp: t.timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: t.text }],
          api: t.api || fallback.api,
          provider: t.provider || fallback.provider,
          model: t.model || fallback.model,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: t.timestamp,
        },
  );
}

const GAME_CONTEXT = /^<game_context>[\s\S]*?<\/game_context>\s*/;

/** The transcript as the chat window shows it: without the game-context preamble. */
export function toDisplay(transcript: TranscriptMessage[]): { role: string; text: string }[] {
  return transcript.map((t) => {
    if (t.role === "assistant") return { role: "assistant", text: t.text };
    const text = t.text.replace(GAME_CONTEXT, "");
    const zone = text.match(/^\[Zone Update\] The player moved from (.+?) to (.+?)\. /);
    return zone
      ? { role: "system", text: `Zone changed: ${zone[1]} → ${zone[2]}.` }
      : { role: "user", text };
  });
}
