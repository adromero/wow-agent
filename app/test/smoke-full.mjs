// Manual end-to-end smoke test against a fake WoW folder (see make-fixture.mjs).
// Usage: HOME=<fixture home> npx electron test/smoke-full.mjs
// Uses dummy credential values only; the provider is expected to reject them.
import { app, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OLD_VALUE = "dummy-old-value-from-settings";
const NEW_VALUE = "dummy-new-value-from-window";

const settingsDir = path.join(os.homedir(), ".wow-agent");
const wowPath = JSON.parse(
  fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"),
).wowPath;
const shotDir = path.join(wowPath, "_forever_", "Screenshots");

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    let result;
    try {
      result = await win.webContents.executeJavaScript(`(async () => {
        const events = [];
        window.wowAgent.on("agent-event", (e) => events.push(e.type + (e.message ? ": " + e.message : "")));
        let shot = null;
        window.wowAgent.on("screenshot-captured", (d) => { shot = d; });
        const out = {};
        const state = await window.wowAgent.invoke("get-game-state");
        out.statePlayer = state && state.game_state.player.name;
        out.stateQuests = state && state.game_state.quests.length;
        out.header = document.getElementById("ctx-player").textContent + " | " + document.getElementById("ctx-zone").textContent;
        out.wowPath = await window.wowAgent.invoke("get-wow-path");
        out.addonBefore = (await window.wowAgent.invoke("check-addon-installed")).installed;
        out.install = (await window.wowAgent.invoke("install-addon")).success;
        out.addonAfter = (await window.wowAgent.invoke("check-addon-installed")).installed;
        out.configBefore = await window.wowAgent.invoke("get-provider-config");
        out.saveKey = await window.wowAgent.invoke("save-api-key", { providerId: "anthropic", apiKey: ${JSON.stringify(NEW_VALUE)} });
        out.configAfter = await window.wowAgent.invoke("get-provider-config");
        out.refresh = (await window.wowAgent.invoke("refresh-game-state")).found;
        document.title = "READY_FOR_SHOT";
        for (let i = 0; i < 40 && !shot; i++) await new Promise((r) => setTimeout(r, 250));
        out.shotEvent = shot ? Object.keys(shot) : null;
        const thumb = shot ? await window.wowAgent.invoke("get-screenshot-thumbnail", shot.id) : null;
        out.thumb = thumb ? thumb.slice(0, 30) + "... (" + thumb.length + " chars)" : null;
        await new Promise((r) => setTimeout(r, 500));
        out.previewShown = !document.getElementById("screenshot-preview").classList.contains("hidden");
        // Send a chat message with the screenshot attached.
        document.getElementById("message-input").value = "What should I do next?";
        document.getElementById("send-button").click();
        for (let i = 0; i < 100 && !events.some((e) => e.startsWith("error") || e === "agent_end"); i++) await new Promise((r) => setTimeout(r, 250));
        await new Promise((r) => setTimeout(r, 500));
        out.events = events;
        out.memory = await window.wowAgent.invoke("get-memory");
        out.conversation = await window.wowAgent.invoke("get-conversation");
        out.messages = [...document.querySelectorAll("#messages .message")].map((m) => m.className + " => " + m.textContent.trim().replace(/\\s+/g, " ").slice(0, 200) + (m.querySelector("img") ? " [thumbnail]" : ""));
        out.inputEnabled = !document.getElementById("message-input").disabled;
        return out;
      })()`);
    } catch (err) {
      result = { error: String(err) };
    }
    const onDisk = {};
    for (const f of fs.readdirSync(settingsDir, { recursive: true })) {
      const file = path.join(settingsDir, f);
      if (!fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "latin1");
      onDisk[f] = {
        mode: (fs.statSync(file).mode & 0o777).toString(8),
        containsOldValue: text.includes(OLD_VALUE),
        containsNewValue: text.includes(NEW_VALUE),
      };
    }
    console.log("SMOKE_RESULT " + JSON.stringify({ result, onDisk }, null, 1));
    app.exit(0);
  });

  // Drop a "screenshot" into the watched folder once the page asks for it.
  win.on("page-title-updated", (_ev, title) => {
    if (title !== "READY_FOR_SHOT") return;
    const img = nativeImage.createFromBitmap(Buffer.alloc(2560 * 1440 * 4, 120), {
      width: 2560,
      height: 1440,
    });
    fs.writeFileSync(path.join(shotDir, "WoWScrnShot_111126_120000.jpg"), img.toJPEG(90));
  });
});

await import("../dist/main/index.js");
