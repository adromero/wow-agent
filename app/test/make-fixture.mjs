// Build a throwaway home folder and fake WoW install for smoke-full.mjs.
// Usage: node test/make-fixture.mjs <empty dir>
// The settings file imitates the old plain-text format, with a dummy value
// where the API key used to be, so the migration path is exercised.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node test/make-fixture.mjs <dir>");

const home = path.join(root, "home");
const wow = path.join(root, "wow");
const client = path.join(wow, "_forever_");
const sv = path.join(client, "WTF", "Account", "TESTACCT", "SavedVariables");

for (const dir of [
  path.join(home, ".wow-agent"),
  sv,
  path.join(client, "Screenshots"),
  path.join(client, "Interface", "AddOns"),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const testSource = fs.readFileSync(new URL("./game-state.test.mjs", import.meta.url), "utf8");
const saved = testSource
  .match(/const SAVED = `([\s\S]*?)`;/)[1]
  .replace(/\$\{[^}]*\}/, String(Math.floor(Date.now() / 1000) - 30))
  .replace(/\\\\"/g, '\\"');
fs.writeFileSync(path.join(sv, "WoWAgent.lua"), saved);

fs.writeFileSync(
  path.join(home, ".wow-agent", "settings.json"),
  JSON.stringify({
    wowVersion: "forever",
    wowPath: wow,
    provider: {
      providerId: "anthropic",
      authMethod: "api-key",
      apiKey: "dummy-old-value-from-settings",
      modelId: "claude-sonnet-5-5",
    },
  }),
);

console.log(home);
