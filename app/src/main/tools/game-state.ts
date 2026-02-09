import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { WoWAgentDB, GameState } from "../lua-reader.js";

const gameStateSchema = Type.Object({
  section: Type.Optional(
    Type.Union(
      [
        Type.Literal("all"),
        Type.Literal("player"),
        Type.Literal("target"),
        Type.Literal("zone"),
        Type.Literal("party"),
        Type.Literal("gear"),
      ],
      { description: "Which section of game state to retrieve. Default: all" },
    ),
  ),
});

function formatGameState(
  db: WoWAgentDB | null,
  section?: string,
): string {
  if (!db || !db.game_state) {
    return "No game state available. The user needs to run /agent sync in WoW to export their current state.";
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

  const showAll = !section || section === "all";

  if (showAll || section === "player") {
    const p = gs.player;
    if (p) {
      parts.push(
        `Player: ${p.name} - Level ${p.level} ${p.class} (Spec ${p.spec_index})`,
      );
      parts.push(
        `  Health: ${p.health}/${p.max_health} | ${p.power_type}: ${p.power}/${p.max_power}`,
      );
    }
  }

  if (showAll || section === "target") {
    const t = gs.target;
    if (t) {
      const levelStr = t.level === -1 ? "Boss" : `Level ${t.level}`;
      parts.push(
        `Target: ${t.name} - ${levelStr} ${t.classification} ${t.creature_type || ""}`.trim(),
      );
      parts.push(
        `  Health: ${t.health_pct}%${t.is_dead ? " (Dead)" : ""}${t.is_player ? " (Player)" : ""}`,
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
      parts.push(zoneStr);
      if (z.instance_type && z.instance_type !== "none") {
        parts.push(
          `  Instance: ${z.instance_name} (${z.difficulty_name}, ${z.max_players}-player ${z.instance_type})`,
        );
      }
    }
  }

  if (showAll || section === "party") {
    const party = gs.party;
    if (party && party.length > 0) {
      parts.push(`Party (${party.length} members):`);
      for (const m of party) {
        const role = m.role !== "NONE" ? ` [${m.role}]` : "";
        parts.push(
          `  ${m.name} - Level ${m.level} ${m.class}${role} (${m.health_pct}% HP)`,
        );
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
    }
  }

  return parts.join("\n");
}

export function createGameStateTool(
  getGameState: () => WoWAgentDB | null,
): AgentTool<typeof gameStateSchema> {
  return {
    name: "get_game_state",
    label: "Game State",
    description:
      "Get the player's current World of Warcraft game state including player info, target, zone, party composition, and gear. Data comes from the last /agent sync in-game.",
    parameters: gameStateSchema,
    execute: async (_toolCallId, params) => {
      const db = getGameState();
      const text = formatGameState(db, params.section);
      return {
        content: [{ type: "text", text }],
        details: db?.game_state || null,
      };
    },
  };
}
