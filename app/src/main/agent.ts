import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import type { BrowserWindow } from "electron";
import type { WoWAgentDB, GameState } from "./lua-reader.js";
import { createTools } from "./tools/index.js";

const COMMON_PREAMBLE = `You are WoW Agent, an expert AI assistant for World of Warcraft.

You help players with:
- Boss encounter strategies and mechanics
- Class guides, talent builds, and rotation advice
- Group composition and role assignments
- Gear upgrades and itemization priorities
- Dungeon and raid preparation
- PvP strategies and arena compositions
- Quest guidance and zone navigation

You have access to the player's live game state (player info, current target, zone, party composition, gear level) via the get_game_state tool. This data may be slightly stale - it's updated when the player runs /agent sync in-game, which reloads their UI.

Guidelines:
- Always consider the player's current context (class, level, zone, group) when giving advice
- Be concise but thorough - players are often in the middle of gameplay
- If the game state shows they're in a specific instance, prioritize advice relevant to that content
- When discussing group composition, consider the roles and classes already present in their party
- Use the game state tool proactively when it would help answer the question`;

const VERSION_PROMPTS: Record<string, string> = {
  retail: `
This player is on WoW Retail.
- Current expansion with max level 80
- Reference current raid tier, Mythic+ dungeons, and seasonal content
- Hero Talents and talent trees with loadouts
- Mythic+ affixes and rating system
- Great Vault weekly reward system
- Delves, follower dungeons, and other solo/small-group content
- Modern class design with all specs available`,

  tbc_anniversary: `
This player is on TBC Classic Anniversary Edition (patch 2.5.5).
- Max level 70, dual-spec available (2 specs)
- No Death Knights, no Monks, no Demon Hunters
- Key raids: Karazhan, Gruul's Lair, Magtheridon's Lair, Serpentshrine Cavern, Tempest Keep, Mount Hyjal, Black Temple, Sunwell Plateau
- Heroic dungeons require reputation-based keys; raids have attunement chains
- Arena seasons and resilience gear are core PvP progression
- Reference specific spell names, talent points, and boss abilities by their correct TBC-era names`,

  mop_classic: `
This player is on Mists of Pandaria Classic.
- Max level 90, talent system with tiered choices every 15 levels
- Monk class available (Tank, Healer, DPS)
- Key raids: Mogu'shan Vaults, Heart of Fear, Terrace of Endless Spring, Throne of Thunder, Siege of Orgrimmar
- Challenge Mode dungeons for cosmetic rewards (gold/silver/bronze)
- Valor points for gear upgrades, Lesser Charms for bonus rolls
- Pandaria factions and daily quest hubs for reputation gating
- No flying until appropriate reputation is earned`,

  classic_era: `
This player is on Classic Era (Vanilla WoW).
- Max level 60, no dual-spec
- 40-player raids: Molten Core, Blackwing Lair, Temple of Ahn'Qiraj, Naxxramas
- 20-player raids: Zul'Gurub, Ruins of Ahn'Qiraj
- World buffs (Onyxia, Songflower, DMT, Rend) are critical for raid performance
- No LFG/LFR systems - players form groups manually
- Talent trees with 51-point builds
- Original class design: only certain classes can tank/heal effectively
- Attunement quests for many dungeons and raids`,
};

export function getSystemPrompt(versionId: string): string {
  const versionSection = VERSION_PROMPTS[versionId] || VERSION_PROMPTS.tbc_anniversary;
  return COMMON_PREAMBLE + "\n" + versionSection;
}

export function createAgent(
  mainWindow: BrowserWindow,
  getGameState: () => WoWAgentDB | null,
  versionId: string,
): Agent {
  const modelId = process.env.WOW_AGENT_MODEL || "claude-sonnet-4-5-20250929";
  const [provider, ...rest] = modelId.includes("/")
    ? modelId.split("/")
    : ["anthropic", modelId];
  const model = getModel(
    provider as any,
    (rest.length > 0 ? rest.join("/") : modelId) as any,
  );

  const tools = createTools(getGameState);

  const agent = new Agent({
    initialState: {
      systemPrompt: getSystemPrompt(versionId),
      model,
      thinkingLevel: "off",
      tools,
    },
    getApiKey: async (prov: string) => {
      return getEnvApiKey(prov as any) || undefined;
    },
  });

  // Bridge agent events to the renderer via IPC
  agent.subscribe((event: AgentEvent) => {
    try {
      if (mainWindow.isDestroyed()) return;

      switch (event.type) {
        case "agent_start":
          mainWindow.webContents.send("agent-event", {
            type: "agent_start",
          });
          break;

        case "agent_end":
          mainWindow.webContents.send("agent-event", {
            type: "agent_end",
          });
          break;

        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            mainWindow.webContents.send("agent-event", {
              type: "text_delta",
              delta: ame.delta,
            });
          } else if (ame.type === "text_end") {
            mainWindow.webContents.send("agent-event", {
              type: "text_end",
              content: ame.content,
            });
          }
          break;
        }

        case "message_end":
          if (event.message.role === "assistant") {
            // Extract full text from the assistant message
            const textParts = (event.message.content as any[])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text);
            mainWindow.webContents.send("agent-event", {
              type: "message_end",
              role: "assistant",
              text: textParts.join(""),
            });
          }
          break;

        case "tool_execution_start":
          mainWindow.webContents.send("agent-event", {
            type: "tool_start",
            toolName: event.toolName,
          });
          break;

        case "tool_execution_end":
          mainWindow.webContents.send("agent-event", {
            type: "tool_end",
            toolName: event.toolName,
            isError: event.isError,
          });
          break;
      }
    } catch {
      // Window may have been closed during event processing
    }
  });

  return agent;
}

/**
 * Format game state as context to prepend to user messages.
 */
export function formatGameContext(db: WoWAgentDB | null): string {
  if (!db || !db.game_state) return "";

  const gs = db.game_state;
  const parts: string[] = [];

  if (gs.player) {
    const p = gs.player;
    parts.push(`Player: ${p.name}, Level ${p.level} ${p.class}`);
  }

  if (gs.target) {
    const t = gs.target;
    const lvl = t.level === -1 ? "Boss" : `Level ${t.level}`;
    parts.push(`Target: ${t.name} (${lvl} ${t.classification})`);
  }

  if (gs.zone) {
    const z = gs.zone;
    let zone = z.name;
    if (z.instance_type !== "none") {
      zone = `${z.instance_name} (${z.difficulty_name})`;
    }
    parts.push(`Zone: ${zone}`);
  }

  if (gs.party && gs.party.length > 1) {
    parts.push(`Group: ${gs.party.length} members`);
  }

  if (gs.gear) {
    parts.push(`Avg iLvl: ${gs.gear.avg_ilvl}`);
  }

  if (parts.length === 0) return "";

  const syncAgo = db.last_sync
    ? Math.floor(Date.now() / 1000 - db.last_sync)
    : 0;
  const syncStr =
    syncAgo > 0
      ? `Synced ${Math.floor(syncAgo / 60)}m ${syncAgo % 60}s ago`
      : "Just synced";

  return `<game_context>\n${parts.join(" | ")}\n${syncStr}\n</game_context>`;
}
