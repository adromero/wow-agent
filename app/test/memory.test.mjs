import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The settings folder is derived from the home directory at import time, so
// point HOME at a throwaway folder before loading the modules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "wow-agent-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

let store, agentModule, pi;
before(async () => {
  store = await import("../dist/main/memory-store.js");
  agentModule = await import("../dist/main/agent.js");
  pi = await import("@earendil-works/pi-ai");
});

const db = (name, realm) => ({ game_state: { player: { name, realm } } });

test("memory is scoped per version and character, with folder-safe keys", () => {
  const a = store.scopeFor("forever", db("Thrallina", "Stormforge"));
  const b = store.scopeFor("forever", db("../../Evil\\Name", "x/y"));
  const none = store.scopeFor("forever", null);
  assert.equal(a.characterKey, "thrallina-stormforge");
  assert.equal(a.label, "Thrallina (Stormforge)");
  assert.ok(!/[\\/.]/.test(b.characterKey), b.characterKey);
  assert.equal(none.characterKey, "_no-character");
  assert.ok(store.sameScope(a, store.scopeFor("forever", db("Thrallina", "Stormforge"))));
  assert.ok(!store.sameScope(a, store.scopeFor("retail", db("Thrallina", "Stormforge"))));
});

test("notes are added, deduplicated, capped, removed and kept apart per character", () => {
  const a = store.scopeFor("forever", db("Notetaker", "Realm"));
  const other = store.scopeFor("forever", db("Other", "Realm"));
  const n1 = store.addNote(a, "  Wants to tank\n dungeons at 60  ");
  assert.equal(n1.text, "Wants to tank dungeons at 60");
  assert.equal(store.addNote(a, "wants to TANK dungeons at 60").id, n1.id);
  const n2 = store.addNote(a, "x".repeat(2000));
  assert.equal(n2.text.length, store.MAX_NOTE_LENGTH);
  assert.throws(() => store.addNote(a, "   "));
  assert.equal(store.loadNotes(a).length, 2);
  assert.equal(store.loadNotes(other).length, 0);
  assert.match(store.formatNotesForPrompt(a, store.loadNotes(a)), new RegExp(`\\[${n1.id}\\] \\(\\d{4}-\\d\\d-\\d\\d\\) Wants to tank`));
  assert.ok(store.removeNote(a, n1.id));
  assert.ok(!store.removeNote(a, "nope"));
  store.clearNotes(a);
  assert.equal(store.loadNotes(a).length, 0);
  assert.equal(store.formatNotesForPrompt(a, []), "");

  for (let i = 0; i < store.MAX_NOTES; i++) store.addNote(other, `note ${i}`);
  assert.throws(() => store.addNote(other, "one too many"), /full/);
});

test("the saved transcript keeps only clean alternating user/assistant text", () => {
  const messages = [
    { role: "system", content: "prompt" },
    { role: "user", content: "<game_context>\nPlayer: X\n</game_context>\n\nWhere do I go?", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "toolCall", id: "t1", name: "web_fetch", arguments: {} }], stopReason: "toolUse", api: "a", provider: "p", model: "m", timestamp: 2 },
    { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "HUGE PAGE" }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Go to Ratchet." }], stopReason: "stop", api: "a", provider: "p", model: "m", timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image", data: "AAAA".repeat(1000), mimeType: "image/jpeg" }], timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "boom", timestamp: 6 },
  ];
  const t = store.toTranscript(messages);
  assert.deepEqual(t.map((m) => m.role), ["user", "assistant"]);
  assert.equal(t[1].text, "Let me check.\n\nGo to Ratchet.");
  const json = JSON.stringify(t);
  assert.ok(!json.includes("HUGE PAGE") && !json.includes("AAAA") && !json.includes("prompt"));

  const scope = store.scopeFor("forever", db("Historian", "Realm"));
  store.saveTranscript(scope, messages);
  const loaded = store.loadTranscript(scope);
  assert.equal(loaded.length, 2);
  assert.deepEqual(store.toDisplay(loaded), [
    { role: "user", text: "Where do I go?" },
    { role: "assistant", text: "Let me check.\n\nGo to Ratchet." },
  ]);
  const restored = store.toAgentMessages(loaded, { api: "x", provider: "y", model: "z" });
  assert.equal(restored[1].stopReason, "stop");
  assert.equal(restored[1].provider, "p");
  store.clearTranscript(scope);
  assert.equal(store.loadTranscript(scope).length, 0);
});

test("memory files are private and a corrupted file does not break loading", () => {
  const scope = store.scopeFor("forever", db("Private", "Realm"));
  store.addNote(scope, "secret plan");
  const file = path.join(home, ".wow-agent", "memory", "forever", "private-realm", "notes.json");
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(store.loadNotes(scope), []);
});

test("end to end: the agent remembers a note, the chat is saved, and a new agent starts with both", async () => {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (_c, e) => sent.push(e) } };
  const models = agentModule.initModels(new pi.InMemoryCredentialStore());
  const faux = pi.fauxProvider();
  models.setProvider(faux.provider);
  const config = { providerId: faux.provider.id, authMethod: "api-key", modelId: faux.getModel().id };
  const scope = store.scopeFor("forever", db("Rememberer", "Realm"));
  const gameState = () => null;

  faux.setResponses([
    pi.fauxAssistantMessage([pi.fauxToolCall("remember", { note: "Prefers short answers" })], { stopReason: "toolUse" }),
    pi.fauxAssistantMessage([pi.fauxText("Noted. I will keep answers short.")]),
  ]);
  let saved = 0;
  const agent = agentModule.createAgent(win, gameState, "forever", config, () => [], scope, (messages) => {
    store.saveTranscript(scope, messages);
    saved++;
  });
  assert.match(agent.state.systemPrompt, /no notes saved yet/);
  await agent.prompt("Please keep answers short from now on.");

  assert.equal(saved, 1);
  assert.deepEqual(store.loadNotes(scope).map((n) => n.text), ["Prefers short answers"]);
  assert.ok(sent.some((e) => e.type === "tool_end" && e.toolName === "remember" && !e.isError));
  assert.ok(!sent.some((e) => e.type === "error"), JSON.stringify(sent.filter((e) => e.type === "error")));
  assert.deepEqual(store.toDisplay(store.loadTranscript(scope)), [
    { role: "user", text: "Please keep answers short from now on." },
    { role: "assistant", text: "Noted. I will keep answers short." },
  ]);

  // "Restart": a new agent for the same character sees the note and the conversation.
  faux.setResponses([pi.fauxAssistantMessage([pi.fauxText("Still short.")])]);
  const agent2 = agentModule.createAgent(win, gameState, "forever", config, () => [], scope, (messages) =>
    store.saveTranscript(scope, messages),
  );
  assert.match(agent2.state.systemPrompt, /Prefers short answers/);
  const restoredRoles = agent2.state.messages.map((m) => m.role).filter((r) => r !== "system");
  assert.deepEqual(restoredRoles, ["user", "assistant"]);
  await agent2.prompt("And now?");
  assert.ok(!sent.some((e) => e.type === "error"), JSON.stringify(sent.filter((e) => e.type === "error")));
  assert.equal(store.loadTranscript(scope).length, 4);

  // A different character starts empty.
  const other = store.scopeFor("forever", db("Stranger", "Realm"));
  const agent3 = agentModule.createAgent(win, gameState, "forever", config, () => [], other, () => {});
  assert.match(agent3.state.systemPrompt, /no notes saved yet/);
  assert.equal(agent3.state.messages.filter((m) => m.role !== "system").length, 0);
});
