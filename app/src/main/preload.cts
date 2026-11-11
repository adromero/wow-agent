// Preload script: the only bridge between the sandboxed chat window and the
// main process. It runs with context isolation, so the page never sees
// ipcRenderer or any Node API - only the fixed set of functions below.
import { contextBridge, ipcRenderer } from "electron";

const INVOKE_CHANNELS = [
  "get-game-state",
  "refresh-game-state",
  "get-wow-versions",
  "get-selected-version",
  "get-providers",
  "get-provider-models",
  "get-provider-config",
  "set-provider-config",
  "save-api-key",
  "oauth-login",
  "oauth-logout",
  "check-addon-installed",
  "install-addon",
  "get-wow-path",
  "choose-wow-path",
  "get-screenshot-thumbnail",
  "get-conversation",
  "get-memory",
  "delete-memory-note",
  "clear-memory-notes",
] as const;

const SEND_CHANNELS = [
  "send-message",
  "abort-response",
  "clear-conversation",
  "set-wow-version",
  "oauth-prompt-response",
] as const;

const EVENT_CHANNELS = [
  "agent-event",
  "game-state-update",
  "zone-lookup",
  "version-changed",
  "screenshot-captured",
  "oauth-auth-started",
  "oauth-prompt",
  "oauth-prompt-cancel",
  "oauth-progress",
  "conversation-loaded",
] as const;

contextBridge.exposeInMainWorld("wowAgent", {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
      return Promise.reject(new Error(`Blocked channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel: string, payload?: unknown): void {
    if (!(SEND_CHANNELS as readonly string[]).includes(channel)) return;
    ipcRenderer.send(channel, payload);
  },
  on(channel: string, listener: (data: unknown) => void): void {
    if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) return;
    // Never hand the IpcRendererEvent object to the page.
    ipcRenderer.on(channel, (_event, data) => listener(data));
  },
});
