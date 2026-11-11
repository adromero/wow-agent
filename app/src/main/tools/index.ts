import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WoWAgentDB } from "../lua-reader.js";
import { createGameStateTool } from "./game-state.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createMemoryTools } from "./memory.js";
import type { MemoryScope } from "../memory-store.js";

export function createTools(
  getGameState: () => WoWAgentDB | null,
  getAllowedHosts: () => string[],
  getMemoryScope: () => MemoryScope,
): AgentTool<any>[] {
  return [
    createGameStateTool(getGameState),
    createWebFetchTool(getAllowedHosts),
    ...createMemoryTools(getMemoryScope),
  ];
}
