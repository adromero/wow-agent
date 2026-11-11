import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWowheadLists, formatWowheadData } from "../dist/main/tools/wowhead.js";

// Both ways Wowhead embeds table data: a JSON <script> referenced by id
// (search pages) and an inline array (entity pages).
const HTML = `
<script type="application/json" id="data.guid-zones">[{"category":1,"id":17,"maxlevel":33,"minlevel":10,"name":"The Barrens"}]</script>
<script type="application/json" id="data.guid-guides">[{"id":34961,"name":"Wailing Caverns Guide","categoryNames":["Dungeons"],"url":"https://www.wowhead.com/forever/guide/wailing-caverns"},{"id":2,"name":"Elsewhere","url":"https://evil.example/x"}]</script>
<script>
new Listview({
    template: "zone",
    id: "zones",
    name: "Zones",
    data: WH.getPageData("guid-zones"),
});
new Listview({template: 'quest', id: 'quests', name: WH.TERMS.quests, note: "<a href=\\"\\/x\\">Filter<\\/a>", data: [{"id":886,"level":10,"name":"The Barrens Oases","reqlevel":10,"side":2},{"id":870,"level":13,"name":"A \\"quoted\\" ] name","reqlevel":9,"side":2,"description":"<b>Explore</b> the pools"}]});
new Listview({template: "guide", id: "guides", data: WH.getPageData("guid-guides")});
new Listview({template: "npc", id: "broken", data: [{"id":1,"name":"Unclosed"});
new Listview({template: "npc", id: "missing", data: WH.getPageData("nope")});
</script>`;

test("tables are read from both embedded forms; broken or missing data is skipped", () => {
  const lists = extractWowheadLists(HTML);
  assert.deepEqual(lists.map((l) => [l.label, l.rows.length]), [
    ["zones", 1],
    ["quests", 2],
    ["guides", 2],
  ]);
});

test("rows become text with levels, sides and version-correct links", () => {
  const text = formatWowheadData(HTML, "https://www.wowhead.com/forever/search?q=Barrens");
  assert.match(text, /zones:\n- The Barrens \(level 10-33\) https:\/\/www\.wowhead\.com\/forever\/zone=17/);
  assert.match(text, /- The Barrens Oases \(level 10, Horde\) https:\/\/www\.wowhead\.com\/forever\/quest=886/);
  assert.match(text, /- A "quoted" \] name \(level 13, requires level 9, Horde, Explore the pools\) .*quest=870/);
  assert.match(text, /- Wailing Caverns Guide \(Dungeons\) https:\/\/www\.wowhead\.com\/forever\/guide\/wailing-caverns/);
  // A row URL pointing off wowhead is not passed on.
  assert.ok(!text.includes("evil.example"));
  assert.match(text, /- Elsewhere\n?/);
});

test("pages without tables add nothing", () => {
  assert.equal(formatWowheadData("<html><body>plain</body></html>", "https://www.wowhead.com/forever"), "");
});

test("guide markup becomes readable text with entity names filled in", async () => {
  const { formatWowheadGuide } = await import("../dist/main/tools/wowhead.js");
  const body =
    '[h2 type=bar toc="Overview"]Wailing Caverns Overview[/h2]\r\n[b]Level[/b]: 17-24\r\n[ul][li][npc=3654] drops [item=6461][/li][li]See [url=/forever/zone=17]The "Barrens"[/url][/li][/ul]\r\n[table][tr][td]Quest Item[/td] [td][item=10441][/td][/tr][/table][img src=x.jpg]';
  const html =
    `<script>WH.Gatherer.addData(1, 16, {"3654":{"name_enus":"Mutanus the Devourer","model":1}});WH.Gatherer.addData(3, 16, {"6461":{"name_enus":"Slime-encrusted Pads"}});</script>` +
    `<script>WH.markup.printHtml(${JSON.stringify("[b]sidebar[/b]")}, "interior-sidebar-related-markup", {});</script>` +
    `<script>WH.markup.printHtml(${JSON.stringify(body)}, "guide-body", {"allow":30});</script>`;
  const text = formatWowheadGuide(html);
  assert.match(text, /## Wailing Caverns Overview/);
  assert.match(text, /Level: 17-24/);
  assert.match(text, /- Mutanus the Devourer drops Slime-encrusted Pads/);
  assert.match(text, /- See The "Barrens"/);
  assert.match(text, /Quest Item \| item #10441/);
  const bodyText = text.replace("[Guide text]", "");
  assert.ok(!bodyText.includes("[") && !bodyText.includes("sidebar"), bodyText);
  assert.equal(formatWowheadGuide("<html>no guide</html>"), "");
});
