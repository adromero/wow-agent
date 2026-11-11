/**
 * Wowhead renders its result tables (search results, the quests/NPCs/items
 * tabs on a zone page, guide lists) in the browser from JSON embedded in the
 * page. Stripping the HTML tags loses all of it, so this module reads that
 * JSON as data (it is parsed, never executed) and turns it into plain text.
 */

const MAX_ROWS_PER_LIST = 25;
const MAX_LISTS = 12;
const MAX_FIELD_LENGTH = 160;

/** Wowhead URL prefixes for the different game versions. */
const VERSION_PREFIXES = new Set([
  "forever", "classic", "tbc", "wotlk", "cata", "mop", "mop-classic", "ptr", "beta",
]);

/** Listview templates that link to a database entity as /<template>=<id>. */
const ENTITY_TEMPLATES = new Set([
  "zone", "quest", "npc", "item", "object", "spell", "achievement", "itemset", "faction",
]);

const SIDES: Record<number, string> = { 1: "Alliance", 2: "Horde" };
const QUALITIES = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary"];

type Row = Record<string, unknown>;

export interface WowheadList {
  label: string;
  template: string;
  rows: Row[];
}

/** Scan forward from an opening bracket to its matching close, respecting JSON strings. */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseRows(json: string | null | undefined): Row[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((r) => r && typeof r === "object" && !Array.isArray(r))
      : [];
  } catch {
    return [];
  }
}

/** Find the result tables embedded in a Wowhead page. */
export function extractWowheadLists(html: string): WowheadList[] {
  // <script type="application/json" id="data.KEY">[...]</script>
  const pageData = new Map<string, string>();
  const dataScript = /<script type="application\/json" id="data\.([^"]+)">([\s\S]*?)<\/script>/g;
  for (let m = dataScript.exec(html); m; m = dataScript.exec(html)) {
    pageData.set(m[1], m[2]);
  }

  const lists: WowheadList[] = [];
  const listview = /new Listview\(\{/g;
  for (let m = listview.exec(html); m && lists.length < MAX_LISTS; m = listview.exec(html)) {
    // The options object is JavaScript, not JSON, so pick out the few fields needed.
    const head = html.slice(m.index, m.index + 600);
    const template = head.match(/template:\s*["']([\w-]+)["']/)?.[1];
    const id = head.match(/[{,\s]id:\s*["']([\w-]+)["']/)?.[1];
    if (!template || !id) continue;

    const dataAt = html.indexOf("data:", m.index);
    if (dataAt === -1 || dataAt - m.index > 4000) continue;
    const afterData = html.slice(dataAt + 5, dataAt + 200).trimStart();

    let rows: Row[] = [];
    const ref = afterData.match(/^WH\.getPageData\("([^"]+)"\)/);
    if (ref) {
      rows = parseRows(pageData.get(ref[1]));
    } else if (afterData.startsWith("[")) {
      rows = parseRows(sliceBalanced(html, html.indexOf("[", dataAt)));
    }
    if (rows.length > 0) lists.push({ label: id, template, rows });
  }
  return lists;
}

function clip(value: unknown): string {
  const text = String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > MAX_FIELD_LENGTH ? text.slice(0, MAX_FIELD_LENGTH) + "..." : text;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatRow(row: Row, template: string, urlBase: string): string | null {
  const name = row.displayName ?? row.name ?? row.title;
  if (typeof name !== "string" || !name.trim()) return null;

  const details: string[] = [];
  const min = num(row.minlevel);
  const max = num(row.maxlevel);
  const level = num(row.level);
  const reqLevel = num(row.reqlevel);

  if (min !== undefined && max !== undefined && max > 0) {
    details.push(min === max ? `level ${min}` : `level ${min}-${max}`);
  } else if (level !== undefined && level > 0) {
    details.push(template === "item" ? `item level ${level}` : `level ${level}`);
  }
  if (reqLevel !== undefined && reqLevel > 0 && reqLevel !== level) {
    details.push(`requires level ${reqLevel}`);
  }
  if (template === "item" && num(row.quality) !== undefined) {
    const quality = QUALITIES[num(row.quality)!];
    if (quality) details.push(quality);
  }
  const side = SIDES[num(row.side) ?? 0];
  if (side) details.push(side);
  if (typeof row.description === "string" && row.description.trim()) {
    details.push(clip(row.description));
  }
  if (Array.isArray(row.categoryNames) && row.categoryNames.length > 0) {
    details.push(clip(row.categoryNames.join("/")));
  }

  let url = "";
  const id = num(row.id);
  if (typeof row.url === "string" && /^https:\/\/[\w.-]*wowhead\.com\//.test(row.url)) {
    url = row.url;
  } else if (ENTITY_TEMPLATES.has(template) && id !== undefined) {
    url = `${urlBase}/${template}=${id}`;
  }

  return `- ${clip(name)}${details.length ? ` (${details.join(", ")})` : ""}${url ? ` ${url}` : ""}`;
}

/**
 * Text rendering of the tables embedded in a Wowhead page, or "" if there are none.
 * `pageUrl` decides which game version the entity links point at.
 */
export function formatWowheadData(html: string, pageUrl: string): string {
  const lists = extractWowheadLists(html);
  if (lists.length === 0) return "";

  const url = new URL(pageUrl);
  const firstSegment = url.pathname.split("/")[1] || "";
  const urlBase = url.origin + (VERSION_PREFIXES.has(firstSegment) ? `/${firstSegment}` : "");

  const sections: string[] = [];
  for (const list of lists) {
    const lines: string[] = [];
    for (const row of list.rows) {
      if (lines.length >= MAX_ROWS_PER_LIST) break;
      const line = formatRow(row, list.template, urlBase);
      if (line) lines.push(line);
    }
    if (lines.length === 0) continue;
    const more = list.rows.length > lines.length ? ` (first ${lines.length} of ${list.rows.length})` : "";
    sections.push(`${list.label}${more}:\n${lines.join("\n")}`);
  }
  return sections.length > 0
    ? `[Tables embedded in the page]\n\n${sections.join("\n\n")}`
    : "";
}

export function isWowheadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "wowhead.com" || host.endsWith(".wowhead.com");
}

// --- Guide bodies ---

/** Wowhead entity type numbers used by WH.Gatherer.addData, by markup tag name. */
const GATHERER_TYPES: Record<string, number> = {
  npc: 1, object: 2, item: 3, itemset: 4, quest: 5, spell: 6, zone: 7, faction: 8, achievement: 10,
};

/** Read a JSON string literal starting at the opening quote; returns the decoded string and where it ends. */
function readJsonString(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') {
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        return typeof value === "string" ? { value, end: i + 1 } : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Names for the [npc=123]-style references in a guide, from the page's WH.Gatherer.addData calls. */
function readEntityNames(html: string): Map<string, string> {
  const names = new Map<string, string>();
  const call = /WH\.Gatherer\.addData\((\d+),\s*\d+,\s*/g;
  for (let m = call.exec(html); m; m = call.exec(html)) {
    const at = m.index + m[0].length;
    if (html[at] !== "{") continue;
    const json = sliceBalanced(html, at);
    if (!json) continue;
    try {
      const entries = JSON.parse(json) as Record<string, { name_enus?: unknown }>;
      for (const [id, entry] of Object.entries(entries)) {
        if (entry && typeof entry.name_enus === "string") {
          names.set(`${m[1]}:${id}`, entry.name_enus);
        }
      }
    } catch {
      // Not plain JSON; skip
    }
  }
  return names;
}

/** Convert Wowhead's bracket markup to plain text. */
export function markupToText(markup: string, names: Map<string, string> = new Map()): string {
  let text = markup.replace(/\r/g, "");

  // Entity references: [npc=3419], [item=6461 ...]
  text = text.replace(/\[(npc|object|item|itemset|quest|spell|zone|faction|achievement)=(\d+)[^\]]*\]/g, (_m, tag, id) => {
    return names.get(`${GATHERER_TYPES[tag]}:${id}`) ?? `${tag} #${id}`;
  });

  text = text
    .replace(/\[h[1-6][^\]]*\]/g, "\n\n## ")
    .replace(/\[\/h[1-6]\]/g, "\n")
    .replace(/\[li[^\]]*\]/g, "\n- ")
    .replace(/\[\/?(tr|ul|ol|table|tabs|box|center|pad|br|hr|div|section)[^\]]*\]/g, "\n")
    .replace(/\[tab\s+name=(?:"([^"]*)"|([^\]\s]*))[^\]]*\]/g, (_m, a, b) => `\n\n### ${a ?? b}\n`)
    .replace(/\[\/td\]/g, " | ")
    .replace(/\[(img|screenshot|video|youtube|icon|map|pin|model|minibox|toc|ad)[^\]]*\](?:[^\[]*\[\/\1\])?/g, "")
    .replace(/\[\/?[a-z][a-z0-9]*(?:[ =][^\]]*)?\]/gi, ""); // every remaining tag, keeping its inner text

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\| ?\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body text of a Wowhead guide page, or "" if the page is not a guide. */
export function formatWowheadGuide(html: string): string {
  const call = /WH\.markup\.printHtml\(\s*/g;
  for (let m = call.exec(html); m; m = call.exec(html)) {
    const at = m.index + m[0].length;
    const body = readJsonString(html, at);
    if (!body) continue;
    // Only the guide body, not sidebars: the target element id is the next argument.
    if (!/^\s*,\s*"guide-body"/.test(html.slice(body.end, body.end + 40))) continue;
    const text = markupToText(body.value, readEntityNames(html));
    return text ? `[Guide text]\n\n${text}` : "";
  }
  return "";
}
