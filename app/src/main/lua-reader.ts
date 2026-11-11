import * as fs from "fs";
import * as luaparse from "luaparse";

type LuaNode = luaparse.Node;

/**
 * Convert a luaparse AST node to a JavaScript value.
 */
function luaAstToJS(node: LuaNode): any {
  switch (node.type) {
    case "StringLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
      return (node as any).value;

    case "NilLiteral":
      return null;

    case "UnaryExpression": {
      const unary = node as any;
      if (unary.operator === "-") {
        return -luaAstToJS(unary.argument);
      }
      if (unary.operator === "not") {
        return !luaAstToJS(unary.argument);
      }
      if (unary.operator === "#") {
        return 0; // length operator - not meaningful in static parse
      }
      return null;
    }

    case "TableConstructorExpression":
      return convertTable(node as any);

    default:
      return null;
  }
}

/**
 * Convert a TableConstructorExpression to a JS object or array.
 */
function convertTable(node: any): any {
  const fields = node.fields;

  if (!fields || fields.length === 0) {
    return {};
  }

  // If all fields are positional (TableValue), treat as array
  const allPositional = fields.every((f: any) => f.type === "TableValue");
  if (allPositional) {
    return fields.map((f: any) => luaAstToJS(f.value));
  }

  const result: Record<string, any> = Object.create(null);
  let implicitIndex = 1;

  for (const field of fields) {
    if (field.type === "TableKey") {
      const key = luaAstToJS(field.key);
      result[key] = luaAstToJS(field.value);
    } else if (field.type === "TableKeyString") {
      const key = field.key.name;
      result[key] = luaAstToJS(field.value);
    } else if (field.type === "TableValue") {
      result[implicitIndex] = luaAstToJS(field.value);
      implicitIndex++;
    }
  }

  return result;
}

export interface WoWAgentDB {
  version: number;
  last_sync: number;
  game_state: GameState;
}

export interface GameState {
  player?: PlayerState;
  target?: TargetState | null;
  zone?: ZoneState;
  party?: PartyMember[];
  gear?: GearState;
  professions?: Profession[];
  bags?: BagState;
  quests?: Quest[];
  client?: ClientInfo;
  /** Sections the addon failed to collect, with the Lua error text. */
  errors?: Record<string, string>;
}

export interface TalentTree {
  name: string;
  points: number;
}

export interface PlayerState {
  name: string;
  realm?: string;
  level: number;
  class: string;
  race?: string;
  faction?: string;
  spec_index?: number;
  spec_name?: string;
  spec_role?: string;
  talent_trees?: TalentTree[];
  health: number;
  max_health: number;
  power: number;
  max_power: number;
  power_type: string;
  xp?: number;
  xp_max?: number;
  xp_rested?: number;
  money_copper?: number;
  hearthstone?: string;
  is_dead_or_ghost?: boolean;
  map_id?: number;
  map_x?: number;
  map_y?: number;
}

export interface TargetState {
  name: string;
  realm?: string;
  level: number;
  classification: string;
  creature_type?: string;
  class?: string;
  reaction?: number;
  health_pct?: number;
  is_player: boolean;
  is_dead: boolean;
}

export interface ZoneState {
  name: string;
  subzone: string;
  instance_name: string;
  instance_type: string;
  difficulty_id: number;
  difficulty_name: string;
  max_players: number;
}

export interface PartyMember {
  name: string;
  class: string;
  level: number;
  role?: string;
  health_pct?: number;
}

export interface GearItem {
  slot: string;
  name?: string;
  item_id?: number;
  ilvl?: number;
  quality?: number;
  durability?: number;
  max_durability?: number;
}

export interface GearState {
  avg_ilvl: number;
  slot_count: number;
  items?: GearItem[];
}

export interface Profession {
  name: string;
  rank?: number;
  max_rank?: number;
  category?: string;
}

export interface BagState {
  free_slots: number;
  total_slots: number;
}

export interface QuestObjective {
  text?: string;
  done: boolean;
  have?: number;
  need?: number;
}

export interface Quest {
  id?: number;
  title: string;
  level?: number;
  category?: string;
  status: "in_progress" | "complete" | "failed";
  suggested_group?: number;
  is_daily?: boolean;
  objectives?: QuestObjective[];
}

export interface ClientInfo {
  version?: string;
  build?: string;
  interface?: number;
  locale?: string;
}

/** An empty Lua table parses as {}; treat anything that is not an array as an empty list. */
export function asArray<T>(value: T[] | undefined | null | object): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Parse a WoW SavedVariables Lua file and extract all top-level variables.
 */
export function parseSavedVariables(
  luaCode: string,
): Record<string, any> {
  const ast = luaparse.parse(luaCode, {
    comments: false,
    encodingMode: "pseudo-latin1",
    luaVersion: "5.1",
  });

  const variables: Record<string, any> = Object.create(null);

  for (const statement of (ast as any).body) {
    if (statement.type === "AssignmentStatement") {
      const varNode = statement.variables[0];
      if (varNode && varNode.type === "Identifier") {
        const varName = varNode.name;
        const value = statement.init[0];
        if (value) {
          variables[varName] = luaAstToJS(value);
        }
      }
    }
  }

  return variables;
}

/**
 * Read and parse the WoWAgent SavedVariables file.
 */
export function readGameState(filePath: string): WoWAgentDB | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) return null;

    const variables = parseSavedVariables(content);
    const db = variables["WoWAgentDB"];
    if (!db) return null;

    return db as WoWAgentDB;
  } catch (err) {
    console.error("[lua-reader] Failed to parse SavedVariables:", err);
    return null;
  }
}
