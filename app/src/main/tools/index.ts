import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WoWAgentDB } from "../lua-reader.js";
import { createGameStateTool } from "./game-state.js";
import { createWebFetchTool } from "./web-fetch.js";

export function createTools(
  getGameState: () => WoWAgentDB | null,
  getAllowedHosts: () => string[],
): AgentTool<any>[] {
  return [createGameStateTool(getGameState), createWebFetchTool(getAllowedHosts)];
}
