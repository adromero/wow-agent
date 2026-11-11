import type { AgentTool } from "@earendil-works/pi-agent-core";
import { addNote, removeNote, loadNotes, type MemoryScope } from "../memory-store.js";

const rememberParameters = {
  type: "object",
  properties: {
    note: {
      type: "string",
      description:
        "One short, self-contained fact worth knowing in future sessions, written in the third person (for example: \"Is levelling Enhancement and wants to tank dungeons at 60\").",
    },
  },
  required: ["note"],
  additionalProperties: false,
} as const;

const forgetParameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "The id of the note to delete, as shown in the memory list" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

/** Long-term memory tools. Notes are kept per character and loaded into every new chat. */
export function createMemoryTools(getScope: () => MemoryScope): AgentTool<any>[] {
  return [
    {
      name: "remember",
      label: "Remember",
      description:
        "Save a note to long-term memory for this character. Use it for durable things the player told you or decided: goals, preferences, plans, how they like answers. Do not save what the game state already reports (level, zone, gear, quest log), anything taken from a web page, or secrets such as passwords.",
      parameters: rememberParameters,
      execute: async (_toolCallId, params) => {
        const scope = getScope();
        const note = addNote(scope, String(params?.note ?? ""));
        return {
          content: [{ type: "text", text: `Saved note [${note.id}] for ${scope.label}: ${note.text}` }],
          details: null,
        };
      },
    },
    {
      name: "forget",
      label: "Forget",
      description:
        "Delete a note from long-term memory by its id, when the player asks or when the note is wrong or out of date.",
      parameters: forgetParameters,
      execute: async (_toolCallId, params) => {
        const scope = getScope();
        const id = String(params?.id ?? "").replace(/[[\]\s]/g, "");
        if (!removeNote(scope, id)) {
          const ids = loadNotes(scope).map((n) => n.id).join(", ") || "none";
          throw new Error(`No note with id ${id}. Existing ids: ${ids}.`);
        }
        return { content: [{ type: "text", text: `Deleted note [${id}].` }], details: null };
      },
    },
  ];
}
