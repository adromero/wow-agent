import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import * as fs from "fs";
import {
  loadConfig,
  WOW_VERSIONS,
  getWowVersion,
  loadSelectedVersion,
  saveSelectedVersion,
  findSavedVariablesPath,
  findScreenshotsPath,
} from "./config.js";
import { FileWatcher } from "./file-watcher.js";
import { ScreenshotWatcher } from "./screenshot-watcher.js";
import {
  createAgent,
  formatGameContext,
  formatZoneLookupPrompt,
} from "./agent.js";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { WoWAgentDB } from "./lua-reader.js";

let mainWindow: BrowserWindow | null = null;
let fileWatcher: FileWatcher | null = null;
let screenshotWatcher: ScreenshotWatcher | null = null;
let agent: Agent | null = null;
let currentVersionId: string = loadSelectedVersion();
let lastZoneName: string | null = null;
let isAgentBusy = false;

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
  // User sends a chat message (with optional screenshot)
  ipcMain.on(
    "send-message",
    async (
      _event,
      payload: string | { text: string; imagePath?: string },
    ) => {
      if (!agent || !mainWindow) return;

      const text = typeof payload === "string" ? payload : payload.text;
      const imagePath =
        typeof payload === "string" ? undefined : payload.imagePath;

      try {
        // Include game context with the user message
        const gameContext = formatGameContext(
          fileWatcher?.getLastData() || null,
        );
        const fullMessage = gameContext
          ? `${gameContext}\n\n${text}`
          : text;

        isAgentBusy = true;
        try {
          if (imagePath && fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64 = imageBuffer.toString("base64");
            const ext = path.extname(imagePath).toLowerCase();
            const mimeMap: Record<string, string> = {
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".png": "image/png",
              ".tga": "image/png", // TGA not natively supported, but fallback
            };
            const mimeType = mimeMap[ext] || "image/jpeg";

            await agent.prompt(fullMessage, [
              { type: "image", data: base64, mimeType },
            ]);
          } else {
            await agent.prompt(fullMessage);
          }
        } finally {
          isAgentBusy = false;
        }
      } catch (err: any) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("agent-event", {
            type: "error",
            message: err.message || "Unknown error",
          });
        }
      }
    },
  );

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
    lastZoneName = null; // Reset so first sync in new version doesn't trigger lookup

    // Restart file watcher with new WTF path
    fileWatcher?.stop();
    fileWatcher = null;
    setupFileWatcher();

    // Restart screenshot watcher
    screenshotWatcher?.stop();
    screenshotWatcher = null;
    setupScreenshotWatcher();

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

    // Detect zone changes and auto-prompt the agent
    const zone = data.game_state?.zone;
    const newZone =
      zone && zone.instance_type !== "none" ? zone.instance_name : zone?.name;

    if (newZone && newZone !== lastZoneName) {
      const previousZone = lastZoneName;
      lastZoneName = newZone;

      // Only auto-prompt if this isn't the initial sync and agent is free
      if (previousZone !== null && agent && !isAgentBusy) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("zone-lookup", {
            from: previousZone,
            to: newZone,
          });
        }

        const prompt = formatZoneLookupPrompt(
          data,
          previousZone,
          newZone,
          currentVersionId,
        );
        isAgentBusy = true;
        agent.prompt(prompt).catch((err) => {
          console.error("[main] Zone lookup prompt failed:", err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("agent-event", {
              type: "error",
              message: `Zone lookup failed: ${err.message}`,
            });
          }
        }).finally(() => {
          isAgentBusy = false;
        });
      }
    }
  });

  fileWatcher.on("error", (err: Error) => {
    console.error("[main] File watcher error:", err);
  });

  fileWatcher.start();
}

function setupScreenshotWatcher(): void {
  const version = getWowVersion(currentVersionId);
  const wtfPath =
    process.env.WOW_WTF_PATH ||
    (version ? findSavedVariablesPath(version.folderName) : "");

  if (!wtfPath) return;

  // Version folder is the parent of the WTF directory
  const versionFolderPath = path.dirname(wtfPath);
  screenshotWatcher = new ScreenshotWatcher(versionFolderPath);

  screenshotWatcher.on("screenshot", (data: { filePath: string }) => {
    console.log("[main] Screenshot detected:", data.filePath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("screenshot-captured", {
        filePath: data.filePath,
      });
    }
  });

  screenshotWatcher.start();
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
  setupScreenshotWatcher();
  setupAgent();

  mainWindow.on("closed", () => {
    mainWindow = null;
    fileWatcher?.stop();
    screenshotWatcher?.stop();
  });
});

app.on("window-all-closed", () => {
  fileWatcher?.stop();
  screenshotWatcher?.stop();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    setupAgent();
  }
});
