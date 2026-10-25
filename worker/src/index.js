// Kitchen helper: a small Cloudflare Worker behind the "Add a recipe" button.
//   POST /check  { passcode }                       -> { ok, person }
//   POST /parse  { passcode, person, text, images, pdf?: { name, data }, url?, sections, previous?, fix? }
//                -> { recipe, note, suggestedSection, assumptions }
//   POST /save   { passcode, person, recipe, box: { mode, section, blurb, date } }
//                -> { id, recipe, entry }
//   POST /box    { passcode, person, id, op: add|remove|made|unmade|tags|note|section, ... }
//                -> { entry, updated }
//   POST /edit   { passcode, person, id, recipe } -> { id, recipe, changed }   (id, photo and who added it stay)
//   POST /nutrition { passcode, person, id } -> { id, nutrition }   (Claude's per-serving estimate, saved with the recipe)
//   POST /photo  { passcode, person, id, image: { media_type: "image/jpeg", data } | null }
//                -> { id, photo }   (null image removes the photo)
// Secrets (never in the page): ANTHROPIC_API_KEY, GITHUB_TOKEN,
// PASSCODES (JSON, one passcode per person: {"erin": "...", "mulberry": "..."}).
// Settings in wrangler.toml: GITHUB_REPO, GITHUB_BRANCH, ALLOWED_ORIGINS, MODEL, EFFORT.
import Anthropic from "@anthropic-ai/sdk";

const PROTEINS = ["chicken", "beef", "pork", "seafood", "eggs", "meatless"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 7_000_000; // about 5 MB per image
const MAX_PDF_B64 = 20_000_000; // about 15 MB
const MAX_TOTAL_B64 = 28_000_000; // keeps the whole Claude request under its 32 MB limit
const MAX_TEXT = 30_000;

const STR_ARRAY = { type: "array", items: { type: "string" } };
const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isRecipe", "title", "proteins", "slowCooker", "cozy", "servings", "prep", "cook", "total",
    "equipment", "ingredients", "steps", "tips", "storage", "credit", "note", "suggestedSection", "assumptions"],
  properties: {
    isRecipe: { type: "boolean" },
    title: { type: "string" },
    proteins: { type: "array", items: { type: "string", enum: PROTEINS } },
    slowCooker: { type: "boolean" },
    cozy: { type: "boolean" },
    servings: { type: "string" },
    prep: { type: "string" },
    cook: { type: "string" },
    total: { type: "string" },
    equipment: STR_ARRAY,
    ingredients: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["group", "items"],
        properties: { group: { type: "string" }, items: STR_ARRAY },
      },
    },
    steps: STR_ARRAY,
    tips: STR_ARRAY,
    storage: { type: "string" },
    credit: { type: "string" },
    note: { type: "string" },
    suggestedSection: { type: "string" },
    assumptions: STR_ARRAY,
  },
};

const SYSTEM = `You turn recipes into the house format for a family recipe website. The cook follows these recipes on a phone while cooking, so every recipe must be complete enough to cook from without guessing.

You get a recipe as pasted text, screenshots/photos, a PDF, or a mix. Read all of it. A PDF may hold text, scanned pages, or both, and may contain more than one recipe or unrelated pages: use the recipe the cook means (the pasted text may say which; otherwise the first complete recipe), and if there were others, say in assumptions which one you used. If it is not a recipe, set isRecipe to false, leave the other text fields empty, and put one sentence in assumptions saying what you saw instead.

Stay faithful to the source: same dish, same ingredients and amounts, same method. Write every step in your own words; never copy the source's sentences. Then fill in what the source leaves out, using standard technique, and list each thing you added or changed in "assumptions" as one short sentence (for example "Added an oven temperature of 425°F; the source didn't give one."). If the source is unreadable in places, say so in assumptions rather than inventing amounts.

Fields:
- title: the dish name, short, in title case (like "Chicken Pot Pie Soup with Biscuits" or "Tacos al Pastor").
- proteins: any of chicken, beef, pork, seafood, eggs, meatless (meatless means no meat or fish; a dish can have several, like eggs and meatless).
- slowCooker: true only if the main method is a slow cooker or crockpot.
- cozy: true for warm, hearty dishes suited to cold days (soups, stews, chili, bakes, braises, pastas in rich sauces, warm baked goods).
- servings: like "4 servings", "12 muffins", "1 pie (8 slices)".
- prep, cook, total: like "15 min", "1 hr 10 min", "8 hr on low". total includes resting, rising, chilling and slow cooking.
- equipment: 2 to 6 items with sizes ("12-inch skillet", "9×13-inch baking dish", "6-quart slow cooker"). Include "Instant-read thermometer" when meat, poultry or fish needs a safe temperature.
- ingredients: groups. The first group's name is "" (empty). Later groups are named parts like "Sauce", "Dough", "Toppings", "To serve". Every item has an amount, a unit and its prep, like "1 medium yellow onion, diced" or "1½ lb boneless skinless chicken thighs, cut into 1-inch pieces". Only seasonings may be "to taste". Use US units and the characters ½ ¼ ¾ ⅓ ⅔ ⅛.
- steps: 4 to 9 steps, plain text, imperative. Each includes, where it applies: the heat level ("over medium-high heat") and pan, oven temperature in °F, time ranges plus a visual or texture cue, safe internal temperatures, and resting time. Start with a preheat step when the oven is used. Every ingredient used in a step must be listed, and every listed ingredient must be used.
- tips: 1 to 3 short tips (swaps, make-ahead, a common mistake).
- storage: fridge and freezer time and how to reheat, or say it doesn't keep.
- credit: where the recipe came from if the source shows it (a site name, cookbook, author or URL), otherwise "".
- note: one friendly sentence for the recipe card about what the dish is or why it's worth making.
- suggestedSection: the id of the best-fitting section from the list you're given, or "" if none fits.

Food safety, always: chicken and turkey 165°F; ground beef and pork 160°F; pork chops, tenderloin and roasts 145°F then rest 3 min; beef steaks get a doneness guide (130–135°F medium-rare, 140–145°F medium); fish 145°F or until it flakes; raw or rare fish must be sushi-grade and kept cold; in a slow cooker, brown ground meat first, never use frozen meat, and use canned or cooked beans; baked egg dishes to 160°F.

Voice: plain, direct, second person, short sentences, US spelling, numerals, "min" and "hr", temperatures like "425°F". No em dashes, no exclamation points.`;

/* ---------------- HTTP helpers ---------------- */
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(req, env, status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(req, env) } });
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}
// PASSCODES is a JSON secret like {"erin": "...", "mulberry": "..."}: one passcode per person.
// Returns the person the passcode belongs to. If `person` is given, the passcode must be theirs.
function checkPasscode(body, env, person) {
  let codes;
  try { codes = JSON.parse(env.PASSCODES || ""); } catch { codes = null; }
  if (!codes || typeof codes !== "object" || !Object.keys(codes).length) throw new HttpError(500, "The helper has no passcodes set yet.");
  let who = null;
  for (const [id, code] of Object.entries(codes)) if (body.passcode && safeEqual(body.passcode, String(code))) who = id;
  if (!who || (person && who !== person)) throw new HttpError(401, person ? `That isn't the passcode for ${person}'s box.` : "That passcode didn't work.");
  return who;
}
// "Made it before" takes an optional date from the site's date picker (YYYY-MM-DD).
// Blank means "made, date unknown": it counts, but adds nothing to the dated log.
function madeDate(s) {
  if (!s) return null;
  const m = typeof s === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCDate() !== +m[3] || +m[1] < 1950) throw new HttpError(400, "That date isn't valid.");
  if (d.getTime() > Date.now() + 14 * 3600e3) throw new HttpError(400, "That date is in the future.");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
// Keeps the log in date order, so its last entry stays the most recent time it was made.
function addToLog(log, d) {
  const t = (s) => { const v = Date.parse(s + " UTC"); return isNaN(v) ? -Infinity : v; };
  const out = log.slice();
  let at = out.length;
  while (at > 0 && t(out[at - 1]) > t(d)) at--;
  out.splice(at, 0, d);
  return out.slice(-50);
}
function displayDate(s) {
  if (typeof s === "string" && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(s)) return s;
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function cleanTags(tags) {
  const seen = new Set(), out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const v = cleanText(t, 30);
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out.slice(0, 12);
}
function checkPerson(person) {
  if (typeof person !== "string" || !/^[a-z0-9-]{1,40}$/.test(person)) throw new HttpError(400, "Unknown person.");
}

/* ---------------- Recipe cleanup and checks ---------------- */
const LIB_FIELDS = ["id", "title", "proteins", "slowCooker", "cozy", "servings", "prep", "cook", "total",
  "equipment", "ingredients", "steps", "tips", "storage", "credit", "photo", "nutrition", "addedBy", "addedAt"];
const MAX_PHOTO_B64 = 4_000_000; // about 3 MB; the site sends a resized JPEG of a few hundred KB

function cleanText(s, max = 2000) { return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : ""; }
function cleanList(a, max = 40) { return Array.isArray(a) ? a.map((s) => cleanText(s)).filter(Boolean).slice(0, max) : []; }

// Recipe names in title case: "Chicken Pot Pie Soup with Biscuits". Small words stay lowercase
// unless they start or end the name or follow a colon or "("; each part of a hyphenated word is
// capitalized ("Stir-Fry"); words that already mix cases (BBQ, McDonald's) are left alone; a name
// written in ALL CAPS is lowered first.
const SMALL_WORDS = new Set(("a an the and but or nor for so yet as at by in of off on per to up via vs vs. with from into onto over " +
  "n e y à a la au aux al alla con di de del du da en").split(" "));
export function titleCase(s) {
  if (!s) return s;
  if (s === s.toUpperCase() && /\p{L}/u.test(s)) s = s.toLowerCase();
  const words = s.split(/(\s+)/);
  const real = words.map((w, i) => (/\p{L}|\d/u.test(w) ? i : -1)).filter((i) => i >= 0);
  const first = real[0], last = real[real.length - 1];
  let afterBreak = false;
  return words.map((w, i) => {
    if (!/\p{L}|\d/u.test(w)) { if (/[:(—–]\s*$/.test(w)) afterBreak = true; return w; }
    const forceCap = i === first || i === last || afterBreak || /^[("“]/.test(w);
    afterBreak = /[:—–]$/.test(w);
    return w.split(/([-/])/).map((part, j, parts) => {
      const m = /^([^\p{L}\d]*)([\p{L}\d][\p{L}\d'’.]*)(.*)$/u.exec(part);
      if (!m) return part;
      const [, pre, core, post] = m;
      if (/\p{Lu}/u.test(core.slice(1))) return part; // BBQ, McDonald's, iPhone
      const lower = core.toLowerCase().replace(/['’]+$/, ""); // 'n' in mac 'n' cheese
      const edge = forceCap && (j === 0 || j === parts.length - 1 && i === last);
      if (SMALL_WORDS.has(lower) && !edge && parts.length === 1) return pre + core.toLowerCase() + post;
      return pre + core.charAt(0).toLocaleUpperCase() + core.slice(1) + post;
    }).join("");
  }).join("");
}

export function cleanRecipe(r) {
  const out = {
    title: titleCase(cleanText(r.title, 120)),
    proteins: Array.isArray(r.proteins) ? [...new Set(r.proteins.filter((p) => PROTEINS.includes(p)))] : [],
    slowCooker: r.slowCooker === true,
    cozy: r.cozy === true,
    servings: cleanText(r.servings, 80), prep: cleanText(r.prep, 80), cook: cleanText(r.cook, 80), total: cleanText(r.total, 80),
    equipment: cleanList(r.equipment, 10),
    ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, 12).map((g) => ({
      group: cleanText(g && g.group, 60) || null,
      items: cleanList(g && g.items, 60),
    })).filter((g) => g.items.length),
    steps: cleanList(r.steps, 20),
    tips: cleanList(r.tips, 6),
    storage: cleanText(r.storage, 600),
    credit: cleanText(r.credit, 200) || null,
  };
  if (!out.proteins.length) out.proteins = ["meatless"];
  return out;
}

export function recipeProblems(r) {
  const p = [];
  if (!r.title) p.push("title");
  for (const k of ["servings", "prep", "cook", "total", "storage"]) if (!r[k]) p.push(k);
  if (!r.ingredients.length) p.push("ingredients");
  if (!r.steps.length) p.push("steps");
  return p;
}

export function slugify(title) {
  return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "recipe";
}

/* ---------------- Claude ---------------- */
/* ---------------- Reading a recipe from a web page ---------------- */
// Most recipe sites publish the recipe as schema.org JSON-LD for search engines; that is used when it's
// there, since it's just the recipe without the stories, ads and comments. Otherwise the page's text is used.
const MAX_PAGE_BYTES = 4_000_000;
export function checkRecipeUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) throw new HttpError(400, "That link doesn't look right. Copy the whole address, starting with https://.");
  const h = u.hostname.toLowerCase();
  // Only public websites: no local names or bare IP addresses.
  if (!h.includes(".") || h === "localhost" || /\.(local|localhost|internal|lan|home)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("["))
    throw new HttpError(400, "That link can't be read. Use a recipe page on a public website.");
  return u;
}
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", frac12: "½", frac14: "¼", frac34: "¾", deg: "°", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function plain(s) { return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i"), tag = re.exec(html);
  const m = tag && /content=["']([^"']*)["']/i.exec(tag[0]);
  return m ? plain(m[1]) : "";
}
function findJsonLdRecipe(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const isRecipe = (o) => o && typeof o === "object" && [].concat(o["@type"] || []).some((t) => String(t).toLowerCase() === "recipe");
  function walk(o) {
    if (!o || typeof o !== "object") return null;
    if (Array.isArray(o)) { for (const x of o) { const f = walk(x); if (f) return f; } return null; }
    if (isRecipe(o)) return o;
    return walk(o["@graph"]) || walk(o.mainEntity) || null;
  }
  for (let m; (m = re.exec(html));) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const r = walk(data);
    if (r) return r;
  }
  return null;
}
function isoDuration(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(d || ""));
  if (!m || !(m[1] || m[2] || m[3])) return plain(d);
  const hrs = (+m[1] || 0) * 24 + (+m[2] || 0), min = +m[3] || 0;
  return [hrs ? `${hrs} hr` : "", min ? `${min} min` : ""].filter(Boolean).join(" ");
}
function names(x) { return [].concat(x || []).map((a) => plain(typeof a === "string" ? a : a && a.name)).filter(Boolean).join(", "); }
function recipeLdToText(r) {
  const lines = [`Name: ${plain(r.name)}`];
  if (r.description) lines.push(`Description: ${plain(r.description)}`);
  const by = names(r.author); if (by) lines.push(`Author: ${by}`);
  if (r.recipeYield) lines.push(`Yield: ${[].concat(r.recipeYield).map(plain).join(" / ")}`);
  for (const [k, label] of [["prepTime", "Prep"], ["cookTime", "Cook"], ["totalTime", "Total"]]) if (r[k]) lines.push(`${label}: ${isoDuration(r[k])}`);
  lines.push("", "Ingredients:", ...[].concat(r.recipeIngredient || r.ingredients || []).map((x) => `- ${plain(x)}`));
  lines.push("", "Instructions:");
  (function steps(list, depth) {
    for (const s of [].concat(list || [])) {
      if (typeof s === "string") lines.push(`- ${plain(s)}`);
      else if (s && [].concat(s["@type"] || []).includes("HowToSection")) { lines.push(`${plain(s.name)}:`); steps(s.itemListElement, depth + 1); }
      else if (s) lines.push(`- ${plain(s.text || s.name)}`);
    }
  })(r.recipeInstructions, 0);
  return lines.join("\n");
}
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && l !== "-").join("\n");
}
export function pageToText(html, url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const recipe = findJsonLdRecipe(html);
  return {
    url, site: metaContent(html, "og:site_name") || host,
    title: metaContent(html, "og:title") || plain((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]),
    structured: !!recipe,
    text: (recipe ? recipeLdToText(recipe) : htmlToText(html)).slice(0, MAX_TEXT),
  };
}
async function readRecipePage(raw) {
  const u = checkRecipeUrl(raw);
  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: "follow", signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KitchenHelper/1.0; +https://airpengwn.github.io/kitchen/)", Accept: "text/html,application/xhtml+xml" },
    });
  } catch { throw new HttpError(422, "Couldn't reach that page. Check the link, or copy the recipe text and paste it instead."); }
  checkRecipeUrl(res.url || u.toString()); // a redirect must not end up somewhere private either
  if (!res.ok) {
    throw new HttpError(422, [401, 403, 429, 451].includes(res.status)
      ? "That site wouldn't let the helper read the page. Copy the recipe text and paste it, or add screenshots instead."
      : `That page didn't load (error ${res.status}). Check the link, or paste the recipe text instead.`);
  }
  if (!/html|xml|text\/plain/i.test(res.headers.get("content-type") || "")) throw new HttpError(422, "That link isn't a web page. If it's a PDF or a photo, download it and add it as a file.");
  if (Number(res.headers.get("content-length") || 0) > MAX_PAGE_BYTES) throw new HttpError(422, "That page is too big to read. Copy the recipe text and paste it instead.");
  const page = pageToText((await res.text()).slice(0, MAX_PAGE_BYTES), res.url || u.toString());
  if (page.text.length < 40) throw new HttpError(422, "That page had almost no text the helper could read (it may need a login or load the recipe later). Copy the recipe text and paste it instead.");
  return page;
}

async function parseRecipe(body, env) {
  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_IMAGES) throw new HttpError(400, `Use at most ${MAX_IMAGES} images.`);
  for (const im of images) {
    if (!im || !IMAGE_TYPES.includes(im.media_type) || typeof im.data !== "string") throw new HttpError(400, "One of the images isn't a supported type.");
    if (im.data.length > MAX_IMAGE_B64) throw new HttpError(413, "One of the images is too large.");
  }
  const pdf = body.pdf && typeof body.pdf === "object" ? body.pdf : null;
  if (pdf) {
    // the base64 of every PDF starts with "JVBER" ("%PDF")
    if (typeof pdf.data !== "string" || !pdf.data.startsWith("JVBER")) throw new HttpError(400, "That file isn't a PDF.");
    if (pdf.data.length > MAX_PDF_B64) throw new HttpError(413, "That PDF is too large. Save just the recipe pages as a new PDF, or use screenshots.");
  }
  const total = images.reduce((n, im) => n + im.data.length, 0) + (pdf ? pdf.data.length : 0);
  if (total > MAX_TOTAL_B64) throw new HttpError(413, "That's too much to send at once. Use fewer or smaller files.");
  const hasPrevious = body.previous && typeof body.previous === "object";
  if (!text.trim() && !images.length && !pdf && !body.url && !hasPrevious) throw new HttpError(400, "Paste some text or add an image first.");
  const page = body.url ? await readRecipePage(body.url) : null;

  const sections = (Array.isArray(body.sections) ? body.sections : []).slice(0, 40)
    .filter((s) => s && typeof s.id === "string").map((s) => `- ${cleanText(s.id, 80)}: ${cleanText(s.title, 120)}`).join("\n");

  let prompt = `The recipe is for ${cleanText(body.person, 40)}'s page. Sections on that page:\n${sections || "(none)"}\n`;
  if (page) {
    prompt += `\nRecipe from a web page: ${page.url} (site: ${page.site}${page.title ? `, page title: ${page.title}` : ""}).\n` +
      (page.structured ? "Below is the recipe data the page publishes for search engines.\n" : "Below is the text of the page. It may include stories, ads and comments around the recipe; use only the recipe.\n") +
      `<<<\n${page.text}\n>>>\nFor credit, use the site name, plus the author if the page names one.\n`;
  }
  if (text.trim()) prompt += `\nPasted text:\n<<<\n${text}\n>>>\n`;
  if (images.length) prompt += `\n${images.length} image(s) of the recipe are attached above.\n`;
  if (pdf) prompt += `\nA PDF${pdf.name ? ` ("${cleanText(pdf.name, 120)}")` : ""} with the recipe is attached above.\n`;
  if (hasPrevious) {
    prompt += `\nYou already turned this into the recipe below. Apply the cook's correction and return the full corrected recipe. Keep everything else the same unless the correction requires changing it.\nPrevious recipe:\n${JSON.stringify(body.previous).slice(0, 40_000)}\nCorrection:\n${cleanText(body.fix, 2000)}\n`;
  }

  const content = [
    ...(pdf ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.data } }] : []),
    ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
    { type: "text", text: prompt },
  ];

  const { out, model } = await askClaude(env, {
    system: SYSTEM, content, schema: RECIPE_SCHEMA,
    badRequest: pdf ? "Claude couldn't read that PDF. If it has a password, remove it or use screenshots instead." : "Claude couldn't read that. Try a clearer screenshot or paste the text instead.",
  });
  if (!out.isRecipe) throw new HttpError(422, (out.assumptions && out.assumptions[0]) || "That doesn't look like a recipe.");

  const recipe = cleanRecipe(out);
  const missing = recipeProblems(recipe);
  if (missing.length) throw new HttpError(422, `The recipe came back incomplete (missing ${missing.join(", ")}). Try again or add more of the recipe.`);
  return {
    recipe,
    note: cleanText(out.note, 300),
    suggestedSection: cleanText(out.suggestedSection, 80),
    assumptions: cleanList(out.assumptions, 15),
    model,
  };
}

// One structured-output request to Claude; returns the parsed JSON answer and the model that wrote it.
async function askClaude(env, { system, content, schema, badRequest }) {
  const model = env.MODEL || "claude-opus-5-5";
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: env.EFFORT || "medium", format: { type: "json_schema", schema } },
  };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let msg;
  try {
    // Opus, Sonnet and Fable support server-side fallback when a safety check declines a request.
    msg = /^claude-(opus|sonnet|fable)/.test(model)
      ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(500, "The helper's Claude API key isn't working.");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude is busy right now. Wait a minute and try again.");
    if (e instanceof Anthropic.BadRequestError) throw new HttpError(400, badRequest || "Claude couldn't work with that. Try again.");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, "Claude had a problem. Try again in a minute.");
    throw new HttpError(502, "Couldn't reach Claude. Try again in a minute.");
  }
  if (msg.stop_reason === "refusal") throw new HttpError(422, "Claude declined to process this one.");
  if (msg.stop_reason === "max_tokens") throw new HttpError(422, "That recipe was too long to finish. Try splitting it up.");
  const block = msg.content.find((b) => b.type === "text");
  try { return { out: JSON.parse(block ? block.text : ""), model: msg.model }; }
  catch { throw new HttpError(502, "Claude's answer came back garbled. Try again."); }
}

/* ---------------- Nutrition (an estimate, saved with the recipe) ---------------- */
const NUTRIENTS = { calories: 5000, protein_g: 400, carbs_g: 800, fat_g: 400, saturated_fat_g: 200, fiber_g: 150, sugar_g: 500, sodium_mg: 20000 };
const NUTRITION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["servings", ...Object.keys(NUTRIENTS), "assumptions"],
  properties: {
    servings: { type: "number" },
    ...Object.fromEntries(Object.keys(NUTRIENTS).map((k) => [k, { type: "number" }])),
    assumptions: STR_ARRAY,
  },
};
const NUTRITION_SYSTEM = `You estimate nutrition facts for home-cooked recipes on a family recipe website.

Work from the ingredient list and amounts, using typical USDA values for each ingredient as bought (for example raw chicken thighs, dry pasta, canned beans drained if the recipe drains them). Follow what the steps do to the food: fat that is drained or skimmed off, a marinade that is thrown away, or oil used only for frying should be counted only in the share that ends up in the food. Count items in a "To serve" or toppings group at the amounts listed. Leave out ingredients marked optional. For "to taste" seasonings assume a modest amount (about ½ tsp salt for the whole recipe unless the recipe suggests more).

Give the values for ONE serving. Use the recipe's servings; if it gives a range like "4–6 servings", use the middle and say so. Put the number of servings you divided by in "servings".

Fields: calories (kcal), protein_g, carbs_g (total carbohydrate), fat_g (total fat), saturated_fat_g, fiber_g, sugar_g (total sugars), sodium_mg.

In "assumptions", list up to 5 short sentences on the choices that most affect the numbers (servings used, what was left out, brand-dependent items like sauces). Plain, direct sentences, no em dashes.`;

function round1(n) { return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10; }
async function estimateNutrition(body, env) {
  const id = typeof body.id === "string" && /^[a-z0-9-]{1,80}$/.test(body.id) ? body.id : null;
  if (!id) throw new HttpError(400, "Unknown recipe.");
  const path = `library/recipes/${id}.json`;
  const file = await getFile(env, path);
  if (!file) throw new HttpError(400, "That recipe isn't in the library.");
  const r = JSON.parse(file.text);
  const recipeText = [
    `Recipe: ${r.title}`, `Servings: ${r.servings}`, "", "Ingredients:",
    ...r.ingredients.flatMap((g) => [g.group ? `${g.group}:` : null, ...g.items.map((x) => `- ${x}`)].filter(Boolean)),
    "", "Steps:", ...r.steps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
  const { out, model } = await askClaude(env, {
    system: NUTRITION_SYSTEM, schema: NUTRITION_SCHEMA,
    content: [{ type: "text", text: `Estimate nutrition per serving for this recipe.\n\n${recipeText}` }],
  });

  const servings = Number(out.servings);
  if (!Number.isFinite(servings) || servings <= 0 || servings > 200) throw new HttpError(502, "Claude's estimate didn't make sense. Try again.");
  const perServing = {};
  for (const [k, max] of Object.entries(NUTRIENTS)) {
    const v = Number(out[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw new HttpError(502, "Claude's estimate didn't make sense. Try again.");
    perServing[k] = k === "calories" || k === "sodium_mg" ? Math.round(v) : round1(v);
  }
  const nutrition = { servings: round1(servings), perServing, assumptions: cleanList(out.assumptions, 5), model, estimatedAt: new Date().toISOString().slice(0, 10) };

  for (let attempt = 0, f = file; attempt < 3; attempt++) {
    if (attempt) f = await getFile(env, path);
    const cur = JSON.parse(f.text);
    cur.nutrition = nutrition;
    const outRecipe = Object.fromEntries(LIB_FIELDS.map((k) => [k, cur[k] === undefined ? null : cur[k]]));
    if (await putFile(env, path, JSON.stringify(outRecipe, null, 1) + "\n", `Estimate nutrition: ${cur.title} (from the website)`, f.sha)) return { id, nutrition };
  }
  throw new HttpError(409, "Someone else changed this recipe at the same moment. Try again.");
}

/* ---------------- GitHub ---------------- */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function gh(env, method, path, body) {
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}` + (method === "GET" ? `?ref=${encodeURIComponent(branch)}` : "");
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kitchen-helper",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify({ ...body, branch }) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(500, "The helper's GitHub token isn't working.");
  return res;
}
async function getFile(env, path) {
  const res = await gh(env, "GET", path);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, "Couldn't read from GitHub.");
  const j = await res.json();
  return { sha: j.sha, text: b64decode(j.content) };
}
async function putFile(env, path, text, message, sha) {
  return putB64(env, path, b64encode(text), message, sha);
}
async function putB64(env, path, content, message, sha) {
  const res = await gh(env, "PUT", path, { message, content, ...(sha ? { sha } : {}) });
  if (res.status === 409 || res.status === 422) return false; // changed underneath us, or already exists
  if (!res.ok) throw new HttpError(502, "Couldn't save to GitHub.");
  return true;
}
async function deleteFile(env, path, message) {
  const res = await gh(env, "GET", path);
  if (!res.ok) return;
  const { sha } = await res.json();
  await gh(env, "DELETE", path, { message, sha });
}

/* ---------------- Editing a library recipe ---------------- */
// Replaces the recipe's text fields. Its id (and so its link), photo, addedBy and addedAt stay.
async function editRecipe(body, env) {
  const id = typeof body.id === "string" && /^[a-z0-9-]{1,80}$/.test(body.id) ? body.id : null;
  if (!id) throw new HttpError(400, "Unknown recipe.");
  const recipe = cleanRecipe(body.recipe || {});
  const missing = recipeProblems(recipe);
  if (missing.length) throw new HttpError(400, `The recipe is missing ${missing.join(", ")}.`);
  const path = `library/recipes/${id}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await getFile(env, path);
    if (!file) throw new HttpError(400, "That recipe isn't in the library.");
    const old = JSON.parse(file.text);
    const r = { ...old, ...recipe, id };
    // A nutrition estimate no longer fits once what goes in, or how many it serves, changes.
    const basis = (x) => JSON.stringify([x.ingredients, x.servings, x.steps]);
    if (basis(old) !== basis(r)) r.nutrition = null;
    const out = Object.fromEntries(LIB_FIELDS.map((k) => [k, r[k] === undefined ? null : r[k]]));
    const text = JSON.stringify(out, null, 1) + "\n";
    if (text === file.text) return { id, recipe: out, changed: false };
    if (await putFile(env, path, text, `Edit recipe: ${out.title} (from the website)`, file.sha)) return { id, recipe: out, changed: true };
  }
  throw new HttpError(409, "Someone else changed this recipe at the same moment. Try again.");
}

/* ---------------- Recipe photos (shared by every kitchen) ---------------- */
// The photo is saved as library/photos/<id>-<stamp>.jpg; a new name each time means no browser
// ever shows a stale copy. The old file is deleted once the recipe points at the new one.
async function setPhoto(body, env) {
  const id = typeof body.id === "string" && /^[a-z0-9-]{1,80}$/.test(body.id) ? body.id : null;
  if (!id) throw new HttpError(400, "Unknown recipe.");
  const path = `library/recipes/${id}.json`;
  let file = await getFile(env, path);
  if (!file) throw new HttpError(400, "That recipe isn't in the library.");

  let photo = null;
  if (body.image) {
    const data = body.image && body.image.media_type === "image/jpeg" && typeof body.image.data === "string" ? body.image.data : "";
    if (!data.startsWith("/9j/")) throw new HttpError(400, "That photo isn't a JPEG.");
    if (data.length > MAX_PHOTO_B64) throw new HttpError(413, "That photo is too large.");
    photo = `library/photos/${id}-${Date.now().toString(36)}.jpg`;
    if (!(await putB64(env, photo, data, `Add photo: ${id}`))) throw new HttpError(502, "Couldn't save the photo to GitHub.");
  }
  let old = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) file = await getFile(env, path);
    const r = JSON.parse(file.text);
    old = r.photo || null;
    r.photo = photo;
    const msg = photo ? `${old ? "Change" : "Add"} photo: ${r.title} (from the website)` : `Remove photo: ${r.title} (from the website)`;
    if (await putFile(env, path, JSON.stringify(r, null, 1) + "\n", msg, file.sha)) {
      if (old && old !== photo && /^library\/photos\/[a-z0-9-]+\.jpg$/.test(old)) await deleteFile(env, old, `Delete old photo: ${id}`).catch(() => {});
      return { id, photo };
    }
  }
  throw new HttpError(409, "Someone else changed this recipe at the same moment. Try again.");
}

async function saveRecipe(body, env) {
  checkPerson(body.person);
  const recipe = cleanRecipe(body.recipe || {});
  const missing = recipeProblems(recipe);
  if (missing.length) throw new HttpError(400, `The recipe is missing ${missing.join(", ")}.`);
  const mode = body.box && ["new", "made", "madebefore", "library"].includes(body.box.mode) ? body.box.mode : "library";

  const personPath = `people/${body.person}.json`;
  const personFile = await getFile(env, personPath);
  if (!personFile) throw new HttpError(400, "Unknown person.");

  const today = new Date().toISOString().slice(0, 10);
  const base = slugify(recipe.title);
  let id = base, saved = false;
  const full = () => {
    const r = { id, ...recipe, addedBy: body.person, addedAt: today };
    return Object.fromEntries(LIB_FIELDS.map((k) => [k, r[k] === undefined ? null : r[k]]));
  };
  for (let n = 1; n <= 20 && !saved; n++) {
    id = n === 1 ? base : `${base}-${n}`;
    if (await getFile(env, `library/recipes/${id}.json`)) continue;
    saved = await putFile(env, `library/recipes/${id}.json`, JSON.stringify(full(), null, 1) + "\n", `Add recipe: ${recipe.title} (from the website)`);
  }
  if (!saved) throw new HttpError(409, "Couldn't find a free name for this recipe.");

  let entry = null;
  if (mode !== "library") {
    const made = mode === "made";
    const result = await editPerson(env, body.person, `Add ${recipe.title} to the box`, (p) => {
      const sectionIds = (p.sections || []).map((s) => s.id);
      entry = {
        id, section: sectionIds.includes(body.box.section) ? body.box.section : sectionIds[0],
        blurb: cleanText(body.box.blurb, 300), note: "", tags: [],
        made: { count: made || mode === "madebefore" ? 1 : 0, log: made ? [displayDate(body.box.date)] : [] }, confidence: "clear",
      };
      p.box = (p.box || []).filter((b) => b.id !== id).concat([entry]);
    }, personFile);
    if (!result) throw new HttpError(409, "The recipe saved, but adding it to the box failed. Open it from the whole library and add it there.");
  }
  return { id, recipe: full(), entry };
}

// Read-modify-write the person file, retrying if someone else saved in between.
async function editPerson(env, person, message, change, first) {
  const path = `people/${person}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pf = attempt === 0 && first ? first : await getFile(env, path);
    if (!pf) throw new HttpError(400, "Unknown person.");
    const p = JSON.parse(pf.text);
    const res = change(p);
    if (res === false) return p; // nothing to change
    p.updated = new Date().toISOString().slice(0, 10);
    if (await putFile(env, path, JSON.stringify(p, null, 1) + "\n", message, pf.sha)) return p;
  }
  return null;
}

/* ---------------- Box: add, remove, made (today or before), tags, note, section ---------------- */
const BOX_OPS = ["add", "remove", "made", "madebefore", "unmade", "tags", "note", "section"];
async function boxAction(body, env) {
  checkPerson(body.person);
  const op = body.op;
  if (!BOX_OPS.includes(op)) throw new HttpError(400, "Unknown change.");
  const id = typeof body.id === "string" && /^[a-z0-9-]{1,80}$/.test(body.id) ? body.id : null;
  if (!id) throw new HttpError(400, "Unknown recipe.");
  if (op === "add" && !(await getFile(env, `library/recipes/${id}.json`))) throw new HttpError(400, "That recipe isn't in the library.");

  let entry = null;
  const words = { add: "Add", remove: "Remove", made: "Mark made", madebefore: "Mark made before", unmade: "Undo made", tags: "Update tags on", note: "Update note on", section: "Move" };
  const p = await editPerson(env, body.person, `${words[op]} ${id} (${body.person}'s box)`, (p) => {
    p.box = p.box || [];
    const i = p.box.findIndex((b) => b.id === id);
    const sectionIds = (p.sections || []).map((s) => s.id);
    if (op === "add") {
      if (i !== -1) { entry = p.box[i]; return false; }
      entry = { id, section: sectionIds.includes(body.section) ? body.section : sectionIds[0], blurb: "", note: "", tags: [], made: { count: 0, log: [] }, confidence: "clear" };
      p.box.push(entry);
      return;
    }
    if (i === -1) throw new HttpError(409, "That recipe isn't in the box anymore. Refresh the page.");
    if (op === "remove") { p.box.splice(i, 1); return; }
    const e = p.box[i];
    // Each made mark remembers what it added (made.undo), so Undo last takes back exactly that.
    if (op === "made") {
      const d = displayDate(body.date);
      e.made = { count: e.made.count + 1, log: e.made.log.concat([d]).slice(-50), undo: { date: d } };
    }
    if (op === "madebefore") {
      const d = madeDate(body.date);
      e.made = { count: e.made.count + 1, log: d ? addToLog(e.made.log, d) : e.made.log, undo: { date: d } };
    }
    if (op === "unmade") {
      if (!e.made.count) { entry = e; return false; }
      const u = e.made.undo;
      let log = e.made.log;
      if (!u) log = log.slice(0, -1);
      else if (u.date && log.lastIndexOf(u.date) !== -1) { const k = log.lastIndexOf(u.date); log = log.slice(0, k).concat(log.slice(k + 1)); }
      e.made = { count: e.made.count - 1, log };
    }
    if (op === "tags") e.tags = cleanTags(body.tags);
    if (op === "note") e.note = cleanText(body.note, 1000);
    if (op === "section") {
      if (!sectionIds.includes(body.section)) throw new HttpError(400, "Unknown section.");
      e.section = body.section;
    }
    entry = e;
  });
  if (!p) throw new HttpError(409, "Someone else changed the box at the same moment. Try again.");
  return { entry: op === "remove" ? null : entry, updated: p.updated };
}

/* ---------------- Router ---------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return json(req, env, 200, { ok: true, service: "kitchen-helper" });
    if (req.method !== "POST") return json(req, env, 405, { error: "Use POST." });
    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > 30_000_000) return json(req, env, 413, { error: "That's too much to send at once. Use fewer or smaller files." });
    try {
      let body;
      try { body = await req.json(); } catch { throw new HttpError(400, "The request wasn't readable."); }
      if (url.pathname === "/check") return json(req, env, 200, { ok: true, person: checkPasscode(body, env) });
      if (url.pathname === "/parse") { checkPasscode(body, env); checkPerson(body.person); return json(req, env, 200, await parseRecipe(body, env)); }
      if (url.pathname === "/save") { checkPerson(body.person); checkPasscode(body, env, body.person); return json(req, env, 200, await saveRecipe(body, env)); }
      if (url.pathname === "/box") { checkPerson(body.person); checkPasscode(body, env, body.person); return json(req, env, 200, await boxAction(body, env)); }
      if (url.pathname === "/nutrition") { checkPerson(body.person); checkPasscode(body, env, body.person); return json(req, env, 200, await estimateNutrition(body, env)); }
      if (url.pathname === "/edit") { checkPerson(body.person); checkPasscode(body, env, body.person); return json(req, env, 200, await editRecipe(body, env)); }
      if (url.pathname === "/photo") { checkPerson(body.person); checkPasscode(body, env, body.person); return json(req, env, 200, await setPhoto(body, env)); }
      return json(req, env, 404, { error: "Not found." });
    } catch (e) {
      if (e instanceof HttpError) return json(req, env, e.status, { error: e.message });
      console.error(e);
      return json(req, env, 500, { error: "Something went wrong in the helper." });
    }
  },
};
