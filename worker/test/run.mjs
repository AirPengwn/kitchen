// Offline test of the helper: fakes the Claude API and GitHub, then exercises
// every route the site uses. Nothing real is called. Run: npm test
import assert from "node:assert/strict";
import worker, { titleCase } from "../src/index.js";

const ORIGIN = "https://airpengwn.github.io";
const env = {
  ANTHROPIC_API_KEY: "test-key", GITHUB_TOKEN: "test-token", PASSCODES: JSON.stringify({ erin: "correct horse", mulberry: "blue lantern" }),
  GITHUB_REPO: "AirPengwn/kitchen", GITHUB_BRANCH: "main", ALLOWED_ORIGINS: ORIGIN,
  MODEL: "claude-opus-5-5", EFFORT: "medium",
};

// ---- fake GitHub repo ----
const files = new Map();
let shaN = 0;
const put = (path, text) => files.set(path, { text, sha: `sha${++shaN}` });
put("people/erin.json", JSON.stringify({ id: "erin", name: "Erin", sections: [{ id: "tex-mex", title: "Tex-Mex" }, { id: "soups-stews", title: "Soups & stews" }], box: [] }));
put("people/mulberry.json", JSON.stringify({ id: "mulberry", name: "Mulberry", tags: ["john likes"], sections: [{ id: "dinners", title: "Dinners" }], box: [] }));
put("library/recipes/chili-with-cornbread.json", "{}");

// ---- fake Claude answer ----
const fakeRecipe = {
  isRecipe: true, title: "Chili with cornbread", proteins: ["beef"], slowCooker: false, cozy: true,
  servings: "6 servings", prep: "15 min", cook: "45 min", total: "1 hr",
  equipment: ["5-quart Dutch oven", "Instant-read thermometer"],
  ingredients: [{ group: "", items: ["1 lb ground beef", "1 onion, diced"] }, { group: "Toppings", items: ["½ cup sour cream"] }],
  steps: ["Brown the beef over medium-high heat until it reads 160°F.", "Simmer 30 min."],
  tips: ["Make it a day ahead."], storage: "Fridge up to 4 days.", credit: "Grandma's card",
  note: "A weeknight chili.", suggestedSection: "tex-mex", assumptions: ["Added a safe temperature."],
};
let lastClaudeBody = null, claudeAnswer = fakeRecipe;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || (input.method) || "GET").toUpperCase();
  if (url.startsWith("https://api.anthropic.com/v1/messages")) {
    lastClaudeBody = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
    lastClaudeBody._headers = Object.fromEntries(new Headers(init.headers).entries());
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(claudeAnswer) }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  }
  const m = url.match(/^https:\/\/api\.github\.com\/repos\/AirPengwn\/kitchen\/contents\/([^?]+)/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    const auth = new Headers(init.headers).get("authorization");
    assert.equal(auth, "Bearer test-token");
    if (method === "GET") {
      const f = files.get(path);
      if (!f) return new Response("{}", { status: 404 });
      return Response.json({ sha: f.sha, content: Buffer.from(f.text, "utf8").toString("base64") });
    }
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      const f = files.get(path);
      if (f && body.sha !== f.sha) return new Response("{}", { status: 409 });
      if (!f && body.sha) return new Response("{}", { status: 409 });
      put(path, Buffer.from(body.content, "base64").toString("utf8"));
      files.get(path).b64 = body.content;
      return Response.json({ content: { sha: files.get(path).sha } }, { status: f ? 200 : 201 });
    }
    if (method === "DELETE") {
      const body = JSON.parse(init.body);
      const f = files.get(path);
      if (!f) return new Response("{}", { status: 404 });
      if (body.sha !== f.sha) return new Response("{}", { status: 409 });
      files.delete(path);
      return Response.json({});
    }
  }
  if (url.startsWith("https://recipes.example/")) {
    const page = PAGES[new URL(url).pathname];
    if (!page) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(page.body, { status: page.status || 200, headers: { "content-type": page.type || "text/html; charset=utf-8" } });
  }
  throw new Error("Unexpected fetch " + method + " " + url);
};
// Fake recipe web pages for the "add from a link" tests.
const PAGES = {
  "/ld": { body: `<html><head><title>Tomato Soup | Example Kitchen</title><meta property="og:site_name" content="Example Kitchen">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},{"@type":["Recipe"],"name":"Tomato Soup &amp; Grilled Cheese",
    "author":{"@type":"Person","name":"Pat Cook"},"recipeYield":["4","4 bowls"],"prepTime":"PT10M","cookTime":"PT1H5M",
    "recipeIngredient":["2 Tbsp butter","1 (28-oz) can tomatoes"],
    "recipeInstructions":[{"@type":"HowToSection","name":"Soup","itemListElement":[{"@type":"HowToStep","text":"Melt the butter."},{"@type":"HowToStep","text":"Add tomatoes &amp; simmer 20 min."}]},"Serve hot."]}]}</script>
    </head><body><p>My grandmother's story goes on for pages...</p></body></html>` },
  "/plain": { body: `<html><head><title>Lemon Bars</title><style>.x{}</style></head><body><nav>Home | About</nav>
    <article><h1>Lemon Bars</h1><ul><li>1 cup flour</li><li>2 eggs</li></ul><p>Bake at 350&deg;F for 20 min.</p></article><footer>Copyright</footer>
    <script>var ads = 1;</script></body></html>` },
  "/blocked": { status: 403, body: "no bots" },
  "/photo.jpg": { body: "JFIF", type: "image/jpeg" },
};

const call = (path, body, method = "POST", origin = ORIGIN) =>
  worker.fetch(new Request("https://helper.example" + path, {
    method, headers: { "Content-Type": "application/json", Origin: origin }, body: method === "POST" ? JSON.stringify(body) : undefined,
  }), env);

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok -", name); }

await test("recipe names come out in title case", async () => {
  const cases = {
    "Chicken pot pie soup with biscuits": "Chicken Pot Pie Soup with Biscuits",
    "Burgers, caprese or avocado-bacon": "Burgers, Caprese or Avocado-Bacon",
    "Misir wot (Ethiopian red lentils)": "Misir Wot (Ethiopian Red Lentils)",
    "Turkish eggs (çılbır)": "Turkish Eggs (Çılbır)",
    "tacos al pastor": "Tacos al Pastor",
    "CHICKEN NOODLE SOUP": "Chicken Noodle Soup",
    "nana's mac 'n' cheese": "Nana's Mac 'n' Cheese",
    "BBQ pulled pork": "BBQ Pulled Pork",
    "soup: a love story": "Soup: A Love Story",
    "what to dip it in": "What to Dip It In",
    "slow-cooker birria tacos": "Slow-Cooker Birria Tacos",
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(titleCase(from), to);
});

await test("CORS preflight allows the site and nothing else", async () => {
  const ok = await call("/parse", null, "OPTIONS");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await call("/parse", null, "OPTIONS", "https://evil.example");
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

await test("wrong passcode is refused", async () => {
  const r = await call("/parse", { passcode: "nope", person: "erin", text: "x" });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /passcode/);
});

await test("check route accepts the right passcode", async () => {
  const r = await call("/check", { passcode: "correct horse" });
  assert.equal(r.status, 200);
});

await test("parse sends text + image to Claude with the schema and fallback, returns a clean recipe", async () => {
  const r = await call("/parse", {
    passcode: "correct horse", person: "erin", text: "Chili: 1 lb beef...",
    images: [{ media_type: "image/jpeg", data: "AAAA" }], sections: [{ id: "tex-mex", title: "Tex-Mex" }],
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(lastClaudeBody.model, "claude-opus-5-5");
  assert.equal(lastClaudeBody.fallbacks, "default");
  assert.match(lastClaudeBody._headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(lastClaudeBody.output_config.format.type, "json_schema");
  assert.equal(lastClaudeBody.output_config.effort, "medium");
  assert.equal(lastClaudeBody.messages[0].content[0].type, "image");
  assert.match(lastClaudeBody.messages[0].content[1].text, /tex-mex: Tex-Mex/);
  assert.equal(j.recipe.ingredients[0].group, null);
  assert.equal(j.recipe.ingredients[1].group, "Toppings");
  assert.equal(j.recipe.credit, "Grandma's card");
  assert.equal(j.suggestedSection, "tex-mex");
  assert.deepEqual(j.assumptions, ["Added a safe temperature."]);
});

await test("a correction resends the previous recipe and the fix", async () => {
  const r = await call("/parse", { passcode: "correct horse", person: "erin", previous: { title: "Chili" }, fix: "2 lb beef" });
  assert.equal(r.status, 200);
  assert.match(lastClaudeBody.messages[0].content.at(-1).text, /Correction:\n2 lb beef/);
});

await test("not-a-recipe comes back as a friendly 422", async () => {
  claudeAnswer = { ...fakeRecipe, isRecipe: false, assumptions: ["This is a photo of a dog."] };
  const r = await call("/parse", { passcode: "correct horse", person: "erin", text: "woof" });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, "This is a photo of a dog.");
  claudeAnswer = fakeRecipe;
});

await test("oversized image is rejected before calling Claude", async () => {
  lastClaudeBody = null;
  const r = await call("/parse", { passcode: "correct horse", person: "erin", images: [{ media_type: "image/jpeg", data: "A".repeat(7_000_001) }] });
  assert.equal(r.status, 413);
  assert.equal(lastClaudeBody, null);
});

await test("a recipe link: the page's recipe data goes to Claude, not the story around it", async () => {
  const r = await call("/parse", { passcode: "blue lantern", person: "mulberry", url: "https://recipes.example/ld" });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const p = lastClaudeBody.messages[0].content.at(-1).text;
  assert.match(p, /Recipe from a web page: https:\/\/recipes\.example\/ld \(site: Example Kitchen/);
  assert.match(p, /recipe data the page publishes/);
  assert.match(p, /Name: Tomato Soup & Grilled Cheese/);
  assert.match(p, /Author: Pat Cook/);
  assert.match(p, /Prep: 10 min\nCook: 1 hr 5 min/);
  assert.match(p, /- 1 \(28-oz\) can tomatoes/);
  assert.match(p, /Soup:\n- Melt the butter\.\n- Add tomatoes & simmer 20 min\.\n- Serve hot\./);
  assert.doesNotMatch(p, /grandmother/, "the story around the recipe is left out");
});

await test("a recipe link without recipe data: the page text is used, minus menus, scripts and styles", async () => {
  const r = await call("/parse", { passcode: "blue lantern", person: "mulberry", url: "https://recipes.example/plain" });
  assert.equal(r.status, 200);
  const p = lastClaudeBody.messages[0].content.at(-1).text;
  assert.match(p, /text of the page/);
  assert.match(p, /Lemon Bars\n- 1 cup flour\n- 2 eggs\nBake at 350°F for 20 min\./);
  assert.doesNotMatch(p, /var ads|\.x\{\}|Home \| About|Copyright/);
});

await test("recipe links: private addresses, blocked sites and non-pages get clear refusals", async () => {
  lastClaudeBody = null;
  const parse = (url) => call("/parse", { passcode: "blue lantern", person: "mulberry", url });
  for (const bad of ["http://localhost/x", "http://127.0.0.1/", "https://10.0.0.5/r", "http://[::1]/", "file:///etc/passwd", "https://nas.local/r", "not a link"]) {
    assert.equal((await parse(bad)).status, 400, bad);
  }
  let j = await (await parse("https://recipes.example/blocked")).json();
  assert.match(j.error, /wouldn't let the helper read the page/);
  j = await (await parse("https://recipes.example/missing")).json();
  assert.match(j.error, /didn't load \(error 404\)/);
  j = await (await parse("https://recipes.example/photo.jpg")).json();
  assert.match(j.error, /isn't a web page/);
  assert.equal(lastClaudeBody, null, "Claude is never called for a link that can't be read");
});

await test("a PDF goes to Claude as a document, first, with its name in the prompt", async () => {
  const r = await call("/parse", { passcode: "correct horse", person: "erin", pdf: { name: "Nana's pie.pdf", data: "JVBERi0xLjQK" } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const c = lastClaudeBody.messages[0].content;
  assert.deepEqual(c[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } });
  assert.match(c.at(-1).text, /A PDF \("Nana's pie.pdf"\) with the recipe is attached above/);
});

await test("bad and oversized PDFs are refused before calling Claude", async () => {
  lastClaudeBody = null;
  assert.equal((await call("/parse", { passcode: "correct horse", person: "erin", pdf: { data: "iVBORw0KGgo" } })).status, 400);
  assert.equal((await call("/parse", { passcode: "correct horse", person: "erin", pdf: { data: "JVBER" + "A".repeat(20_000_000) } })).status, 413);
  const big = { media_type: "image/jpeg", data: "A".repeat(6_000_000) };
  assert.equal((await call("/parse", { passcode: "correct horse", person: "erin", images: [big, big], pdf: { data: "JVBER" + "A".repeat(17_000_000) } })).status, 413);
  assert.equal(lastClaudeBody, null);
});

await test("save into the box picks a free id, writes the recipe and updates the person file", async () => {
  const { recipe } = await (await call("/parse", { passcode: "correct horse", person: "erin", text: "chili" })).json();
  const r = await call("/save", { passcode: "correct horse", person: "erin", recipe, box: { mode: "made", section: "soups-stews", blurb: "Cozy.", date: "Oct 19, 2026" } });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.id, "chili-with-cornbread-2"); // the plain id already exists
  const saved = JSON.parse(files.get("library/recipes/chili-with-cornbread-2.json").text);
  assert.equal(saved.id, "chili-with-cornbread-2");
  assert.equal(saved.addedBy, "erin");
  assert.equal(saved.ingredients[1].items[0], "½ cup sour cream");
  const p = JSON.parse(files.get("people/erin.json").text);
  assert.equal(p.box.length, 1);
  assert.deepEqual(p.box[0], { id: "chili-with-cornbread-2", section: "soups-stews", blurb: "Cozy.", note: "", tags: [], made: { count: 1, log: ["Oct 19, 2026"] }, confidence: "clear" });
  assert.deepEqual(j.entry, p.box[0]);
});

await test("library-only save leaves the person file alone", async () => {
  const before = files.get("people/erin.json").sha;
  const r = await call("/save", { passcode: "correct horse", person: "erin", recipe: { ...fakeRecipe, title: "Tomato soup" }, box: { mode: "library" } });
  assert.equal(r.status, 200);
  assert.ok(files.has("library/recipes/tomato-soup.json"));
  assert.equal(files.get("people/erin.json").sha, before);
});

await test("unknown person and incomplete recipes are refused", async () => {
  assert.equal((await call("/save", { passcode: "correct horse", person: "nobody", recipe: fakeRecipe, box: { mode: "new" } })).status, 401);
  assert.equal((await call("/save", { passcode: "correct horse", person: "../etc", recipe: fakeRecipe })).status, 400);
  assert.equal((await call("/save", { passcode: "correct horse", person: "erin", recipe: { title: "x" } })).status, 400);
});

await test("passcodes are per person: Erin's can't change Mulberry's box, but any valid one can read recipes", async () => {
  assert.equal((await call("/box", { passcode: "correct horse", person: "mulberry", id: "chili-with-cornbread", op: "add" })).status, 401);
  assert.equal((await call("/parse", { passcode: "blue lantern", person: "mulberry", text: "chili" })).status, 200);
  const c = await (await call("/check", { passcode: "blue lantern" })).json();
  assert.equal(c.person, "mulberry");
});

await test("box: add, made, undo, tags, note, section, remove", async () => {
  const pass = { passcode: "blue lantern", person: "mulberry", id: "chili-with-cornbread" };
  const box = async (op, extra) => { const r = await call("/box", { ...pass, op, ...extra }); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };
  const mul = () => JSON.parse(files.get("people/mulberry.json").text);
  let j = await box("add", { section: "nope" });
  assert.equal(j.entry.section, "dinners");
  assert.equal(mul().box.length, 1);
  await box("add", { section: "dinners" });
  assert.equal(mul().box.length, 1, "adding twice doesn't duplicate");
  await box("made", { date: "Oct 19, 2026" });
  j = await box("made", { date: "<script>" });
  assert.equal(j.entry.made.count, 2);
  assert.match(j.entry.made.log[1], /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/, "bad dates are replaced");
  j = await box("unmade");
  assert.deepEqual(j.entry.made, { count: 1, log: ["Oct 19, 2026"] });
  j = await box("tags", { tags: ["john likes", "John Likes", " date night ", ""] });
  assert.deepEqual(j.entry.tags, ["john likes", "date night"]);
  await box("note", { note: "Double the garlic." });
  assert.equal(mul().box[0].note, "Double the garlic.");
  assert.equal((await call("/box", { ...pass, op: "section", section: "nope" })).status, 400);
  j = await box("remove");
  assert.equal(j.entry, null);
  assert.equal(mul().box.length, 0);
  assert.ok(files.has("library/recipes/chili-with-cornbread.json"), "removing never touches the library");
  assert.equal((await call("/box", { ...pass, op: "made" })).status, 409);
  assert.equal((await call("/box", { ...pass, id: "not-a-recipe", op: "add" })).status, 400);
  assert.equal((await call("/box", { ...pass, id: "../people/erin", op: "add" })).status, 400);
});

await test("made it before: undated counts, dated slots in by date, undo takes back exactly the last mark", async () => {
  const person = JSON.parse(files.get("people/erin.json").text);
  person.box = [{ id: "chili-with-cornbread", section: "tex-mex", blurb: "", note: "", tags: [], made: { count: 4, log: ["Sep 2, 3 & 4, 2025", "Jan 5, 2026"] }, confidence: "clear" }];
  put("people/erin.json", JSON.stringify(person));
  const box = async (op, extra) => {
    const r = await call("/box", { passcode: "correct horse", person: "erin", id: "chili-with-cornbread", op, ...extra });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j.entry.made;
  };
  let m = await box("madebefore", {});
  assert.equal(m.count, 5); assert.deepEqual(m.log, ["Sep 2, 3 & 4, 2025", "Jan 5, 2026"], "no date: counts, log unchanged");
  m = await box("unmade");
  assert.equal(m.count, 4); assert.deepEqual(m.log, ["Sep 2, 3 & 4, 2025", "Jan 5, 2026"], "undo of an undated mark leaves the dates alone");
  m = await box("madebefore", { date: "2025-11-20" });
  assert.deepEqual(m.log, ["Sep 2, 3 & 4, 2025", "Nov 20, 2025", "Jan 5, 2026"], "a past date goes in date order, so 'last made' stays right");
  m = await box("unmade");
  assert.deepEqual(m.log, ["Sep 2, 3 & 4, 2025", "Jan 5, 2026"]); assert.equal(m.count, 4);
  m = await box("made", { date: "Oct 19, 2026" });
  m = await box("unmade");
  assert.deepEqual(m, { count: 4, log: ["Sep 2, 3 & 4, 2025", "Jan 5, 2026"] }, "Made it today still undoes as before");
  m = await box("unmade"); // no record of the last mark any more: falls back to dropping the newest date
  assert.deepEqual(m, { count: 3, log: ["Sep 2, 3 & 4, 2025"] });
  for (const date of ["2099-01-01", "2025-02-30", "yesterday", "1900-01-01"]) {
    const r = await call("/box", { passcode: "correct horse", person: "erin", id: "chili-with-cornbread", op: "madebefore", date });
    assert.equal(r.status, 400, date);
  }
});

await test("a new recipe can go in the box as made before (no date)", async () => {
  const r = await call("/save", { passcode: "correct horse", person: "erin", recipe: { ...fakeRecipe, title: "Old Favorite Soup" }, box: { mode: "madebefore", section: "soups-stews" } });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual(j.entry.made, { count: 1, log: [] });
});

await test("photos: add, replace (old file deleted), remove; checks and passcodes", async () => {
  put("library/recipes/beef-stew.json", JSON.stringify({ id: "beef-stew", title: "Beef Stew", photo: null }, null, 1));
  const jpeg = "/9j/4AAQSkZJRgABAQ";
  const photo = async (extra, passcode = "blue lantern", person = "mulberry") => {
    const r = await call("/photo", { passcode, person, id: "beef-stew", ...extra });
    return { status: r.status, j: await r.json() };
  };
  const recipe = () => JSON.parse(files.get("library/recipes/beef-stew.json").text);

  let { status, j } = await photo({ image: { media_type: "image/jpeg", data: jpeg } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.match(j.photo, /^library\/photos\/beef-stew-[a-z0-9]+\.jpg$/);
  assert.equal(recipe().photo, j.photo);
  assert.equal(files.get(j.photo).b64, jpeg, "the JPEG is stored exactly as sent");
  assert.equal(recipe().title, "Beef Stew", "nothing else in the recipe changes");
  const first = j.photo;

  await new Promise((r) => setTimeout(r, 5)); // a new timestamp, so a new file name
  ({ status, j } = await photo({ image: { media_type: "image/jpeg", data: jpeg + "AA" } }));
  assert.equal(status, 200);
  assert.notEqual(j.photo, first);
  assert.ok(!files.has(first), "the replaced photo is deleted");
  assert.ok(files.has(j.photo));
  const second = j.photo;

  ({ status, j } = await photo({ image: null }));
  assert.equal(status, 200);
  assert.equal(j.photo, null);
  assert.equal(recipe().photo, null);
  assert.ok(!files.has(second), "a removed photo is deleted");

  assert.equal((await photo({ image: { media_type: "image/png", data: "iVBORw0KGgo" } })).status, 400);
  assert.equal((await photo({ image: { media_type: "image/jpeg", data: "/9j/" + "A".repeat(4_000_000) } })).status, 413);
  assert.equal((await call("/photo", { passcode: "blue lantern", person: "mulberry", id: "no-such-recipe", image: null })).status, 400);
  assert.equal((await call("/photo", { passcode: "blue lantern", person: "mulberry", id: "../people/erin", image: null })).status, 400);
  assert.equal((await photo({ image: null }, "correct horse", "mulberry")).status, 401, "Erin's passcode can't act as Mulberry");
  assert.equal((await photo({ image: null }, "correct horse", "erin")).status, 200, "either kitchen can change a library photo");
});

await test("editing a recipe: fields change, id/photo/addedBy stay, bad edits refused", async () => {
  put("library/recipes/taco-night.json", JSON.stringify({ id: "taco-night", title: "Taco Night", proteins: ["beef"], slowCooker: false, cozy: false,
    servings: "4 servings", prep: "10 min", cook: "15 min", total: "25 min", equipment: ["12-inch skillet"],
    ingredients: [{ group: null, items: ["1 lb ground beef"] }], steps: ["Brown the beef until it reads 160°F."], tips: [], storage: "Fridge 3 days.",
    credit: "Anne", photo: "library/photos/taco-night-abc.jpg", addedBy: "erin", addedAt: "2026-10-01" }, null, 1) + "\n");
  const edit = (recipe, passcode = "blue lantern", person = "mulberry") => call("/edit", { passcode, person, id: "taco-night", recipe });
  const read = () => JSON.parse(files.get("library/recipes/taco-night.json").text);
  const base = read();

  let r = await edit({ ...base, title: "taco night with pickled onions", servings: "6 servings", tips: ["Warm the tortillas."], id: "hacked", photo: null, addedBy: "mulberry" });
  let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.changed, true);
  const now = read();
  assert.equal(now.id, "taco-night", "the id never changes");
  assert.equal(now.title, "Taco Night with Pickled Onions", "titles still get title case");
  assert.equal(now.servings, "6 servings");
  assert.deepEqual(now.tips, ["Warm the tortillas."]);
  assert.equal(now.photo, "library/photos/taco-night-abc.jpg", "the photo can't be changed through an edit");
  assert.equal(now.addedBy, "erin");
  assert.equal(now.addedAt, "2026-10-01");
  assert.ok(!files.has("library/recipes/hacked.json"));

  const sha = files.get("library/recipes/taco-night.json").sha;
  j = await (await edit(now)).json();
  assert.equal(j.changed, false, "saving with no changes doesn't commit");
  assert.equal(files.get("library/recipes/taco-night.json").sha, sha);

  assert.equal((await edit({ ...now, steps: [] })).status, 400, "a recipe needs steps");
  assert.equal((await edit({ ...now, title: "" })).status, 400);
  assert.equal((await edit(now, "correct horse", "mulberry")).status, 401, "Erin's passcode can't act as Mulberry");
  assert.equal((await call("/edit", { passcode: "blue lantern", person: "mulberry", id: "nope-nope", recipe: now })).status, 400);
  assert.equal((await call("/edit", { passcode: "blue lantern", person: "mulberry", id: "../people/erin", recipe: now })).status, 400);
});

await test("nutrition: Claude's estimate is checked, rounded and saved with the recipe; edits clear it when it goes stale", async () => {
  put("library/recipes/chili-pot.json", JSON.stringify({ id: "chili-pot", title: "Chili Pot", proteins: ["beef"], slowCooker: false, cozy: true,
    servings: "4–6 servings", prep: "10 min", cook: "1 hr", total: "1 hr 10 min", equipment: ["Pot"],
    ingredients: [{ group: null, items: ["1 lb ground beef", "1 can beans, drained"] }, { group: "To serve", items: ["½ cup sour cream"] }],
    steps: ["Brown the beef until it reads 160°F.", "Simmer 45 min."], tips: [], storage: "Fridge 4 days.",
    credit: null, photo: "library/photos/chili-pot-a.jpg", addedBy: "mulberry", addedAt: "2026-10-20" }, null, 1) + "\n");
  claudeAnswer = { servings: 5, calories: 412.6, protein_g: 27.44, carbs_g: 18.2, fat_g: 24.06, saturated_fat_g: 9.84, fiber_g: 5.06, sugar_g: 3.3, sodium_mg: 612.4,
    assumptions: ["Used 5 servings, the middle of 4–6."] };
  const r = await call("/nutrition", { passcode: "blue lantern", person: "mulberry", id: "chili-pot" });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(lastClaudeBody.output_config.format.schema.required.includes("sodium_mg"), true);
  assert.match(lastClaudeBody.messages[0].content[0].text, /To serve:\n- ½ cup sour cream/);
  assert.match(lastClaudeBody.messages[0].content[0].text, /Servings: 4–6 servings/);
  assert.deepEqual(j.nutrition.perServing, { calories: 413, protein_g: 27, carbs_g: 18, fat_g: 24, saturated_fat_g: 9.8, fiber_g: 5.1, sugar_g: 3.3, sodium_mg: 612 });
  assert.equal(j.nutrition.servings, 5);
  const saved = JSON.parse(files.get("library/recipes/chili-pot.json").text);
  assert.deepEqual(saved.nutrition, j.nutrition);
  assert.equal(saved.photo, "library/photos/chili-pot-a.jpg", "nothing else in the recipe changes");

  // a title-only edit keeps the estimate; changing an ingredient clears it
  let e = await (await call("/edit", { passcode: "blue lantern", person: "mulberry", id: "chili-pot", recipe: { ...saved, title: "Chili Pot Supreme" } })).json();
  assert.deepEqual(e.recipe.nutrition, j.nutrition);
  const items = saved.ingredients.map((g) => ({ ...g, items: g.items.slice() })); items[0].items[0] = "2 lb ground beef";
  e = await (await call("/edit", { passcode: "blue lantern", person: "mulberry", id: "chili-pot", recipe: { ...saved, ingredients: items } })).json();
  assert.equal(e.recipe.nutrition, null);

  claudeAnswer = { ...claudeAnswer, calories: -5 };
  assert.equal((await call("/nutrition", { passcode: "blue lantern", person: "mulberry", id: "chili-pot" })).status, 502, "nonsense numbers are refused");
  assert.equal(JSON.parse(files.get("library/recipes/chili-pot.json").text).nutrition, null);
  assert.equal((await call("/nutrition", { passcode: "correct horse", person: "mulberry", id: "chili-pot" })).status, 401);
  assert.equal((await call("/nutrition", { passcode: "blue lantern", person: "mulberry", id: "no-such" })).status, 400);
  claudeAnswer = fakeRecipe;
});

await test("new recipes are saved with an empty photo field", async () => {
  const r = await call("/save", { passcode: "correct horse", person: "erin", recipe: { ...fakeRecipe, title: "Plain Rice" }, box: { mode: "library" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(files.get("library/recipes/plain-rice.json").text).photo, null);
});

console.log(`\n${passed} tests passed.`);
