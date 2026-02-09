import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
});

function htmlToText(html: string): string {
  let text = html;

  // Remove non-content tags with their contents
  for (const tag of ["script", "style", "nav", "footer", "noscript", "svg"]) {
    text = text.replace(
      new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
      "",
    );
  }

  // Newlines for block elements
  text = text.replace(
    /<\/?(p|div|br|h[1-6]|li|tr|table|section|article|blockquote|dd|dt|figcaption|figure|hr|main|pre)[^>]*\/?>/gi,
    "\n",
  );

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/&\w+;/g, "");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and return its text content. Use this to look up zones, bosses, items, quests, and other game content on wowhead.com.",
    parameters: webFetchSchema,
    execute: async (_toolCallId, params) => {
      try {
        const response = await fetch(params.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; WoW-Agent/1.0)",
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `HTTP ${response.status}: ${response.statusText}`,
              },
            ],
            details: null,
            isError: true,
          };
        }

        const html = await response.text();
        let text = htmlToText(html);

        const MAX_LENGTH = 20000;
        if (text.length > MAX_LENGTH) {
          text = text.slice(0, MAX_LENGTH) + "\n\n[Content truncated]";
        }

        return {
          content: [{ type: "text", text }],
          details: null,
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Fetch error: ${err.message}` },
          ],
          details: null,
          isError: true,
        };
      }
    },
  };
}
