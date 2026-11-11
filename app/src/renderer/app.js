// Renderer process - a sandboxed page with no Node access. All communication
// with the main process goes through the small API exposed by the preload script.
const ipcRenderer = {
  invoke: (channel, payload) => window.wowAgent.invoke(channel, payload),
  send: (channel, payload) => window.wowAgent.send(channel, payload),
  on: (channel, listener) => window.wowAgent.on(channel, (data) => listener(null, data)),
};

// Simple markdown rendering (avoids heavy dependency in renderer)
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, _lang, code) => `<pre><code>${code.trim()}</code></pre>`,
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, (match) => {
    // Only wrap orphan <li> runs not already inside <ul>
    if (!match.startsWith("<ul>")) return `<ol>${match}</ol>`;
    return match;
  });

  // Collapse whitespace between list items so paragraph processing doesn't break lists
  html = html.replace(/<\/li>\s+<li>/g, "</li><li>");
  html = html.replace(/<\/li>\s+<\/(?:ul|ol)>/g, (m) => m.replace(/\s+/, ""));

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, "</p><p>");
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs and paragraphs wrapping block elements
  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/<p>\s*(<(?:ul|ol|h[1-3]|pre|blockquote)[\s>])/g, "$1");
  html = html.replace(/(<\/(?:ul|ol|h[1-3]|pre|blockquote)>)\s*<\/p>/g, "$1");

  // Single newlines to <br> within paragraphs
  html = html.replace(
    /(<p>(?:(?!<\/p>)[\s\S])*<\/p>)/g,
    (match) => match.replace(/\n/g, "<br>"),
  );

  return html;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// DOM references
const messagesContainer = document.getElementById("messages");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const thinkingIndicator = document.getElementById("thinking-indicator");
const thinkingText = document.getElementById("thinking-text");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const ctxPlayer = document.getElementById("ctx-player");
const ctxZone = document.getElementById("ctx-zone");
const ctxTarget = document.getElementById("ctx-target");
const settingsButton = document.getElementById("settings-button");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const versionSelect = document.getElementById("version-select");
const versionLabel = document.getElementById("version-label");
const screenshotPreview = document.getElementById("screenshot-preview");
const screenshotImg = document.getElementById("screenshot-img");
const screenshotDismiss = document.getElementById("screenshot-dismiss");

// Provider/auth DOM
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");
const authApikey = document.getElementById("auth-apikey");
const authOauth = document.getElementById("auth-oauth");
const apiKeyInput = document.getElementById("api-key-input");
const saveApikeyBtn = document.getElementById("save-apikey-btn");
const apikeyStatus = document.getElementById("apikey-status");
const oauthLoginBtn = document.getElementById("oauth-login-btn");
const oauthLogoutBtn = document.getElementById("oauth-logout-btn");
const oauthNotConnected = document.getElementById("oauth-not-connected");
const oauthConnected = document.getElementById("oauth-connected");
const oauthFlow = document.getElementById("oauth-flow");
const oauthFlowText = document.getElementById("oauth-flow-text");
const oauthCodeSection = document.getElementById("oauth-code-section");
const oauthCodeInput = document.getElementById("oauth-code-input");
const oauthCodeSubmit = document.getElementById("oauth-code-submit");
const addonStatus = document.getElementById("addon-status");
const addonInstallBtn = document.getElementById("addon-install-btn");
const refreshButton = document.getElementById("refresh-button");
const wowPathStatus = document.getElementById("wow-path-status");
const wowPathBtn = document.getElementById("wow-path-btn");
const memoryCharacter = document.getElementById("memory-character");
const memoryList = document.getElementById("memory-list");
const memoryClearNotes = document.getElementById("memory-clear-notes");
const memoryClearChat = document.getElementById("memory-clear-chat");

let providers = [];
let currentConfig = null;

let isStreaming = false;
let pendingScreenshot = null;
let currentStreamDiv = null;
let currentStreamText = "";

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addMessage(role, content, thumbnail) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent =
    role === "error" ? "Error" : role.charAt(0).toUpperCase() + role.slice(1);

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  // Thumbnails are data URLs produced by the main process; anything else is ignored.
  if (typeof thumbnail === "string" && thumbnail.startsWith("data:image/jpeg;base64,")) {
    const thumb = document.createElement("img");
    thumb.className = "message-thumbnail";
    thumb.src = thumbnail;
    contentDiv.appendChild(thumb);
  }

  if (role === "assistant") {
    contentDiv.innerHTML = renderMarkdown(content);
  } else {
    const textNode = document.createElement("span");
    textNode.textContent = content;
    contentDiv.appendChild(textNode);
  }

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(contentDiv);
  messagesContainer.appendChild(msgDiv);
  scrollToBottom();

  return msgDiv;
}

function startStreamingMessage() {
  currentStreamText = "";
  const msgDiv = document.createElement("div");
  msgDiv.className = "message assistant";

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent = "Assistant";

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(contentDiv);
  messagesContainer.appendChild(msgDiv);
  currentStreamDiv = contentDiv;
  scrollToBottom();
}

function appendStreamDelta(delta) {
  if (!currentStreamDiv) {
    startStreamingMessage();
  }
  currentStreamText += delta;
  currentStreamDiv.innerHTML = renderMarkdown(currentStreamText);
  scrollToBottom();
}

function endStreamingMessage() {
  currentStreamDiv = null;
  currentStreamText = "";
}

function showThinking(text) {
  thinkingText.textContent = text;
  thinkingIndicator.classList.remove("hidden");
  scrollToBottom();
}

function hideThinking() {
  thinkingIndicator.classList.add("hidden");
}

function setInputEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  isStreaming = !enabled;
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isStreaming) return;

  const screenshot = pendingScreenshot;
  addMessage("user", text, screenshot ? screenshot.thumbnail : null);
  messageInput.value = "";
  messageInput.style.height = "auto";
  setInputEnabled(false);

  if (screenshot) {
    ipcRenderer.send("send-message", { text, screenshotId: screenshot.id });
    pendingScreenshot = null;
    screenshotPreview.classList.add("hidden");
  } else {
    ipcRenderer.send("send-message", { text });
  }
}

function updateGameContextBar(data) {
  if (!data || !data.game_state) {
    ctxPlayer.textContent = "";
    ctxZone.textContent = "";
    ctxTarget.textContent = "";
    return;
  }

  const gs = data.game_state;

  if (gs.player) {
    const spec = gs.player.spec_name ? `${gs.player.spec_name} ` : "";
    ctxPlayer.textContent = `${gs.player.name} (${gs.player.level} ${spec}${gs.player.class})`;
  }

  if (gs.zone) {
    const zone =
      gs.zone.instance_type && gs.zone.instance_type !== "none"
        ? `${gs.zone.instance_name}`
        : gs.zone.name;
    ctxZone.textContent = zone;
  }

  if (gs.target) {
    ctxTarget.textContent = `Target: ${gs.target.name}`;
  } else {
    ctxTarget.textContent = "";
  }
}

function updateSyncStatus(data) {
  if (data && data.game_state) {
    statusIndicator.className = "connected";
    const syncAgo = data.last_sync
      ? Math.floor(Date.now() / 1000 - data.last_sync)
      : 0;
    const mins = Math.floor(syncAgo / 60);
    statusText.textContent =
      mins > 0 ? `Synced ${mins}m ago` : `Synced ${syncAgo}s ago`;
  } else {
    statusIndicator.className = "disconnected";
    statusText.textContent = "Waiting for sync...";
  }
}

// --- Settings Modal ---

function openSettings() {
  settingsOverlay.classList.remove("hidden");
  checkAddonStatus();
  refreshWowPathStatus();
  refreshMemory();
}

// --- Memory ---

function showMemory(memory) {
  if (!memory) return;
  memoryCharacter.textContent = `- ${memory.character}`;
  memoryList.replaceChildren();
  if (memory.notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No notes yet. The assistant saves notes as you tell it your goals and preferences.";
    memoryList.appendChild(empty);
  }
  for (const note of memory.notes) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = note.text;
    const remove = document.createElement("button");
    remove.textContent = "\u00d7";
    remove.title = "Forget this note";
    remove.addEventListener("click", async () => {
      showMemory(await ipcRenderer.invoke("delete-memory-note", note.id));
    });
    item.appendChild(text);
    item.appendChild(remove);
    memoryList.appendChild(item);
  }
  memoryClearNotes.disabled = memory.notes.length === 0;
}

async function refreshMemory() {
  try {
    showMemory(await ipcRenderer.invoke("get-memory"));
  } catch {
    memoryCharacter.textContent = "";
  }
}

memoryClearNotes.addEventListener("click", async () => {
  showMemory(await ipcRenderer.invoke("clear-memory-notes"));
});

memoryClearChat.addEventListener("click", () => {
  ipcRenderer.send("clear-conversation");
});

/** Replace the chat with a saved conversation (on start, character switch or clear). */
function showConversation(conversation) {
  messagesContainer.replaceChildren();
  endStreamingMessage();
  hideThinking();
  setInputEnabled(true);
  if (!conversation || conversation.messages.length === 0) {
    addMessage("system", "Welcome to WoW Agent! Click the Agent Sync button in-game (or type /agent sync) to share your game state, then ask me anything about WoW.");
    return;
  }
  for (const message of conversation.messages) {
    addMessage(message.role, message.text);
  }
  addMessage("system", `Restored your last conversation for ${conversation.character}.`);
}

ipcRenderer.on("conversation-loaded", (_event, conversation) => {
  showConversation(conversation);
  refreshMemory();
});

// --- WoW folder ---

function showWowPath(info) {
  if (!info) return;
  if (info.clientFolder) {
    wowPathStatus.textContent = info.hasSavedVariables
      ? info.clientFolder
      : `${info.clientFolder} (no sync yet)`;
    wowPathStatus.className = "auth-status connected";
  } else {
    wowPathStatus.textContent = info.configured
      ? "Selected version not found in that folder"
      : "Not found - choose your WoW folder";
    wowPathStatus.className = "auth-status error";
  }
}

async function refreshWowPathStatus() {
  try {
    showWowPath(await ipcRenderer.invoke("get-wow-path"));
  } catch {
    wowPathStatus.textContent = "Error checking";
    wowPathStatus.className = "auth-status error";
  }
}

wowPathBtn.addEventListener("click", async () => {
  wowPathBtn.disabled = true;
  try {
    showWowPath(await ipcRenderer.invoke("choose-wow-path"));
    await checkAddonStatus();
  } finally {
    wowPathBtn.disabled = false;
  }
});

// --- Refresh button ---

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    const result = await ipcRenderer.invoke("refresh-game-state");
    if (result.found) {
      // The main process also emits game-state-update, which updates the header.
    } else if (!result.clientFolder) {
      addMessage("system", "WoW folder not found. Open Settings and choose your World of Warcraft folder.");
    } else {
      addMessage("system", "No game state found yet. Click the Agent Sync button in-game (or type /agent sync) first.");
    }
  } catch {
    addMessage("error", "Could not refresh game state.");
  } finally {
    refreshButton.disabled = false;
  }
});

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

settingsButton.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

versionSelect.addEventListener("change", () => {
  ipcRenderer.send("set-wow-version", versionSelect.value);
});

// --- Provider Settings ---

function updateAuthSection(provider) {
  authApikey.classList.add("hidden");
  authOauth.classList.add("hidden");
  oauthFlow.classList.add("hidden");
  oauthCodeSection.classList.add("hidden");

  if (!provider) return;

  const authMethods = provider.authMethods;
  const preferredAuth = currentConfig?.authMethod ||
    (authMethods.includes("api-key") ? "api-key" : "oauth");

  if (preferredAuth === "api-key" && authMethods.includes("api-key")) {
    authApikey.classList.remove("hidden");
    apiKeyInput.value = "";
    if (currentConfig?.hasApiKey) {
      apikeyStatus.textContent = "API key saved";
      apikeyStatus.className = "auth-status saved";
    } else {
      apikeyStatus.textContent = "";
      apikeyStatus.className = "auth-status";
    }
  } else if (authMethods.includes("oauth")) {
    authOauth.classList.remove("hidden");
    if (currentConfig?.hasOAuth) {
      oauthNotConnected.classList.add("hidden");
      oauthConnected.classList.remove("hidden");
    } else {
      oauthNotConnected.classList.remove("hidden");
      oauthConnected.classList.add("hidden");
    }
  }
}

async function loadModels(providerId) {
  modelSelect.innerHTML = '<option value="">Loading...</option>';
  try {
    const models = await ipcRenderer.invoke("get-provider-models", providerId);
    modelSelect.innerHTML = "";
    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      return;
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      modelSelect.appendChild(opt);
    }
    // Select current model if set
    if (currentConfig?.modelId) {
      modelSelect.value = currentConfig.modelId;
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Failed to load models</option>';
  }
}

providerSelect.addEventListener("change", async () => {
  const providerId = providerSelect.value;
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return;

  // Determine auth method
  const authMethod = provider.authMethods.includes("api-key") ? "api-key" : "oauth";

  // Save provider selection
  currentConfig = await ipcRenderer.invoke("set-provider-config", {
    providerId,
    authMethod,
    modelId: provider.defaultModel,
  });
  // Reload config from main
  currentConfig = await ipcRenderer.invoke("get-provider-config");

  updateAuthSection(provider);
  await loadModels(providerId);

  // Select default model
  if (provider.defaultModel) {
    modelSelect.value = provider.defaultModel;
  }
});

modelSelect.addEventListener("change", async () => {
  if (!currentConfig || !providerSelect.value) return;
  await ipcRenderer.invoke("set-provider-config", {
    providerId: providerSelect.value,
    authMethod: currentConfig.authMethod || "api-key",
    modelId: modelSelect.value,
  });
  currentConfig = await ipcRenderer.invoke("get-provider-config");
});

saveApikeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  const result = await ipcRenderer.invoke("save-api-key", {
    providerId: providerSelect.value,
    apiKey: key,
  });
  apiKeyInput.value = "";
  if (!result.success) {
    apikeyStatus.textContent = result.error || "Could not save API key";
    apikeyStatus.className = "auth-status error";
    return;
  }
  if (modelSelect.value) {
    await ipcRenderer.invoke("set-provider-config", {
      providerId: providerSelect.value,
      authMethod: "api-key",
      modelId: modelSelect.value,
    });
  }
  currentConfig = await ipcRenderer.invoke("get-provider-config");

  if (result.persisted) {
    apikeyStatus.textContent = "API key saved (encrypted)";
    apikeyStatus.className = "auth-status saved";
  } else {
    apikeyStatus.textContent =
      "Key kept for this session only: OS encryption is unavailable, so it was not written to disk";
    apikeyStatus.className = "auth-status error";
  }
});

oauthLoginBtn.addEventListener("click", async () => {
  const providerId = providerSelect.value;
  oauthLoginBtn.disabled = true;
  oauthFlow.classList.remove("hidden");
  oauthFlowText.textContent = "Starting login...";

  const result = await ipcRenderer.invoke("oauth-login", providerId);

  oauthLoginBtn.disabled = false;
  oauthFlow.classList.add("hidden");
  oauthCodeSection.classList.add("hidden");

  if (result.success) {
    currentConfig = await ipcRenderer.invoke("get-provider-config");
    const provider = providers.find((p) => p.id === providerId);
    updateAuthSection(provider);
    await loadModels(providerId);
  } else {
    oauthFlowText.textContent = `Login failed: ${result.error}`;
    oauthFlow.classList.remove("hidden");
  }
});

oauthLogoutBtn.addEventListener("click", async () => {
  await ipcRenderer.invoke("oauth-logout");
  currentConfig = await ipcRenderer.invoke("get-provider-config");
  const provider = providers.find((p) => p.id === providerSelect.value);
  updateAuthSection(provider);
});

// OAuth flow events from main process
ipcRenderer.on("oauth-auth-started", (_event, data) => {
  oauthFlowText.textContent = data.instructions || "Opening browser for login...";
  oauthFlow.classList.remove("hidden");
});

ipcRenderer.on("oauth-prompt", (_event, data) => {
  oauthFlowText.textContent = data.message;
  oauthFlow.classList.remove("hidden");
  oauthCodeSection.classList.remove("hidden");
  oauthCodeInput.type = data.secret ? "password" : "text";
  oauthCodeInput.placeholder = data.placeholder || "Enter value...";
  oauthCodeInput.value = "";
  oauthCodeInput.focus();
});

ipcRenderer.on("oauth-prompt-cancel", () => {
  oauthCodeSection.classList.add("hidden");
});

// One permanent handler: the main process tracks which prompt is pending.
oauthCodeSubmit.addEventListener("click", () => {
  ipcRenderer.send("oauth-prompt-response", oauthCodeInput.value);
  oauthCodeInput.value = "";
  oauthCodeSection.classList.add("hidden");
});

ipcRenderer.on("oauth-progress", (_event, data) => {
  oauthFlowText.textContent = data.message;
});

// --- Addon Install ---

async function checkAddonStatus() {
  try {
    const result = await ipcRenderer.invoke("check-addon-installed");
    if (result.installed) {
      addonStatus.textContent = "Installed";
      addonStatus.className = "auth-status connected";
    } else if (result.addonsPath) {
      addonStatus.textContent = "Not installed";
      addonStatus.className = "auth-status";
    } else {
      addonStatus.textContent = "WoW not found";
      addonStatus.className = "auth-status error";
    }
  } catch {
    addonStatus.textContent = "Error checking";
    addonStatus.className = "auth-status error";
  }
}

addonInstallBtn.addEventListener("click", async () => {
  addonInstallBtn.disabled = true;
  addonStatus.textContent = "Installing...";
  addonStatus.className = "auth-status";

  try {
    const result = await ipcRenderer.invoke("install-addon");
    if (result.success) {
      addonStatus.textContent = "Installed";
      addonStatus.className = "auth-status connected";
      addMessage("system", "WoW addon installed successfully. Restart WoW or type /reload to activate.");
    } else {
      addonStatus.textContent = result.error;
      addonStatus.className = "auth-status error";
    }
  } catch (err) {
    addonStatus.textContent = "Install failed";
    addonStatus.className = "auth-status error";
  }

  addonInstallBtn.disabled = false;
});

// --- IPC Event Listeners ---

ipcRenderer.on("agent-event", (_event, data) => {
  switch (data.type) {
    case "agent_start":
      showThinking("Thinking...");
      break;

    case "agent_end":
      hideThinking();
      endStreamingMessage();
      setInputEnabled(true);
      break;

    case "text_delta":
      hideThinking();
      appendStreamDelta(data.delta);
      break;

    case "text_end":
      // Final text already streamed via deltas
      break;

    case "message_end":
      // Streaming deltas already rendered the content; just finalize
      endStreamingMessage();
      break;

    case "tool_start":
      showThinking(`Using ${data.toolName}...`);
      break;

    case "tool_end":
      hideThinking();
      if (data.toolName === "remember" || data.toolName === "forget") refreshMemory();
      break;

    case "error":
      hideThinking();
      endStreamingMessage();
      addMessage("error", data.message);
      setInputEnabled(true);
      break;
  }
});

ipcRenderer.on("game-state-update", (_event, data) => {
  updateGameContextBar(data);
  updateSyncStatus(data);
  addMessage("system", "Game state updated from WoW.");
});

ipcRenderer.on("zone-lookup", (_event, data) => {
  addMessage("system", `Zone changed: ${data.from} \u2192 ${data.to}. Looking up zone info...`);
  setInputEnabled(false);
});

ipcRenderer.on("version-changed", (_event, data) => {
  versionLabel.textContent = data.label;
  versionSelect.value = data.id;
  // The main process follows up with conversation-loaded for that version.
});

// --- Screenshot handling ---

ipcRenderer.on("screenshot-captured", async (_event, data) => {
  const thumbnail = await ipcRenderer.invoke("get-screenshot-thumbnail", data.id);
  if (!thumbnail) return;
  pendingScreenshot = { id: data.id, thumbnail };
  screenshotImg.src = thumbnail;
  screenshotPreview.classList.remove("hidden");
  scrollToBottom();
});

screenshotDismiss.addEventListener("click", () => {
  pendingScreenshot = null;
  screenshotPreview.classList.add("hidden");
});

// --- Input Handling ---

// Enter to send, Shift+Enter for newline
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
});

sendButton.addEventListener("click", sendMessage);

// Initial state check
(async () => {
  try {
    // Load version info, providers, and game state in parallel
    const [versions, selectedVersion, data, providerList, providerConfig] = await Promise.all([
      ipcRenderer.invoke("get-wow-versions"),
      ipcRenderer.invoke("get-selected-version"),
      ipcRenderer.invoke("get-game-state"),
      ipcRenderer.invoke("get-providers"),
      ipcRenderer.invoke("get-provider-config"),
    ]);

    // Populate version dropdown
    for (const v of versions) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      versionSelect.appendChild(opt);
    }
    versionSelect.value = selectedVersion;

    // Show current version in header
    const current = versions.find((v) => v.id === selectedVersion);
    if (current) {
      versionLabel.textContent = current.label;
    }

    // Restore the last conversation for the current character
    const conversation = await ipcRenderer.invoke("get-conversation");
    if (conversation.messages.length > 0) showConversation(conversation);

    // Game state
    if (data) {
      updateGameContextBar(data);
      updateSyncStatus(data);
    }

    // Populate providers
    providers = providerList;
    currentConfig = providerConfig;

    for (const p of providers) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      providerSelect.appendChild(opt);
    }

    // Select current provider
    if (currentConfig?.providerId) {
      providerSelect.value = currentConfig.providerId;
      const prov = providers.find((p) => p.id === currentConfig.providerId);
      updateAuthSection(prov);
      await loadModels(currentConfig.providerId);
    } else if (providers.length > 0) {
      providerSelect.value = providers[0].id;
      updateAuthSection(providers[0]);
      await loadModels(providers[0].id);
    }
  } catch {
    // Not connected yet
  }
})();
