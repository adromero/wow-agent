import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

import {
  WOW_VERSIONS,
  WINDOW_DEFAULTS,
  getWowVersion,
  getProvider,
  loadSelectedVersion,
  saveSelectedVersion,
  findWtfPath,
  findVersionFolder,
  findAddOnsPath,
  findSavedVariablesFile,
  PROVIDERS,
  loadProviderConfig,
  saveProviderConfig,
  loadWowPath,
  saveWowPath,
  loadExtraAllowedHosts,
  stripLegacySecrets,
  type ProviderConfig,
} from "./config.js";
import { SecureCredentialStore } from "./secure-store.js";
import { FileWatcher } from "./file-watcher.js";
import { ScreenshotWatcher } from "./screenshot-watcher.js";
import {
  createAgent,
  formatGameContext,
  formatZoneLookupPrompt,
  getProviderModels,
  getModelsCollection,
  initModels,
} from "./agent.js";
import { DEFAULT_ALLOWED_HOSTS } from "./tools/web-fetch.js";
import {
  clearNotes,
  clearTranscript,
  loadNotes,
  loadTranscript,
  removeNote,
  sameScope,
  saveTranscript,
  scopeFor,
  toDisplay,
  type MemoryScope,
} from "./memory-store.js";
import type { WoWAgentDB } from "./lua-reader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RENDERER_INDEX = path.join(__dirname, "..", "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).href;
const PRELOAD = path.join(__dirname, "preload.cjs");

const MAX_MESSAGE_LENGTH = 20000;
const MAX_SCREENSHOT_BYTES = 30 * 1024 * 1024;
/** Longest edge of an image sent to the AI; larger screenshots are scaled down. */
const MAX_IMAGE_EDGE = 1568;

let mainWindow: BrowserWindow | null = null;
let fileWatcher: FileWatcher | null = null;
let screenshotWatcher: ScreenshotWatcher | null = null;
let agent: Agent | null = null;
let currentVersionId: string = loadSelectedVersion();
let currentProviderConfig: ProviderConfig | null = loadProviderConfig();
let lastZoneName: string | null = null;
let isAgentBusy = false;

const credentialStore = new SecureCredentialStore();

/**
 * Lets "Clear chat" stop the agent being replaced from saving its transcript
 * again when it is aborted.
 */
let currentSaveGuard = { discard: false };

/** Which character's memory the current agent was created with. */
let currentScope: MemoryScope = scopeFor(currentVersionId, null);

function describeConversation() {
  return { character: currentScope.label, messages: toDisplay(loadTranscript(currentScope)) };
}

function describeMemory() {
  return {
    character: currentScope.label,
    notes: loadNotes(currentScope).map((n) => ({ id: n.id, text: n.text, created: n.created })),
  };
}

/** Screenshots the watcher has reported, by opaque id. The renderer never sees a file path. */
const screenshots = new Map<string, string>();

/** Resolver for the OAuth prompt currently shown in the window, if any. */
let pendingOAuthPrompt: ((value: string) => void) | null = null;

function sendToRenderer(channel: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function getAllowedHosts(): string[] {
  return [...DEFAULT_ALLOWED_HOSTS, ...loadExtraAllowedHosts()];
}

// --- Window ---

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_DEFAULTS.width,
    height: WINDOW_DEFAULTS.height,
    alwaysOnTop: WINDOW_DEFAULTS.alwaysOnTop,
    opacity: WINDOW_DEFAULTS.opacity,
    frame: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1a2e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
    },
  });

  // The window only ever shows its own bundled page.
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== RENDERER_URL) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  // Stay above a game running in fullscreen-windowed (borderless) mode. The
  // plain always-on-top level sits below such windows on Windows, and Windows
  // can drop the topmost flag when a fullscreen window takes focus, so use the
  // highest level and re-assert it whenever this window loses focus.
  const keepOnTop = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  };
  keepOnTop();
  win.on("blur", keepOnTop);
  win.on("show", keepOnTop);

  win.loadFile(RENDERER_INDEX);
  return win;
}

/** Global hotkey: hide the overlay, or bring it back above the game without taking focus. */
const TOGGLE_SHORTCUT = "Control+Alt+A";

function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.showInactive(); // the "show" handler puts it back on top
  }
}

// --- IPC helpers ---

/** Accept IPC only from the top-level frame of our own page in our own window. */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    !!frame &&
    frame === mainWindow.webContents.mainFrame &&
    frame.url === RENDERER_URL
  );
}

function handle(
  channel: string,
  fn: (payload: any) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted sender");
    return fn(payload);
  });
}

function on(channel: string, fn: (payload: any) => void): void {
  ipcMain.on(channel, (event, payload) => {
    if (!isTrustedSender(event)) return;
    fn(payload);
  });
}

// --- Screenshots ---

/** Resolve a screenshot id to a real file inside the Screenshots directory, or null. */
function resolveScreenshot(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const filePath = screenshots.get(id);
  const dir = screenshotWatcher?.getScreenshotsDir();
  if (!filePath || !dir) return null;
  try {
    const realFile = fs.realpathSync(filePath);
    const realDir = fs.realpathSync(dir);
    if (path.dirname(realFile) !== realDir) return null;
    const ext = path.extname(realFile).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(ext)) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) return null;
    return realFile;
  } catch {
    return null;
  }
}

/** Load a screenshot scaled so its longest edge is at most maxEdge, as JPEG. */
function loadScaledJpeg(filePath: string, maxEdge: number, quality: number): Buffer | null {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const scaled =
    scale < 1
      ? image.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: "good",
        })
      : image;
  return scaled.toJPEG(quality);
}

// --- Provider helpers ---

async function describeProviderConfig() {
  if (!currentProviderConfig) return null;
  const credential = await credentialStore.read(currentProviderConfig.providerId);
  return {
    providerId: currentProviderConfig.providerId,
    authMethod: currentProviderConfig.authMethod,
    hasApiKey: credential?.type === "api_key",
    hasOAuth: credential?.type === "oauth",
    modelId: currentProviderConfig.modelId,
    canPersist: credentialStore.canPersist(),
  };
}

function describeWowPath() {
  const version = getWowVersion(currentVersionId);
  const folder = version ? findVersionFolder(version) : "";
  const wtf = version ? findWtfPath(version) : "";
  return {
    configured: loadWowPath(),
    clientFolder: folder,
    hasSavedVariables: !!findSavedVariablesFile(wtf),
  };
}

function restartWatchers(): void {
  lastZoneName = null; // so the next sync does not trigger a zone lookup
  fileWatcher?.stop();
  fileWatcher = null;
  setupFileWatcher();
  screenshotWatcher?.stop();
  screenshotWatcher = null;
  screenshots.clear();
  setupScreenshotWatcher();
}

// --- IPC ---

function setupIPC(): void {
  // User sends a chat message (with optional screenshot)
  on("send-message", async (payload) => {
    if (!agent || !mainWindow) return;
    if (!payload || typeof payload.text !== "string") return;
    const text = payload.text.slice(0, MAX_MESSAGE_LENGTH);
    if (!text.trim()) return;

    if (isAgentBusy) {
      sendToRenderer("agent-event", {
        type: "error",
        message: "Still working on the previous request. Try again in a moment.",
      });
      return;
    }

    try {
      const gameContext = formatGameContext(fileWatcher?.getLastData() || null);
      const fullMessage = gameContext ? `${gameContext}\n\n${text}` : text;

      let image: Buffer | null = null;
      if (payload.screenshotId !== undefined) {
        const filePath = resolveScreenshot(payload.screenshotId);
        image = filePath ? loadScaledJpeg(filePath, MAX_IMAGE_EDGE, 85) : null;
        if (!image) {
          sendToRenderer("agent-event", {
            type: "error",
            message: "That screenshot could not be read, so the message was not sent.",
          });
          return;
        }
      }

      isAgentBusy = true;
      try {
        if (image) {
          await agent.prompt(fullMessage, [
            { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
          ]);
        } else {
          await agent.prompt(fullMessage);
        }
      } finally {
        isAgentBusy = false;
      }
    } catch (err: any) {
      sendToRenderer("agent-event", {
        type: "error",
        message: err?.message || "Unknown error",
      });
    }
  });

  handle("get-game-state", () => fileWatcher?.getLastData() || null);

  // Refresh button: re-locate and re-read SavedVariables without waiting for a file change
  handle("refresh-game-state", () => {
    if (!fileWatcher) {
      setupFileWatcher();
      if (!screenshotWatcher) setupScreenshotWatcher();
    }
    const found = fileWatcher ? fileWatcher.refresh() : false;
    return { found, data: fileWatcher?.getLastData() || null, ...describeWowPath() };
  });

  on("abort-response", () => {
    agent?.abort();
  });

  on("clear-conversation", () => {
    currentSaveGuard.discard = true;
    clearTranscript(currentScope);
    setupAgent(); // fresh agent: empty chat, current notes
    sendToRenderer("conversation-loaded", describeConversation());
  });

  // --- Memory ---

  handle("get-conversation", () => describeConversation());

  handle("get-memory", () => describeMemory());

  handle("delete-memory-note", (id) => {
    if (typeof id === "string") removeNote(currentScope, id);
    refreshAgentMemory();
    return describeMemory();
  });

  handle("clear-memory-notes", () => {
    clearNotes(currentScope);
    refreshAgentMemory();
    return describeMemory();
  });

  // --- Version management ---

  handle("get-wow-versions", () =>
    WOW_VERSIONS.map((v) => ({ id: v.id, label: v.label })),
  );

  handle("get-selected-version", () => currentVersionId);

  on("set-wow-version", (versionId) => {
    if (typeof versionId !== "string" || !getWowVersion(versionId)) return;
    if (versionId === currentVersionId) return;

    currentVersionId = versionId;
    saveSelectedVersion(versionId);
    restartWatchers();
    setupAgent(); // new system prompt, and that version's memory

    const version = getWowVersion(versionId)!;
    sendToRenderer("version-changed", { id: version.id, label: version.label });
    sendToRenderer("conversation-loaded", describeConversation());
  });

  // --- WoW install location ---

  handle("get-wow-path", () => describeWowPath());

  handle("choose-wow-path", async () => {
    if (!mainWindow) return describeWowPath();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select your World of Warcraft folder",
      properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
      saveWowPath(result.filePaths[0]);
      restartWatchers();
    }
    return describeWowPath();
  });

  // --- Provider management ---

  handle("get-providers", () =>
    PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      authMethods: p.authMethods,
      defaultModel: p.defaultModel,
    })),
  );

  handle("get-provider-models", (providerId) =>
    typeof providerId === "string" && getProvider(providerId)
      ? getProviderModels(providerId)
      : [],
  );

  // The raw key or token is never sent to the window - only whether one is stored.
  handle("get-provider-config", () => describeProviderConfig());

  handle("set-provider-config", (config) => {
    const provider = getProvider(config?.providerId);
    if (!provider) return { success: false, error: "Unknown provider" };
    const authMethod = provider.authMethods.includes(config.authMethod)
      ? config.authMethod
      : provider.authMethods[0];
    const models = getProviderModels(provider.id);
    const modelId =
      typeof config.modelId === "string" && models.some((m) => m.id === config.modelId)
        ? config.modelId
        : undefined;

    currentProviderConfig = { providerId: provider.id, authMethod, modelId };
    saveProviderConfig(currentProviderConfig);
    setupAgent();
    return { success: true };
  });

  handle("save-api-key", async (payload) => {
    const provider = getProvider(payload?.providerId);
    const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
    if (!provider || !provider.authMethods.includes("api-key")) {
      return { success: false, error: "This provider does not use an API key" };
    }
    if (!apiKey || apiKey.length > 1000) {
      return { success: false, error: "Invalid API key" };
    }
    await credentialStore.modify(provider.id, async () => ({ type: "api_key", key: apiKey }));
    stripLegacySecrets(); // a new key replaces any plain-text one left by an older version
    currentProviderConfig = {
      providerId: provider.id,
      authMethod: "api-key",
      modelId:
        currentProviderConfig?.providerId === provider.id
          ? currentProviderConfig.modelId
          : undefined,
    };
    saveProviderConfig(currentProviderConfig);
    setupAgent();
    return { success: true, persisted: credentialStore.canPersist() };
  });

  on("oauth-prompt-response", (response) => {
    const resolve = pendingOAuthPrompt;
    pendingOAuthPrompt = null;
    resolve?.(typeof response === "string" ? response : "");
  });

  handle("oauth-login", async (providerId) => {
    const provider = getProvider(providerId);
    if (!provider || !provider.authMethods.includes("oauth")) {
      return { success: false, error: "This provider does not support login" };
    }

    const openExternal = (url: string) => {
      // Only ever hand https links to the system browser.
      try {
        if (new URL(url).protocol === "https:") void shell.openExternal(url);
      } catch {
        // Not a URL
      }
    };

    try {
      await getModelsCollection().login(provider.id, "oauth", {
        prompt: (prompt: AuthPrompt) =>
          new Promise<string>((resolve, reject) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
              reject(new Error("Window closed"));
              return;
            }
            let message = prompt.message;
            let options: readonly { id: string; label: string }[] = [];
            if (prompt.type === "select") {
              options = prompt.options;
              message +=
                "\n" + options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") +
                "\nEnter the number of your choice.";
            }
            pendingOAuthPrompt = (value: string) => {
              if (prompt.type === "select") {
                const picked = options[Number(value.trim()) - 1];
                if (picked) resolve(picked.id);
                else reject(new Error("Invalid selection"));
              } else {
                resolve(value);
              }
            };
            prompt.signal?.addEventListener("abort", () => {
              pendingOAuthPrompt = null;
              sendToRenderer("oauth-prompt-cancel");
              reject(new Error("Prompt cancelled"));
            });
            sendToRenderer("oauth-prompt", {
              message,
              placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
              secret: prompt.type === "secret",
            });
          }),
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") {
            openExternal(event.url);
            sendToRenderer("oauth-auth-started", { instructions: event.instructions });
          } else if (event.type === "device_code") {
            openExternal(event.verificationUri);
            sendToRenderer("oauth-progress", {
              message: `Enter code ${event.userCode} in the browser page that just opened.`,
            });
          } else {
            sendToRenderer("oauth-progress", { message: event.message });
          }
        },
      });

      currentProviderConfig = {
        providerId: provider.id,
        authMethod: "oauth",
        modelId:
          currentProviderConfig?.providerId === provider.id
            ? currentProviderConfig.modelId
            : undefined,
      };
      saveProviderConfig(currentProviderConfig);
      setupAgent();
      return { success: true, persisted: credentialStore.canPersist() };
    } catch (err: any) {
      pendingOAuthPrompt = null;
      return { success: false, error: err?.message || "Login failed" };
    }
  });

  handle("oauth-logout", async () => {
    if (currentProviderConfig) {
      await getModelsCollection().logout(currentProviderConfig.providerId);
      stripLegacySecrets();
      setupAgent();
    }
    return { success: true };
  });

  // --- Screenshots ---

  handle("get-screenshot-thumbnail", (id) => {
    const filePath = resolveScreenshot(id);
    const jpeg = filePath ? loadScaledJpeg(filePath, 480, 70) : null;
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : null;
  });

  // --- Addon install ---

  handle("check-addon-installed", () => {
    const version = getWowVersion(currentVersionId);
    const addonsPath = version ? findAddOnsPath(version) : "";
    if (!addonsPath) return { installed: false, addonsPath: "" };
    return {
      installed: fs.existsSync(path.join(addonsPath, "WoWAgent", "WoWAgent.toc")),
      addonsPath,
    };
  });

  handle("install-addon", () => {
    const version = getWowVersion(currentVersionId);
    if (!version) return { success: false, error: "No WoW version selected" };

    const addonsPath = findAddOnsPath(version);
    if (!addonsPath) {
      return {
        success: false,
        error: `Could not find the ${version.label} folder. Set your WoW folder above.`,
      };
    }

    // Source: bundled in resources (packaged) or project root (dev)
    const addonSource = app.isPackaged
      ? path.join(process.resourcesPath, "addon", "WoWAgent")
      : path.join(__dirname, "..", "..", "..", "addon", "WoWAgent");

    if (!fs.existsSync(addonSource)) {
      return { success: false, error: "Addon files are missing from this build" };
    }

    const destDir = path.join(addonsPath, "WoWAgent");

    try {
      // A symlink (from install.sh) already points at the source; leave it alone.
      if (fs.existsSync(destDir) && fs.lstatSync(destDir).isSymbolicLink()) {
        return { success: true, path: destDir };
      }
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(addonSource)) {
        const srcFile = path.join(addonSource, file);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(destDir, file));
        }
      }
      return { success: true, path: destDir };
    } catch (err: any) {
      return { success: false, error: err?.message || "Failed to copy addon files" };
    }
  });
}

// --- Watchers ---

function setupFileWatcher(): void {
  const version = getWowVersion(currentVersionId);
  const wtfPath = version ? findWtfPath(version) : "";

  if (!wtfPath) {
    console.log("[main] WoW folder not found. Set it in Settings or via WOW_WTF_PATH.");
    return;
  }

  fileWatcher = new FileWatcher(wtfPath);

  fileWatcher.on("update", (data: WoWAgentDB) => {
    console.log("[main] Game state updated from SavedVariables");
    sendToRenderer("game-state-update", data);

    // A different character has its own notes and conversation.
    if (agent && !sameScope(currentScope, scopeFor(currentVersionId, data))) {
      lastZoneName = null; // do not treat the switch as a zone change
      setupAgent();
      sendToRenderer("conversation-loaded", describeConversation());
    }

    // Detect zone changes and auto-prompt the agent
    const zone = data.game_state?.zone;
    const newZone =
      zone && zone.instance_type && zone.instance_type !== "none"
        ? zone.instance_name
        : zone?.name;

    if (newZone && newZone !== lastZoneName) {
      const previousZone = lastZoneName;
      lastZoneName = newZone;

      // Only auto-prompt if this isn't the initial sync and agent is free
      if (previousZone !== null && agent && !isAgentBusy) {
        sendToRenderer("zone-lookup", { from: previousZone, to: newZone });

        const prompt = formatZoneLookupPrompt(data, previousZone, newZone, currentVersionId);
        isAgentBusy = true;
        agent
          .prompt(prompt)
          .catch((err) => {
            console.error("[main] Zone lookup prompt failed:", err?.message);
            sendToRenderer("agent-event", {
              type: "error",
              message: `Zone lookup failed: ${err?.message}`,
            });
          })
          .finally(() => {
            isAgentBusy = false;
          });
      }
    }
  });

  fileWatcher.on("error", (err: Error) => {
    console.error("[main] File watcher error:", err.message);
  });

  fileWatcher.start();
}

function setupScreenshotWatcher(): void {
  const version = getWowVersion(currentVersionId);
  const wtfPath = version ? findWtfPath(version) : "";
  if (!wtfPath) return;

  // The client folder is the parent of the WTF directory
  screenshotWatcher = new ScreenshotWatcher(path.dirname(wtfPath));

  screenshotWatcher.on("screenshot", (data: { filePath: string }) => {
    const id = crypto.randomUUID();
    screenshots.set(id, data.filePath);
    // Keep the map small: only recent screenshots can be attached.
    while (screenshots.size > 20) {
      screenshots.delete(screenshots.keys().next().value!);
    }
    sendToRenderer("screenshot-captured", { id });
  });

  screenshotWatcher.start();
}

function setupAgent(): void {
  if (!mainWindow) return;
  agent?.abort();
  isAgentBusy = false;

  // The conversation is saved under the character it was held with, even if
  // another character is synced before a reply finishes.
  const scope = scopeFor(currentVersionId, fileWatcher?.getLastData() || null);
  currentScope = scope;
  const saveGuard = { discard: false };
  currentSaveGuard = saveGuard;

  try {
    agent = createAgent(
      mainWindow,
      () => fileWatcher?.getLastData() || null,
      currentVersionId,
      currentProviderConfig,
      getAllowedHosts,
      scope,
      (messages) => {
        if (!saveGuard.discard) saveTranscript(scope, messages);
      },
    );
  } catch (err: any) {
    agent = null;
    console.error("[main] Could not create agent:", err?.message);
  }
}

/**
 * After notes were edited in Settings, rebuild the agent so its system prompt
 * matches. The chat continues from the saved transcript. Skipped while a reply
 * is in progress; the next rebuild picks the change up.
 */
function refreshAgentMemory(): void {
  if (!isAgentBusy) setupAgent();
}

// --- App lifecycle ---

// One instance only: two would fight over the same settings and credentials.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // No page in this app may create further web contents or ask for permissions.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);

    await credentialStore.init();
    await credentialStore.migrateLegacySecrets();
    initModels(credentialStore);

    mainWindow = createWindow();

    if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow)) {
      console.warn(`[main] Could not register the ${TOGGLE_SHORTCUT} hotkey (already in use).`);
    }

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

  app.on("will-quit", () => globalShortcut.unregisterAll());

  app.on("window-all-closed", () => {
    fileWatcher?.stop();
    screenshotWatcher?.stop();
    app.quit();
  });
}
