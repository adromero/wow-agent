import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// --- WoW Version Registry ---

export interface WowVersion {
  id: string;
  label: string;
  folderName: string;
  interfaceId: number;
}

export const WOW_VERSIONS: WowVersion[] = [
  { id: "retail",          label: "Retail",                    folderName: "_retail_",      interfaceId: 120000 },
  { id: "tbc_anniversary", label: "TBC Classic Anniversary",  folderName: "_classic_",     interfaceId: 20505  },
  { id: "mop_classic",     label: "Mists of Pandaria Classic", folderName: "_classic_",     interfaceId: 50503  },
  { id: "classic_era",     label: "Classic Era",               folderName: "_classic_era_", interfaceId: 11508  },
];

const DEFAULT_VERSION_ID = "tbc_anniversary";

export function getWowVersion(id: string): WowVersion | undefined {
  return WOW_VERSIONS.find((v) => v.id === id);
}

// --- Settings Persistence ---

const SETTINGS_DIR = path.join(os.homedir(), ".wow-agent");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

interface Settings {
  wowVersion: string;
}

function readSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    // Corrupted or unreadable
  }
  return { wowVersion: DEFAULT_VERSION_ID };
}

function writeSettings(settings: Settings): void {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[config] Failed to write settings:", err);
  }
}

export function loadSelectedVersion(): string {
  const settings = readSettings();
  // Validate the stored version still exists
  if (getWowVersion(settings.wowVersion)) {
    return settings.wowVersion;
  }
  return DEFAULT_VERSION_ID;
}

export function saveSelectedVersion(versionId: string): void {
  const settings = readSettings();
  settings.wowVersion = versionId;
  writeSettings(settings);
}

// --- Path Resolution ---

export interface AppConfig {
  savedVariablesPath: string;
  apiKey: string;
  modelId: string;
  window: {
    width: number;
    height: number;
    alwaysOnTop: boolean;
    opacity: number;
  };
}

export function findSavedVariablesPath(folderName: string): string {
  const platform = os.platform();
  const home = os.homedir();

  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      path.join(home, `Applications/World of Warcraft/${folderName}/WTF`),
      `/Applications/World of Warcraft/${folderName}/WTF`,
    );
  } else if (platform === "win32") {
    candidates.push(
      `C:\\Program Files (x86)\\World of Warcraft\\${folderName}\\WTF`,
      `C:\\Program Files\\World of Warcraft\\${folderName}\\WTF`,
      path.join(home, `Games\\World of Warcraft\\${folderName}\\WTF`),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.env.WOW_WTF_PATH || "";
}

/**
 * Find the WoWAgent.lua SavedVariables file within the WTF directory.
 * Searches Account/<name>/SavedVariables/WoWAgent.lua
 */
export function findSavedVariablesFile(wtfPath: string): string | null {
  if (!wtfPath || !fs.existsSync(wtfPath)) return null;

  const accountDir = path.join(wtfPath, "Account");
  if (!fs.existsSync(accountDir)) return null;

  try {
    const accounts = fs.readdirSync(accountDir);
    for (const account of accounts) {
      const svFile = path.join(
        accountDir,
        account,
        "SavedVariables",
        "WoWAgent.lua",
      );
      if (fs.existsSync(svFile)) {
        return svFile;
      }
    }
  } catch {
    // Directory read failed
  }

  return null;
}

export function loadConfig(): AppConfig {
  const versionId = loadSelectedVersion();
  const version = getWowVersion(versionId) || WOW_VERSIONS[1];

  return {
    savedVariablesPath:
      process.env.WOW_WTF_PATH || findSavedVariablesPath(version.folderName),
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    modelId: process.env.WOW_AGENT_MODEL || "claude-sonnet-4-5-20250929",
    window: {
      width: 420,
      height: 700,
      alwaysOnTop: true,
      opacity: 0.95,
    },
  };
}
