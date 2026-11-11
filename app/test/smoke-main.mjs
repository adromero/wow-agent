// Manual smoke test: `npx electron test/smoke-main.mjs` (after `npm run build`).
// Starts the real app, then checks from inside the chat page that it is
// isolated from Node and that the preload bridge works. Prints JSON and exits.
import { app } from "electron";

const consoleMessages = [];

app.on("browser-window-created", (_e, win) => {
  win.webContents.on("console-message", (event) => {
    consoleMessages.push(`${event.level}: ${event.message}`);
  });
  win.webContents.once("did-finish-load", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    let result;
    try {
      result = await win.webContents.executeJavaScript(`(async () => {
        document.getElementById("settings-button").click();
        await new Promise((r) => setTimeout(r, 300));
        const blocked = await window.wowAgent.invoke("evil-channel").then(() => "allowed", () => "blocked");
        let inlineRan = false;
        const s = document.createElement("script");
        s.textContent = "window.__inline = true";
        document.head.appendChild(s);
        inlineRan = window.__inline === true;
        return {
          requireType: typeof require,
          processType: typeof process,
          moduleType: typeof module,
          bridgeKeys: Object.keys(window.wowAgent),
          hasIpcRenderer: "ipcRenderer" in window,
          versions: await window.wowAgent.invoke("get-wow-versions"),
          selected: await window.wowAgent.invoke("get-selected-version"),
          providers: (await window.wowAgent.invoke("get-providers")).map((p) => p.id),
          anthropicModels: (await window.wowAgent.invoke("get-provider-models", "anthropic")).length,
          providerConfig: await window.wowAgent.invoke("get-provider-config"),
          wowPath: await window.wowAgent.invoke("get-wow-path"),
          refresh: (await window.wowAgent.invoke("refresh-game-state")).found,
          badThumb: await window.wowAgent.invoke("get-screenshot-thumbnail", "../../etc/passwd"),
          memory: await window.wowAgent.invoke("get-memory"),
          conversation: await window.wowAgent.invoke("get-conversation"),
          memoryRows: document.querySelectorAll("#memory-list li").length,
          blockedChannel: blocked,
          inlineScriptRan: inlineRan,
          versionOptions: document.getElementById("version-select").options.length,
          providerOptions: document.getElementById("provider-select").options.length,
          modelOptions: document.getElementById("model-select").options.length,
          welcome: document.querySelector("#messages .message-content").textContent.trim().slice(0, 40),
        };
      })()`);
    } catch (err) {
      result = { error: String(err) };
    }
    console.log("SMOKE_RESULT " + JSON.stringify({ result, consoleMessages }, null, 1));
    app.exit(0);
  });
});

await import("../dist/main/index.js");
