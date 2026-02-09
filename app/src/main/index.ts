import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
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
} from "./config.js";
import { FileWatcher } from "./file-watcher.js";
import { createAgent, formatGameContext } from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { WoWAgentDB } from "./lua-reader.js";

let mainWindow: BrowserWindow | null = null;
let fileWatcher: FileWatcher | null = null;
let agent: Agent | null = null;
let currentVersionId: string = loadSelectedVersion();

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

  agent = createAgent(mainWindow, getGameState, currentVersionId);
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
