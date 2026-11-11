import type { AgentTool } from "@earendil-works/pi-agent-core";
import { asArray, type WoWAgentDB, type Quest } from "../lua-reader.js";

const SECTIONS = [
  "all",
  "player",
  "target",
  "zone",
  "party",
  "gear",
  "quests",
  "professions",
] as const;

const gameStateParameters = {
  type: "object",
  properties: {
    section: {
      type: "string",
      enum: SECTIONS,
      description: "Which section of game state to retrieve. Default: all",
    },
  },
  additionalProperties: false,
} as const;

const QUALITY_NAMES = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Artifact", "Heirloom"];

function formatMoney(copper: number): string {
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return `${g}g ${s}s ${c}c`;
}

function formatQuest(q: Quest): string[] {
  const lines: string[] = [];
  const tags = [
    q.level ? `level ${q.level}` : "",
    q.status === "complete" ? "READY TO TURN IN" : q.status === "failed" ? "FAILED" : "",
    q.suggested_group ? `group ${q.suggested_group}` : "",
    q.is_daily ? "daily" : "",
    q.id ? `id ${q.id}` : "",
  ].filter(Boolean);
  lines.push(`  - ${q.title}${tags.length ? ` (${tags.join(", ")})` : ""}`);
  for (const o of asArray(q.objectives)) {
    if (!o.text) continue;
    lines.push(`      [${o.done ? "x" : " "}] ${o.text}`);
  }
  return lines;
}

export function formatGameState(
  db: WoWAgentDB | null,
  section?: string,
): string {
  if (!db || !db.game_state) {
    return "No game state available. The user needs to click the Agent Sync button or run /agent sync in WoW to export their current state.";
  }

  const gs = db.game_state;
  const parts: string[] = [];

  const syncAge = db.last_sync
    ? Math.floor(Date.now() / 1000 - db.last_sync)
    : null;
  if (syncAge !== null) {
    const mins = Math.floor(syncAge / 60);
    parts.push(
      `[Last synced: ${mins > 0 ? mins + "m ago" : syncAge + "s ago"}]`,
    );
  }
  if (gs.client?.version) {
    parts.push(`[Game client: ${gs.client.version}, interface ${gs.client.interface ?? "?"}]`);
  }

  const showAll = !section || section === "all";

  if (showAll || section === "player") {
    const p = gs.player;
    if (p) {
      const spec = p.spec_name ? ` ${p.spec_name}` : "";
      const race = p.race ? `${p.race} ` : "";
      parts.push(
        `Player: ${p.name}${p.realm ? ` (${p.realm})` : ""} - Level ${p.level} ${race}${p.class}${spec}${p.faction ? `, ${p.faction}` : ""}`,
      );
      const trees = asArray(p.talent_trees);
      if (trees.length > 0) {
        parts.push(`  Talents: ${trees.map((t) => `${t.name} ${t.points}`).join(" / ")}`);
      }
      parts.push(
        `  Health: ${p.health}/${p.max_health} | ${p.power_type}: ${p.power}/${p.max_power}${p.is_dead_or_ghost ? " (dead)" : ""}`,
      );
      if (typeof p.xp === "number" && p.xp_max) {
        const rested = p.xp_rested ? `, ${p.xp_rested} rested` : "";
        parts.push(
          `  XP: ${p.xp}/${p.xp_max} (${Math.floor((p.xp / p.xp_max) * 100)}%${rested})`,
        );
      }
      if (typeof p.money_copper === "number") {
        parts.push(`  Money: ${formatMoney(p.money_copper)}`);
      }
      if (p.hearthstone) parts.push(`  Hearthstone: ${p.hearthstone}`);
      if (gs.bags && gs.bags.total_slots > 0) {
        parts.push(`  Bags: ${gs.bags.free_slots} of ${gs.bags.total_slots} slots free`);
      }
    }
  }

  if (showAll || section === "target") {
    const t = gs.target;
    if (t) {
      const levelStr = t.level === -1 ? "Boss" : `Level ${t.level}`;
      parts.push(
        `Target: ${t.name} - ${levelStr} ${t.classification} ${t.class || t.creature_type || ""}`.trim(),
      );
      const hp = typeof t.health_pct === "number" ? `${t.health_pct}%` : "unknown";
      parts.push(
        `  Health: ${hp}${t.is_dead ? " (Dead)" : ""}${t.is_player ? " (Player)" : ""}`,
      );
    } else {
      parts.push("Target: None");
    }
  }

  if (showAll || section === "zone") {
    const z = gs.zone;
    if (z) {
      let zoneStr = `Zone: ${z.name}`;
      if (z.subzone) zoneStr += ` - ${z.subzone}`;
      const p = gs.player;
      if (p && typeof p.map_x === "number" && typeof p.map_y === "number") {
        zoneStr += ` (coordinates ${p.map_x}, ${p.map_y})`;
      }
      parts.push(zoneStr);
      if (z.instance_type && z.instance_type !== "none") {
        parts.push(
          `  Instance: ${z.instance_name} (${z.difficulty_name}, ${z.max_players}-player ${z.instance_type})`,
        );
      }
    }
  }

  if (showAll || section === "party") {
    const party = asArray(gs.party);
    if (party.length > 0) {
      parts.push(`Party (${party.length} members):`);
      for (const m of party) {
        const role = m.role && m.role !== "NONE" ? ` [${m.role}]` : "";
        const hp = typeof m.health_pct === "number" ? ` (${m.health_pct}% HP)` : "";
        parts.push(`  ${m.name} - Level ${m.level} ${m.class}${role}${hp}`);
      }
    } else {
      parts.push("Party: Solo");
    }
  }

  if (showAll || section === "gear") {
    const g = gs.gear;
    if (g) {
      parts.push(
        `Gear: Average iLvl ${g.avg_ilvl} (${g.slot_count} slots equipped)`,
      );
      // The per-slot list is long; in the "all" view only the summary is shown.
      if (section === "gear") {
        for (const item of asArray(g.items)) {
          const quality =
            typeof item.quality === "number" ? QUALITY_NAMES[item.quality] : undefined;
          const extras = [
            item.ilvl ? `ilvl ${item.ilvl}` : "",
            quality || "",
            item.max_durability
              ? `durability ${item.durability ?? 0}/${item.max_durability}`
              : "",
            item.item_id ? `id ${item.item_id}` : "",
          ].filter(Boolean);
          parts.push(`  ${item.slot}: ${item.name || "Unknown item"} (${extras.join(", ")})`);
        }
      } else if (asArray(g.items).length > 0) {
        parts.push('  (request section "gear" for the item in each slot)');
      }
    }
  }

  if (showAll || section === "professions") {
    const profs = asArray(gs.professions);
    if (profs.length > 0) {
      // Classic-style skill lists include weapon skills and languages; show those only on request.
      const shown =
        section === "professions"
          ? profs
          : profs.filter((p) => !p.category || /profession|secondary/i.test(p.category));
      if (shown.length > 0) {
        parts.push(
          `Skills: ${shown.map((p) => `${p.name} ${p.rank ?? "?"}/${p.max_rank ?? "?"}`).join(", ")}`,
        );
      }
    }
  }

  if (showAll || section === "quests") {
    const quests = asArray(gs.quests);
    if (quests.length > 0) {
      parts.push(`Quest log (${quests.length} quests):`);
      if (section === "quests") {
        let category: string | undefined;
        for (const q of quests) {
          if (q.category !== category) {
            category = q.category;
            if (category) parts.push(` ${category}:`);
          }
          parts.push(...formatQuest(q));
        }
      } else {
        for (const q of quests) {
          const done = q.status === "complete" ? " [ready to turn in]" : "";
          parts.push(`  - ${q.title}${q.level ? ` (${q.level})` : ""}${done}`);
        }
        parts.push('  (request section "quests" for objectives and progress)');
      }
    } else if (section === "quests") {
      parts.push(
        "Quest log: no quests exported. The log may be empty, or its categories may be collapsed in-game (collapsed categories are not exported).",
      );
    }
  }

  const errors = gs.errors;
  if (errors && Object.keys(errors).length > 0) {
    parts.push(
      `[The addon could not collect: ${Object.keys(errors).join(", ")}. That information is missing, not empty.]`,
    );
  }

  return parts.join("\n");
}

export function createGameStateTool(
  getGameState: () => WoWAgentDB | null,
): AgentTool<any> {
  return {
    name: "get_game_state",
    label: "Game State",
    description:
      "Get the player's current World of Warcraft game state: character (class, spec, talents, XP, money), target, zone, party, gear, professions and quest log. The \"all\" view summarizes gear and quests; request section \"gear\" or \"quests\" for full detail. Data comes from the last sync in-game.",
    parameters: gameStateParameters,
    execute: async (_toolCallId, params) => {
      const db = getGameState();
      const section =
        typeof params?.section === "string" && (SECTIONS as readonly string[]).includes(params.section)
          ? params.section
          : undefined;
      return {
        content: [{ type: "text", text: formatGameState(db, section) }],
        details: null,
      };
    },
  };
}
