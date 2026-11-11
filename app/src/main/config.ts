import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import "dotenv/config";

// --- Provider Registry ---

export type AuthMethod = "api-key" | "oauth";

/** Non-secret provider selection. Secrets live in the encrypted credential store. */
export interface ProviderConfig {
  providerId: string;
  authMethod: AuthMethod;
  modelId?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  authMethods: AuthMethod[];
  defaultModel: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", authMethods: ["api-key", "oauth"], defaultModel: "claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI", authMethods: ["api-key"], defaultModel: "gpt-5.5" },
  { id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus)", authMethods: ["oauth"], defaultModel: "gpt-5.6-sol" },
  { id: "github-copilot", label: "GitHub Copilot", authMethods: ["oauth"], defaultModel: "claude-sonnet-5.5" },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// --- WoW Version Registry ---

export interface WowVersion {
  id: string;
  label: string;
  /** Candidate client folder names under the WoW install root, most likely first. */
  folderNames: string[];
  interfaceId: number;
}

export const WOW_VERSIONS: WowVersion[] = [
  // The launch folder name for Forever is not confirmed by Blizzard documentation;
  // the beta used _classic_beta_. The first folder that exists wins.
  { id: "forever",         label: "WoW Forever",               folderNames: ["_forever_", "forever", "_classic_beta_"], interfaceId: 16001 },
  { id: "retail",          label: "Retail",                    folderNames: ["_retail_"],                 interfaceId: 120000 },
  { id: "tbc_anniversary", label: "TBC Classic Anniversary",   folderNames: ["_anniversary_", "_classic_"], interfaceId: 20505 },
  { id: "mop_classic",     label: "Mists of Pandaria Classic", folderNames: ["_classic_"],                interfaceId: 50503 },
  { id: "classic_era",     label: "Classic Era",               folderNames: ["_classic_era_"],            interfaceId: 11508 },
];

const DEFAULT_VERSION_ID = "forever";

export function getWowVersion(id: string): WowVersion | undefined {
  return WOW_VERSIONS.find((v) => v.id === id);
}

// --- Settings Persistence (non-secret only) ---

export const SETTINGS_DIR = path.join(os.homedir(), ".wow-agent");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

interface Settings {
  wowVersion: string;
  provider?: ProviderConfig;
  /** WoW install root, e.g. C:\Program Files (x86)\World of Warcraft. Empty = auto-detect. */
  wowPath?: string;
  /** Extra hostnames web_fetch may reach, in addition to the built-in allowlist. */
  extraAllowedHosts?: string[];
}

export function ensureSettingsDir(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

/** Write a file readable only by the current user (mode is a no-op on Windows). */
export function writePrivateFile(file: string, data: string | Buffer): void {
  ensureSettingsDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function readRawSettings(): Record<string, any> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // Corrupted or unreadable
  }
  return {};
}

function readSettings(): Settings {
  const raw = readRawSettings();
  return { wowVersion: DEFAULT_VERSION_ID, ...raw } as Settings;
}

function writeSettings(settings: Settings): void {
  try {
    writePrivateFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[config] Failed to write settings:", err);
  }
}

export interface LegacySecrets {
  providerId: string;
  apiKey?: string;
  oauthCredentials?: { refresh: string; access: string; expires: number; [key: string]: unknown };
}

/**
 * Older versions kept the API key and OAuth tokens in plain text inside
 * settings.json. Return them (if any) so the caller can move them into the
 * encrypted store.
 */
export function readLegacySecrets(): LegacySecrets | null {
  const p = readRawSettings().provider;
  if (!p || typeof p !== "object" || typeof p.providerId !== "string") return null;
  if (!p.apiKey && !p.oauthCredentials) return null;
  return { providerId: p.providerId, apiKey: p.apiKey, oauthCredentials: p.oauthCredentials };
}

/** Remove plain-text secrets from settings.json. Call only after they are safely stored elsewhere. */
export function stripLegacySecrets(): void {
  const raw = readRawSettings();
  if (raw.provider && typeof raw.provider === "object") {
    delete raw.provider.apiKey;
    delete raw.provider.oauthCredentials;
    writeSettings(raw as Settings);
  }
}

export function loadSelectedVersion(): string {
  const settings = readSettings();
  return getWowVersion(settings.wowVersion) ? settings.wowVersion : DEFAULT_VERSION_ID;
}

export function saveSelectedVersion(versionId: string): void {
  const settings = readSettings();
  settings.wowVersion = versionId;
  writeSettings(settings);
}

export function loadProviderConfig(): ProviderConfig | null {
  const p = readSettings().provider;
  if (!p || typeof p.providerId !== "string") return null;
  return {
    providerId: p.providerId,
    authMethod: p.authMethod === "oauth" ? "oauth" : "api-key",
    modelId: typeof p.modelId === "string" ? p.modelId : undefined,
  };
}

export function saveProviderConfig(config: ProviderConfig): void {
  const settings = readSettings();
  // Plain-text secrets from an older version stay until they have been moved
  // to the encrypted store (stripLegacySecrets); never drop them silently here.
  const legacy = readLegacySecrets();
  settings.provider = {
    providerId: config.providerId,
    authMethod: config.authMethod,
    modelId: config.modelId,
    ...(legacy && legacy.providerId === config.providerId
      ? { apiKey: legacy.apiKey, oauthCredentials: legacy.oauthCredentials }
      : {}),
  } as ProviderConfig;
  writeSettings(settings);
}

export function loadWowPath(): string {
  const p = readSettings().wowPath;
  return typeof p === "string" ? p : "";
}

export function saveWowPath(wowPath: string): void {
  const settings = readSettings();
  settings.wowPath = wowPath;
  writeSettings(settings);
}

export function loadExtraAllowedHosts(): string[] {
  const hosts = readSettings().extraAllowedHosts;
  return Array.isArray(hosts) ? hosts.filter((h) => typeof h === "string") : [];
}

// --- Path Resolution ---

function installRootCandidates(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  const configured = loadWowPath();
  if (configured) roots.push(configured);

  if (process.platform === "darwin") {
    roots.push(
      path.join(home, "Applications", "World of Warcraft"),
      "/Applications/World of Warcraft",
    );
  } else if (process.platform === "win32") {
    for (const drive of ["C", "D", "E", "F"]) {
      roots.push(
        `${drive}:\\Program Files (x86)\\World of Warcraft`,
        `${drive}:\\Program Files\\World of Warcraft`,
        `${drive}:\\World of Warcraft`,
        `${drive}:\\Games\\World of Warcraft`,
      );
    }
    roots.push(path.join(home, "Games", "World of Warcraft"));
  }
  return roots;
}

/**
 * Find the client folder for a WoW version, e.g.
 * C:\Program Files (x86)\World of Warcraft\_forever_. Returns "" if not found.
 * The configured path may point at the install root or directly at a client folder.
 */
export function findVersionFolder(version: WowVersion): string {
  for (const root of installRootCandidates()) {
    for (const folder of version.folderNames) {
      const candidate = path.join(root, folder);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // Configured path pointing directly at a client folder (it contains Interface or WTF).
  const configured = loadWowPath();
  if (
    configured &&
    version.folderNames.includes(path.basename(configured)) &&
    fs.existsSync(configured)
  ) {
    return configured;
  }
  return "";
}

/** WTF directory for a version. WOW_WTF_PATH overrides detection. */
export function findWtfPath(version: WowVersion): string {
  if (process.env.WOW_WTF_PATH) return process.env.WOW_WTF_PATH;
  const folder = findVersionFolder(version);
  return folder ? path.join(folder, "WTF") : "";
}

/** Interface/AddOns directory for a version (may not exist yet). */
export function findAddOnsPath(version: WowVersion): string {
  const folder = findVersionFolder(version);
  return folder ? path.join(folder, "Interface", "AddOns") : "";
}

/**
 * Find WoWAgent.lua SavedVariables files under WTF/Account/<name>/SavedVariables.
 * With several accounts, the most recently written file wins.
 */
export function findSavedVariablesFile(wtfPath: string): string | null {
  if (!wtfPath) return null;
  const accountDir = path.join(wtfPath, "Account");
  if (!fs.existsSync(accountDir)) return null;

  let best: { file: string; mtime: number } | null = null;
  try {
    for (const account of fs.readdirSync(accountDir)) {
      const svFile = path.join(accountDir, account, "SavedVariables", "WoWAgent.lua");
      try {
        const stat = fs.statSync(svFile);
        if (!best || stat.mtimeMs > best.mtime) best = { file: svFile, mtime: stat.mtimeMs };
      } catch {
        // No file for this account
      }
    }
  } catch {
    // Directory read failed
  }
  return best ? best.file : null;
}

export const WINDOW_DEFAULTS = {
  width: 520,
  height: 480,
  alwaysOnTop: true,
  opacity: 0.95,
};
