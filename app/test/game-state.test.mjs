import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSavedVariables } from "../dist/main/lua-reader.js";
import { formatGameState } from "../dist/main/tools/game-state.js";

// Shape written by the addon (WoW serializes arrays positionally with index comments).
const SAVED = `
WoWAgentDB = {
["last_sync"] = ${Math.floor(Date.now() / 1000) - 30},
["version"] = 2,
["button"] = {
["shown"] = true,
},
["game_state"] = {
["player"] = {
["name"] = "Thrallina",
["realm"] = "Stormforge",
["level"] = 23,
["class"] = "SHAMAN",
["race"] = "Orc",
["faction"] = "Horde",
["spec_name"] = "Enhancement",
["talent_trees"] = {
{
["name"] = "Elemental",
["points"] = 0,
}, -- [1]
{
["name"] = "Enhancement",
["points"] = 14,
}, -- [2]
},
["health"] = 820,
["max_health"] = 900,
["power"] = 400,
["max_power"] = 650,
["power_type"] = "Mana",
["xp"] = 5000,
["xp_max"] = 20000,
["money_copper"] = 123456,
["hearthstone"] = "Crossroads",
["is_dead_or_ghost"] = false,
},
["zone"] = {
["name"] = "The Barrens",
["subzone"] = "Ratchet",
["instance_type"] = "none",
},
["party"] = {
},
["gear"] = {
["avg_ilvl"] = 21,
["slot_count"] = 1,
["items"] = {
{
["slot"] = "Chest",
["name"] = "Ringed Buckler \\"of Test\\"",
["item_id"] = 4444,
["ilvl"] = 21,
["quality"] = 2,
["durability"] = 40,
["max_durability"] = 80,
}, -- [1]
},
},
["quests"] = {
{
["id"] = 870,
["title"] = "The Forgotten Pools",
["level"] = 13,
["category"] = "The Barrens",
["status"] = "in_progress",
["objectives"] = {
{
["text"] = "Explore the waters of the Forgotten Pools",
["done"] = false,
}, -- [1]
},
}, -- [1]
{
["id"] = 844,
["title"] = "Plainstrider Menace",
["level"] = 11,
["category"] = "The Barrens",
["status"] = "complete",
["objectives"] = {
{
["text"] = "Plainstrider Beak: 7/7",
["done"] = true,
["have"] = 7,
["need"] = 7,
}, -- [1]
},
}, -- [2]
},
["client"] = {
["version"] = "1.60.1",
["interface"] = 16001,
},
["errors"] = {
["professions"] = "attempt to call a nil value",
},
},
}
`;

test("SavedVariables parse into game state, including quests and gear", () => {
  const db = parseSavedVariables(SAVED).WoWAgentDB;
  assert.equal(db.game_state.player.name, "Thrallina");
  assert.equal(db.game_state.quests.length, 2);
  assert.equal(db.game_state.quests[1].status, "complete");
  assert.equal(db.game_state.gear.items[0].item_id, 4444);
});

test("Lua code in the file is never executed, only literal data is read", () => {
  const vars = parseSavedVariables(
    'WoWAgentDB = { a = os.execute("calc"), b = (function() return 1 end)(), c = 2 }\n__proto__ = { polluted = true }',
  );
  assert.equal(vars.WoWAgentDB.a, null);
  assert.equal(vars.WoWAgentDB.b, null);
  assert.equal(vars.WoWAgentDB.c, 2);
  assert.equal({}.polluted, undefined);
});

test("summary view lists quests and flags missing sections", () => {
  const db = parseSavedVariables(SAVED).WoWAgentDB;
  const text = formatGameState(db);
  assert.match(text, /Level 23 Orc SHAMAN Enhancement, Horde/);
  assert.match(text, /Money: 12g 34s 56c/);
  assert.match(text, /Quest log \(2 quests\)/);
  assert.match(text, /Plainstrider Menace \(11\) \[ready to turn in\]/);
  assert.match(text, /Party: Solo/);
  assert.match(text, /could not collect: professions/);
  assert.match(text, /interface 16001/);
});

test("quests and gear sections give full detail", () => {
  const db = parseSavedVariables(SAVED).WoWAgentDB;
  const quests = formatGameState(db, "quests");
  assert.match(quests, /\[ \] Explore the waters of the Forgotten Pools/);
  assert.match(quests, /\[x\] Plainstrider Beak: 7\/7/);
  assert.match(quests, /READY TO TURN IN/);
  const gear = formatGameState(db, "gear");
  assert.match(gear, /Chest: Ringed Buckler "of Test" \(ilvl 21, Uncommon, durability 40\/80, id 4444\)/);
});

test("no data yields a helpful message", () => {
  assert.match(formatGameState(null), /Agent Sync/);
});
