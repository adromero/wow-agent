import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  loadConfig,
  WOW_VERSIONS,
  getWowVersion,
  loadSelectedVersion,
  saveSelectedVersion,
  findSavedVariablesPath,
  findAddOnsPath,
  PROVIDERS,
  loadProviderConfig,
  saveProviderConfig,
  updateOAuthCredentials,
  clearProviderAuth,
  type ProviderConfig,
  type OAuthCredentials,
} from "./config.js";
import { FileWatcher } from "./file-watcher.js";
import { createAgent, formatGameContext, getProviderModels } from "./agent.js";
import { getOAuthProvider, type OAuthAuthInfo, type OAuthPrompt } from "@mariozechner/pi-ai";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { WoWAgentDB } from "./lua-reader.js";

let mainWindow: BrowserWindow | null = null;
let fileWatcher: FileWatcher | null = null;
let agent: Agent | null = null;
let currentVersionId: string = loadSelectedVersion();
let currentProviderConfig: ProviderConfig | null = loadProviderConfig();

function createWindow(): BrowserWindow {
  const config = loadConfig();

  const win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    alwaysOnTop: config.window.alwaysOnTop,
    opacity: config.window.opacity,
    frame: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1a2e",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Load the renderer HTML
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  return win;
}

function setupIPC(): void {
  // User sends a chat message
  ipcMain.on("send-message", async (_event, message: string) => {
    if (!agent || !mainWindow) return;

    try {
      // Include game context with the user message
      const gameContext = formatGameContext(
        fileWatcher?.getLastData() || null,
      );
      const fullMessage = gameContext
        ? `${gameContext}\n\n${message}`
        : message;

      await agent.prompt(fullMessage);
    } catch (err: any) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("agent-event", {
          type: "error",
          message: err.message || "Unknown error",
        });
      }
    }
  });

  // Request current game state
  ipcMain.handle("get-game-state", () => {
    return fileWatcher?.getLastData() || null;
  });

  // Request sync status
  ipcMain.handle("get-sync-status", () => {
    const data = fileWatcher?.getLastData();
    return {
      connected: !!data,
      lastSync: data?.last_sync || 0,
      hasGameState: !!(data?.game_state),
    };
  });

  // Abort current agent response
  ipcMain.on("abort-response", () => {
    agent?.abort();
  });

  // Clear conversation
  ipcMain.on("clear-conversation", () => {
    agent?.clearMessages();
  });

  // --- Version management IPC ---

  ipcMain.handle("get-wow-versions", () => {
    return WOW_VERSIONS.map((v) => ({ id: v.id, label: v.label }));
  });

  ipcMain.handle("get-selected-version", () => {
    return currentVersionId;
  });

  ipcMain.on("set-wow-version", (_event, versionId: string) => {
    if (!getWowVersion(versionId)) return;
    if (versionId === currentVersionId) return;

    currentVersionId = versionId;
    saveSelectedVersion(versionId);

    // Restart file watcher with new WTF path
    fileWatcher?.stop();
    fileWatcher = null;
    setupFileWatcher();

    // Recreate agent with new system prompt
    setupAgent();

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      const version = getWowVersion(versionId)!;
      mainWindow.webContents.send("version-changed", {
        id: version.id,
        label: version.label,
      });
    }
  });

  // --- Provider management IPC ---

  ipcMain.handle("get-providers", () => {
    return PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      authMethods: p.authMethods,
      defaultModel: p.defaultModel,
    }));
  });

  ipcMain.handle("get-provider-models", (_event, providerId: string) => {
    return getProviderModels(providerId, currentProviderConfig);
  });

  ipcMain.handle("get-provider-config", () => {
    if (!currentProviderConfig) return null;
    // Don't send raw API key to renderer - just indicate if one is set
    return {
      providerId: currentProviderConfig.providerId,
      authMethod: currentProviderConfig.authMethod,
      hasApiKey: !!currentProviderConfig.apiKey,
      hasOAuth: !!currentProviderConfig.oauthCredentials,
      modelId: currentProviderConfig.modelId,
    };
  });

  ipcMain.handle("set-provider-config", (_event, config: { providerId: string; authMethod: "api-key" | "oauth"; apiKey?: string; modelId?: string }) => {
    const existing = currentProviderConfig;
    currentProviderConfig = {
      providerId: config.providerId,
      authMethod: config.authMethod,
      apiKey: config.apiKey || existing?.apiKey,
      oauthCredentials: existing?.oauthCredentials,
      modelId: config.modelId,
    };
    saveProviderConfig(currentProviderConfig);
    setupAgent();
    return { success: true };
  });

  ipcMain.handle("oauth-login", async (_event, providerId: string) => {
    const oauthProv = getOAuthProvider(providerId);
    if (!oauthProv) {
      return { success: false, error: `No OAuth provider for ${providerId}` };
    }

    try {
      const credentials = await oauthProv.login({
        onAuth: (info: OAuthAuthInfo) => {
          // Open browser for user to authenticate
          shell.openExternal(info.url);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("oauth-auth-started", {
              url: info.url,
              instructions: info.instructions,
            });
          }
        },
        onPrompt: (prompt: OAuthPrompt) => {
          return new Promise<string>((resolve) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
              resolve("");
              return;
            }
            mainWindow.webContents.send("oauth-prompt", {
              message: prompt.message,
              placeholder: prompt.placeholder,
              allowEmpty: prompt.allowEmpty,
            });
            ipcMain.once("oauth-prompt-response", (_e, response: string) => {
              resolve(response);
            });
          });
        },
        onProgress: (message: string) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("oauth-progress", { message });
          }
        },
        onManualCodeInput: () => {
          return new Promise<string>((resolve) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
              resolve("");
              return;
            }
            mainWindow.webContents.send("oauth-manual-code");
            ipcMain.once("oauth-code-response", (_e, code: string) => {
              resolve(code);
            });
          });
        },
      });

      // Save credentials
      currentProviderConfig = {
        providerId,
        authMethod: "oauth",
        oauthCredentials: credentials as OAuthCredentials,
        modelId: currentProviderConfig?.modelId,
      };
      saveProviderConfig(currentProviderConfig);
      setupAgent();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || "OAuth login failed" };
    }
  });

  ipcMain.handle("oauth-logout", () => {
    clearProviderAuth();
    currentProviderConfig = loadProviderConfig();
    setupAgent();
    return { success: true };
  });

  // --- Addon install IPC ---

  ipcMain.handle("check-addon-installed", () => {
    const version = getWowVersion(currentVersionId);
    if (!version) return { installed: false };
    const addonsPath = findAddOnsPath(version.folderName);
    if (!addonsPath) return { installed: false, addonsPath: "" };
    const addonDir = path.join(addonsPath, "WoWAgent");
    return { installed: fs.existsSync(addonDir), addonsPath };
  });

  ipcMain.handle("install-addon", () => {
    const version = getWowVersion(currentVersionId);
    if (!version) return { success: false, error: "No WoW version selected" };

    const addonsPath = findAddOnsPath(version.folderName);
    if (!addonsPath) return { success: false, error: "Could not find WoW AddOns directory" };

    // Source: bundled in resources (packaged) or project root (dev)
    let addonSource: string;
    if (app.isPackaged) {
      addonSource = path.join(process.resourcesPath, "addon", "WoWAgent");
    } else {
      addonSource = path.join(__dirname, "..", "..", "..", "addon", "WoWAgent");
    }

    if (!fs.existsSync(addonSource)) {
      return { success: false, error: `Addon source not found: ${addonSource}` };
    }

    const destDir = path.join(addonsPath, "WoWAgent");

    try {
      // Create destination if needed
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // Copy all files
      const files = fs.readdirSync(addonSource);
      for (const file of files) {
        const srcFile = path.join(addonSource, file);
        const destFile = path.join(destDir, file);
        fs.copyFileSync(srcFile, destFile);
      }

      return { success: true, path: destDir };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to copy addon files" };
    }
  });
}

function setupFileWatcher(): void {
  const version = getWowVersion(currentVersionId);
  const wtfPath =
    process.env.WOW_WTF_PATH ||
    (version ? findSavedVariablesPath(version.folderName) : "");

  if (!wtfPath) {
    console.log(
      "[main] No WTF path found. Set WOW_WTF_PATH environment variable.",
    );
    return;
  }

  fileWatcher = new FileWatcher(wtfPath);

  fileWatcher.on("update", (data: WoWAgentDB) => {
    console.log("[main] Game state updated from SavedVariables");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("game-state-update", data);
    }
  });

  fileWatcher.on("error", (err: Error) => {
    console.error("[main] File watcher error:", err);
  });

  fileWatcher.start();
}

function setupAgent(): void {
  if (!mainWindow) return;

  const getGameState = (): WoWAgentDB | null => {
    return fileWatcher?.getLastData() || null;
  };

  agent = createAgent(mainWindow, getGameState, currentVersionId, currentProviderConfig);
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  setupIPC();
  setupFileWatcher();
  setupAgent();

  mainWindow.on("closed", () => {
    mainWindow = null;
    fileWatcher?.stop();
  });
});

app.on("window-all-closed", () => {
  fileWatcher?.stop();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    setupAgent();
  }
});
