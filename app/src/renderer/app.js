// Renderer process - runs in browser context with nodeIntegration enabled
const { ipcRenderer } = require("electron");

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

let isStreaming = false;
let pendingScreenshot = null;
let currentStreamDiv = null;
let currentStreamText = "";

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addMessage(role, content, imagePath) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent =
    role === "error" ? "Error" : role.charAt(0).toUpperCase() + role.slice(1);

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  if (imagePath) {
    const thumb = document.createElement("img");
    thumb.className = "message-thumbnail";
    thumb.src = `file://${imagePath}`;
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

  const imagePath = pendingScreenshot;
  addMessage("user", text, imagePath);
  messageInput.value = "";
  messageInput.style.height = "auto";
  setInputEnabled(false);

  if (imagePath) {
    ipcRenderer.send("send-message", { text, imagePath });
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
    ctxPlayer.textContent = `${gs.player.name} (${gs.player.level} ${gs.player.class})`;
  }

  if (gs.zone) {
    const zone =
      gs.zone.instance_type !== "none"
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
}

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

ipcRenderer.on("version-changed", (_event, data) => {
  versionLabel.textContent = data.label;
  versionSelect.value = data.id;
  addMessage("system", `Switched to ${data.label}. Conversation cleared.`);
});

// --- Screenshot handling ---

ipcRenderer.on("screenshot-captured", (_event, data) => {
  pendingScreenshot = data.filePath;
  screenshotImg.src = `file://${data.filePath}`;
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
    // Load version info
    const [versions, selectedVersion, data] = await Promise.all([
      ipcRenderer.invoke("get-wow-versions"),
      ipcRenderer.invoke("get-selected-version"),
      ipcRenderer.invoke("get-game-state"),
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

    // Game state
    if (data) {
      updateGameContextBar(data);
      updateSyncStatus(data);
    }
  } catch {
    // Not connected yet
  }
})();
