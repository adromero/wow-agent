import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { WoWAgentDB } from "../lua-reader";
import { createGameStateTool } from "./game-state";

export function createTools(
  getGameState: () => WoWAgentDB | null,
): AgentTool<any>[] {
  return [createGameStateTool(getGameState)];
}
