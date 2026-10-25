/* Kitchen site app, shared by every person's page.
   Each page sets window.KITCHEN = { person: "erin", root: "../" } before loading this file.
   Data: library/recipes.json (every recipe), people/<person>.json (their sections and box),
   site.json (the helper's address). The box holds this person's own tags, notes and made history. */
(function () {
  var CFG = window.KITCHEN || {};
  var ROOT = CFG.root || './';
  var PERSON = CFG.person;
  var LABEL = { chicken: 'Chicken', beef: 'Beef', pork: 'Pork', seafood: 'Seafood', eggs: 'Eggs', meatless: 'Meatless' };
  var CONF = { likely: 'Likely', guess: 'Best guess' };
  var CONF_NOTE = { likely: "Likely: I'm fairly sure this is the dish, but not certain.", guess: "Best guess: the photo doesn't show enough to be sure." };
  var PRON = {
    she: { poss: 'Her', subj: 'she', made: "She's made it", notMade: "Hasn't made it", d: "she'd" },
    he: { poss: 'His', subj: 'he', made: "He's made it", notMade: "Hasn't made it", d: "he'd" },
    they: { poss: 'Their', subj: 'they', made: "They've made it", notMade: "Haven't made it", d: "they'd" },
    we: { poss: 'Our', subj: 'we', made: "We've made it", notMade: "Haven't made it", d: "we'd" }
  };
  var GROUPS = ['status', 'protein', 'slow', 'cozy', 'tag'];
  var $ = function (id) { return document.getElementById(id); };
  var main = $('main'), viewer = $('viewer'), adder = $('adder'), results = $('results'), qEl = $('q');
  var person = null, site = {}, library = [], recipes = [], sections = [], byId = {}, pron = PRON.they;
  var sel = { status: [], protein: [], slow: [], cozy: [], tag: [] };
  var mode = 'box';
  var query = '';
  var listScroll = 0, openedFromList = false, current = null;
  var PASS_KEY = 'ek-pass-' + PERSON;

  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function forget(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text) { var b = el('button', cls, text); b.type = 'button'; return b; }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function fmtDate(d) { d = typeof d === 'string' ? new Date(d + 'T12:00:00') : d; return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function getJSON(path) {
    return fetch(ROOT + path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); });
  }

  /* ---------- Data ---------- */
  function boxEntry(id) { return person.box.filter(function (b) { return b.id === id; })[0]; }
  function sectionById(id) { return person.sections.filter(function (s) { return s.id === id; })[0]; }
  function allTags() {
    var seen = {}, out = [];
    (person.tags || []).concat.apply(person.tags || [], person.box.map(function (b) { return b.tags || []; }))
      .forEach(function (t) { var k = norm(t); if (!seen[k]) { seen[k] = 1; out.push(t); } });
    return out;
  }
  function merge() {
    var order = {};
    person.box.forEach(function (b, i) { order[b.id] = i; });
    recipes = library.map(function (lr) {
      var b = boxEntry(lr.id);
      var r = Object.assign({}, lr);
      r.inBox = !!b;
      r.entry = b || null;
      r.made = b ? b.made.count : 0;
      r.myTags = b ? b.tags : [];
      r.myNote = b ? b.note : '';
      r.section = b ? b.section : null;
      r.confidence = b ? (b.confidence || 'clear') : 'clear';
      r.blurb = b && b.blurb ? b.blurb : (lr.credit ? 'From ' + lr.credit + '.' : '');
      r._order = b ? order[lr.id] : 1e6;
      return r;
    });
    byId = {};
    recipes.forEach(function (r) {
      byId[r.id] = r;
      var sec = r.section ? sectionById(r.section) : null;
      r._hay = norm([r.title, r.blurb, r.myNote, r.myTags.join(' '), sec ? sec.title : '', r.credit || '',
        r.proteins.map(function (p) { return LABEL[p]; }).join(' '),
        r.slowCooker ? 'slow cooker crockpot' : '', r.cozy ? 'warm cozy fall' : '', r.made ? 'made it' : '',
        r.ingredients.map(function (g) { return (g.group || '') + ' ' + g.items.join(' '); }).join(' '),
        (r.equipment || []).join(' ')].join(' '));
    });
  }
  function inView(r) { return mode === 'library' || r.inBox; }

  /* ---------- Filters ---------- */
  function values(r, g) {
    if (g === 'status') return [r.made ? 'made' : 'notmade'];
    if (g === 'protein') return r.proteins;
    if (g === 'slow') return r.slowCooker ? ['on'] : [];
    if (g === 'cozy') return r.cozy ? ['on'] : [];
    return r.myTags.map(norm);
  }
  function inGroup(r, g) {
    if (!sel[g].length) return true;
    var v = values(r, g);
    return sel[g].some(function (x) { return v.indexOf(x) !== -1; });
  }
  function matchesQuery(r) {
    if (!query) return true;
    return query.split(/\s+/).every(function (w) { return r._hay.indexOf(w) !== -1; });
  }
  function matches(r, skip) {
    return inView(r) && matchesQuery(r) && GROUPS.every(function (g) { return g === skip || inGroup(r, g); });
  }

  /* ---------- Rendering ---------- */
  function madeLabel(n) { return n === 1 ? 'Made once' : 'Made ' + n + '×'; }
  function tagsFor(r, opts) {
    var t = el('div', 'tags');
    if (r.made) t.appendChild(el('span', 'tag made', madeLabel(r.made)));
    if (opts && opts.showBox && r.inBox) t.appendChild(el('span', 'tag inbox', 'In ' + person.name + "'s box"));
    r.myTags.forEach(function (x) { t.appendChild(el('span', 'tag mine', x)); });
    r.proteins.forEach(function (p) { t.appendChild(el('span', 'tag', LABEL[p])); });
    if (r.slowCooker) t.appendChild(el('span', 'tag warm', 'Slow cooker'));
    if (r.cozy) t.appendChild(el('span', 'tag warm', 'Warm & cozy'));
    if (CONF[r.confidence]) t.appendChild(el('span', 'tag conf', CONF[r.confidence]));
    return t;
  }
  function metaFor(r) { return [r.total, r.servings].filter(Boolean).join(' · '); }
  function kindLabel(kind) {
    if (kind === 'photos') return 'From ' + pron.poss.toLowerCase() + ' photos';
    if (kind === 'ideas') return 'Ideas to try';
    return pron.poss + ' recipe box';
  }
  function blurbLabel(r) {
    var sec = r.section ? sectionById(r.section) : null;
    if (sec && sec.kind === 'photos') return 'In ' + pron.poss.toLowerCase() + ' photos';
    if (sec && sec.kind === 'ideas') return 'Why ' + pron.d + ' like it';
    return 'About this recipe';
  }

  function renderHeader() {
    document.title = person.title;
    $('title').textContent = person.title;
    $('handle').textContent = person.handle ? 'From ' + person.handle : 'Recipe box';
    var av = $('avatar');
    if (person.avatar) { av.src = ROOT + person.avatar; av.alt = person.avatarAlt || ''; av.hidden = false; }
    var inBox = recipes.filter(function (r) { return r.inBox; });
    var made = inBox.filter(function (r) { return r.made; });
    var stats = [
      [inBox.length, 'recipes in ' + pron.poss.toLowerCase() + ' box'],
      [made.length, 'made at least once'],
      [made.reduce(function (n, r) { return n + r.made; }, 0), 'times cooked'],
      [library.length, 'recipes in the whole library']
    ];
    var s = $('stats'); s.textContent = '';
    stats.forEach(function (x) { var d = el('div'); d.appendChild(el('b', null, String(x[0]))); d.appendChild(el('span', null, x[1])); s.appendChild(d); });
    $('updated').textContent = person.updated ? 'Updated ' + fmtDate(person.updated) : '';
    qEl.placeholder = person.searchHint || 'Search recipes';
    renderTagChips();
    renderTabs();
  }

  function renderTabs() {
    var nb = recipes.filter(function (r) { return r.inBox; }).length;
    $('tab-box').textContent = pron.poss + ' box (' + nb + ')';
    $('tab-library').textContent = 'Whole library (' + library.length + ')';
    $('tab-box').setAttribute('aria-pressed', String(mode === 'box'));
    $('tab-library').setAttribute('aria-pressed', String(mode === 'library'));
  }

  // The Made, Protein and Style filter rows, built here for every kitchen (Tags are built below,
  // from that kitchen's own tags). Each page only has the empty .fgroups spot for them.
  function buildFilters() {
    var groups = [
      ['status', 'Made', [['made', pron.made], ['notmade', pron.notMade]]],
      ['protein', 'Protein', PROTEIN_IDS.map(function (p) { return [p, LABEL[p]]; })],
      ['style', 'Style', [['slow:on', 'Slow cooker'], ['cozy:on', 'Warm & cozy']]]
    ];
    var host = $('tag-group').parentNode;
    groups.forEach(function (g) {
      var box = el('div', 'fgroup'); box.setAttribute('role', 'group'); box.setAttribute('aria-labelledby', 'fl-' + g[0]);
      var lab = el('span', 'flabel', g[1]); lab.id = 'fl-' + g[0]; box.appendChild(lab);
      g[2].forEach(function (c) {
        var key = c[0].split(':'), group = key.length > 1 ? key[0] : g[0], value = key.length > 1 ? key[1] : key[0];
        var b = btn('fchip' + (g[0] === 'style' ? ' style' : ''), c[1] + ' ');
        b.setAttribute('data-group', group); b.setAttribute('data-value', value); b.setAttribute('aria-pressed', 'false');
        b.appendChild(el('span', 'n')); box.appendChild(b);
      });
      host.insertBefore(box, $('tag-group'));
    });
  }

  function renderTagChips() {
    var g = $('tag-group'), tags = allTags();
    g.querySelectorAll('.fchip').forEach(function (c) { c.remove(); });
    g.hidden = !tags.length;
    tags.forEach(function (t) {
      var b = btn('fchip mine', t + ' ');
      b.setAttribute('data-group', 'tag'); b.setAttribute('data-value', norm(t)); b.setAttribute('aria-pressed', 'false');
      b.appendChild(el('span', 'n'));
      g.appendChild(b);
    });
    sel.tag = sel.tag.filter(function (v) { return tags.some(function (t) { return norm(t) === v; }); });
  }

  function card(r) {
    var a = el('a', 'card'); a.href = '#r-' + r.id; r._card = a;
    var top = el('div', 'card-top'); top.appendChild(el('h3', null, r.title)); top.appendChild(el('span', 'meta', metaFor(r)));
    var src = photoSrc(r);
    if (src) {
      a.classList.add('has-photo');
      var th = el('img', 'cthumb'); th.src = src; th.alt = ''; th.loading = 'lazy'; th.decoding = 'async';
      top.appendChild(th);
    }
    a.appendChild(top); a.appendChild(tagsFor(r, { showBox: mode === 'library' }));
    if (r.myNote) a.appendChild(el('p', 'cnote mine', r.myNote));
    else if (r.blurb) a.appendChild(el('p', 'cnote', r.blurb));
    a.appendChild(el('span', 'open', 'Open recipe →'));
    return a;
  }

  function renderList() {
    results.textContent = '';
    recipes.forEach(function (r) { r._card = null; });
    if (mode === 'library') {
      var sec = el('section', 'rsection');
      var head = el('div', 'section-head');
      head.appendChild(el('span', 'eyebrow', 'Whole library'));
      head.appendChild(el('h2', null, 'Every recipe, A to Z'));
      head.appendChild(el('p', null, "Recipes from everyone's boxes and everything added to the library. Nothing here is ever deleted. Open one to add it to " + person.name + "'s box."));
      sec.appendChild(head);
      var grid = el('div', 'cards');
      recipes.slice().sort(function (a, b) { return a.title.localeCompare(b.title); }).forEach(function (r) { grid.appendChild(card(r)); });
      sec.appendChild(grid); results.appendChild(sec);
      return;
    }
    var boxed = recipes.filter(function (r) { return r.inBox; }).sort(function (a, b) { return a._order - b._order; });
    if (!boxed.length) {
      var empty = el('div', 'empty');
      empty.appendChild(el('p', null, pron.poss + ' box is empty so far. Open the whole library and add recipes, or add a new one.'));
      var go = btn(null, 'Browse the whole library');
      go.addEventListener('click', function () { setMode('library'); });
      empty.appendChild(go);
      results.appendChild(empty);
      return;
    }
    var kinds = {}, counts = {};
    person.sections.forEach(function (s) { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    person.sections.forEach(function (s) {
      var inSec = boxed.filter(function (r) { return r.section === s.id; });
      if (!inSec.length) return;
      counts[s.kind] = (counts[s.kind] || 0) + 1;
      var sec = el('section', 'rsection'); sec.id = 's-' + s.id;
      var head = el('div', 'section-head');
      head.appendChild(el('span', 'eyebrow', kindLabel(s.kind)));
      head.appendChild(el('h2', null, s.title));
      if (s.intro) head.appendChild(el('p', null, s.intro));
      sec.appendChild(head);
      var grid = el('div', 'cards');
      inSec.forEach(function (r) { grid.appendChild(card(r)); });
      sec.appendChild(grid); results.appendChild(sec);
    });
  }

  function chips() { return Array.prototype.slice.call(document.querySelectorAll('.fchip')); }
  function apply() {
    var shown = 0, total = recipes.filter(inView).length;
    recipes.forEach(function (r) { var ok = matches(r); if (r._card) r._card.hidden = !ok; if (ok) shown++; });
    results.querySelectorAll('.rsection').forEach(function (s) { s.hidden = !s.querySelector('.card:not([hidden])'); });
    var filtered = !!query || GROUPS.some(function (g) { return sel[g].length; });
    var about = $('about'); if (about) about.hidden = filtered || mode === 'library';
    chips().forEach(function (b) {
      var g = b.getAttribute('data-group'), v = b.getAttribute('data-value');
      var on = sel[g].indexOf(v) !== -1;
      b.setAttribute('aria-pressed', String(on));
      var n = recipes.filter(function (r) { return matches(r, g) && values(r, g).indexOf(v) !== -1; }).length;
      b.querySelector('.n').textContent = n;
      b.disabled = !on && n === 0;
    });
    $('count').textContent = filtered ? shown + ' of ' + total + ' recipes' : total + ' recipes';
    $('clear').hidden = !filtered;
    $('empty').hidden = shown > 0 || !total;
    store('ek-filters-' + PERSON, sel);
  }
  function setMode(m) {
    mode = m; store('ek-mode-' + PERSON, m);
    renderTabs(); renderList(); apply();
  }
  function refresh() { merge(); renderHeader(); renderList(); apply(); }

  document.querySelector('.finder').addEventListener('click', function (e) {
    var b = e.target.closest('.fchip');
    if (!b) return;
    var g = b.getAttribute('data-group'), v = b.getAttribute('data-value');
    var i = sel[g].indexOf(v);
    if (i === -1) sel[g].push(v); else sel[g].splice(i, 1);
    apply();
  });
  $('tab-box').addEventListener('click', function () { setMode('box'); });
  $('tab-library').addEventListener('click', function () { setMode('library'); });
  qEl.addEventListener('input', function () { query = norm(qEl.value.trim()); apply(); });
  function clearAll() { GROUPS.forEach(function (g) { sel[g] = []; }); qEl.value = ''; query = ''; apply(); }
  $('clear').addEventListener('click', clearAll);
  $('reset').addEventListener('click', clearAll);
  results.addEventListener('click', function (e) { if (e.target.closest('.card')) { listScroll = window.scrollY; openedFromList = true; } });
  $('add-open').addEventListener('click', function () { listScroll = window.scrollY; openedFromList = true; });

  /* ---------- Helper calls (passcode remembered per person, per device) ---------- */
  function helper(path, body) {
    if (!site.worker) return Promise.reject(Object.assign(new Error("Changes aren't switched on yet. The helper still needs to be set up (see SETUP.md)."), { status: 0 }));
    return fetch(site.worker.replace(/\/$/, '') + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) { var e = new Error(j.error || ('The helper answered ' + res.status + '.')); e.status = res.status; throw e; }
        return j;
      });
    });
  }
  // A passcode field that only shows when this device doesn't know the passcode yet.
  // `lazy` keeps it hidden until a change actually needs it.
  function passRow(parent, lazy) {
    var f = el('div', 'field passrow');
    var id = 'pass-' + Math.random().toString(36).slice(2, 8);
    var l = el('label', null, person.name + "'s passcode"); l.htmlFor = id;
    var i = el('input'); i.type = 'password'; i.id = id; i.autocomplete = 'current-password';
    f.appendChild(l); f.appendChild(i);
    f.appendChild(el('span', 'hint', 'Needed once on this device to make changes.'));
    f.hidden = lazy || !!load(PASS_KEY);
    parent.appendChild(f);
    return {
      get: function () { return load(PASS_KEY) || i.value.trim(); },
      ok: function () { if (!load(PASS_KEY) && i.value.trim()) store(PASS_KEY, i.value.trim()); f.hidden = true; },
      bad: function () { forget(PASS_KEY); f.hidden = false; i.value = ''; i.focus(); },
      need: function () { if (!this.get()) { f.hidden = false; i.focus(); return true; } return false; }
    };
  }
  function errText(e) { return e.message || "That didn't go through. Check your connection and try again."; }

  /* ---------- Scaling a recipe (½×, 2×, ...) ---------- */
  // Only the amount at the start of each ingredient (and the Serves line) changes; amounts inside the
  // steps, pan sizes and times stay as written. "1 can" becomes "2 cans" and back.
  var FRACS = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6 };
  var FRAC_CH = Object.keys(FRACS).join('');
  var NUM_RE = '(?:\\d+\\s?[' + FRAC_CH + ']|\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d*\\.\\d+|\\d+|[' + FRAC_CH + '])';
  var LEAD_RE = new RegExp('^(' + NUM_RE + ')(\\s*(?:–|-|to)\\s*(' + NUM_RE + '))?');
  var NICE = [[0, ''], [1 / 16, '1/16'], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
  var PLURAL = {};
  ('cup can clove egg onion carrot stalk rib sprig slice piece package packet bag jar bottle tortilla pepper apple lemon lime stick ' +
   'head link fillet breast thigh drumstick shallot banana avocado pound ounce quart pint gallon sheet strip steak chop container envelope ' +
   'scoop handful teaspoon tablespoon serving muffin cookie bar roll pie cake taco burrito bowl skewer wrap pizza square ball crust bun ' +
   'biscuit pod star leg wing cube chunk').split(' ').forEach(function (w) { PLURAL[w] = w + 's'; });
  Object.assign(PLURAL, { box: 'boxes', potato: 'potatoes', tomato: 'tomatoes', leaf: 'leaves', loaf: 'loaves', bunch: 'bunches', pinch: 'pinches', dash: 'dashes', sandwich: 'sandwiches', patty: 'patties', berry: 'berries', radish: 'radishes' });
  var SINGULAR = {}; Object.keys(PLURAL).forEach(function (w) { SINGULAR[PLURAL[w]] = w; });
  var ADJ = {}; ('large medium small whole big extra-large yellow red white green sweet ripe fresh boneless skinless bone-in russet roma heaping level dried ' +
    'bay bell chicken garlic jalapeño jalapeno corn flour hamburger hot dog cherry plum english hard-boiled celery lemon lime').split(' ').forEach(function (w) { ADJ[w] = 1; });
  function parseNum(s) {
    var m; s = s.trim();
    if ((m = new RegExp('^(\\d+)\\s?([' + FRAC_CH + '])$').exec(s))) return +m[1] + FRACS[m[2]];
    if ((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s))) return +m[1] + m[2] / m[3];
    if ((m = /^(\d+)\/(\d+)$/.exec(s))) return m[1] / m[2];
    if (FRACS[s] != null) return FRACS[s];
    return parseFloat(s);
  }
  function fmtNum(n, metric) {
    if (metric) return String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
    if (n >= 10) { var h = Math.round(n * 2) / 2; return Math.floor(h) + (h % 1 ? '½' : ''); }
    var whole = Math.floor(n), f = n - whole, best = NICE[0];
    NICE.forEach(function (x) { if (Math.abs(x[0] - f) < Math.abs(best[0] - f)) best = x; });
    if (best[0] === 1) { whole += 1; best = NICE[0]; }
    if (!whole && !best[1]) best = NICE[1]; // never round a real amount down to nothing
    if (whole && best[1] === '1/16') best = NICE[0];
    return (whole || '') + best[1];
  }
  function scaleText(text, f) {
    if (f === 1 || !text) return text;
    var m = LEAD_RE.exec(text);
    if (!m) return text;
    if (!m[3] && /^-[a-z]/i.test(text.slice(m[1].length))) return text; // a size like "1-inch piece", not an amount
    var a = parseNum(m[1]), b = m[3] ? parseNum(m[3]) : null;
    if (!isFinite(a) || (b !== null && !isFinite(b))) return text;
    var rest = text.slice(m[0].length);
    var metric = /^\s*(g|grams?|kg|kilograms?|ml|millilit(er|re)s?|l|lit(er|re)s?)\b/i.test(rest);
    var amount = fmtNum(a * f, metric) + (b !== null ? m[2].slice(0, m[2].length - m[3].length) + fmtNum(b * f, metric) : '');
    var before = (b !== null ? b : a) > 1, after = (b !== null ? b : a) * f > 1;
    if (before !== after) rest = renoun(rest, after);
    return amount + rest;
  }
  // Switch the first counted noun after the amount between singular and plural, keeping its case.
  function renoun(rest, plural) {
    var re = /([A-Za-z-]+)/g, start = /^\s*(\([^)]*\)\s*)?/.exec(rest)[0].length, m, n = 0;
    re.lastIndex = start;
    while ((m = re.exec(rest)) && n < 3) {
      var w = m[1], lw = w.toLowerCase(), to = plural ? PLURAL[lw] : SINGULAR[lw];
      if (to) return rest.slice(0, m.index) + (w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to) + rest.slice(m.index + w.length);
      if ((plural ? SINGULAR[lw] : PLURAL[lw]) || !ADJ[lw]) return rest; // already right, or not a word we know
      n++;
    }
    return rest;
  }

  /* ---------- Nutrition estimate (saved with the recipe, shared by every kitchen) ---------- */
  var NUTRI = [['protein_g', 'Protein', 'g'], ['carbs_g', 'Carbs', 'g'], ['fat_g', 'Fat', 'g'], ['saturated_fat_g', 'Saturated fat', 'g'], ['fiber_g', 'Fiber', 'g'], ['sugar_g', 'Sugar', 'g'], ['sodium_mg', 'Sodium', 'mg']];
  function nutritionLine(n) {
    var p = n.perServing;
    return Math.round(p.calories) + ' cal · ' + p.protein_g + ' g protein · ' + p.carbs_g + ' g carbs · ' + p.fat_g + ' g fat · ' + p.sodium_mg + ' mg sodium';
  }
  function nutritionBlock(r, body) {
    var row = el('div', 'vtools');
    var pill = btn('pill', r.nutrition ? 'Nutrition · ' + Math.round(r.nutrition.perServing.calories) + ' cal' : 'Nutrition');
    pill.setAttribute('aria-expanded', 'false');
    row.appendChild(pill); body.appendChild(row);
    var panel = el('section', 'vnutri'); panel.hidden = true; panel.setAttribute('aria-label', 'Nutrition');
    body.appendChild(panel);
    if (r.nutrition) body.appendChild(el('p', 'print-only vprint-nutri', 'Per serving (estimate): ' + nutritionLine(r.nutrition)));
    pill.addEventListener('click', function () {
      panel.hidden = !panel.hidden; pill.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) draw();
    });
    var pass = null;
    function draw() {
      panel.textContent = '';
      var n = r.nutrition;
      if (n) {
        var head = el('div', 'nutri-head');
        var cal = el('div', 'nutri-cal'); cal.appendChild(el('strong', null, String(Math.round(n.perServing.calories)))); cal.appendChild(el('span', null, 'calories'));
        head.appendChild(cal);
        head.appendChild(el('p', 'hint', 'Per serving, based on ' + n.servings + ' servings. An estimate from the ingredient list, not a lab measurement.'));
        panel.appendChild(head);
        var dl = el('dl', 'nutri-grid');
        NUTRI.forEach(function (x) { var d = el('div'); d.appendChild(el('dt', null, x[1])); d.appendChild(el('dd', null, n.perServing[x[0]] + ' ' + x[2])); dl.appendChild(d); });
        panel.appendChild(dl);
        if (n.assumptions && n.assumptions.length) {
          var det = el('details'); det.appendChild(el('summary', null, 'How this was estimated'));
          var ul = el('ul'); n.assumptions.forEach(function (a) { ul.appendChild(el('li', null, a)); }); det.appendChild(ul);
          panel.appendChild(det);
        }
      } else {
        panel.appendChild(el('p', null, 'Get an estimate of calories, protein, carbs, fat, fiber, sugar and sodium per serving. Claude works it out from the ingredient list, and it\'s saved with the recipe for both kitchens.'));
      }
      pass = passRow(panel, true);
      var status = el('p', 'status'); status.setAttribute('aria-live', 'polite');
      var go = btn(n ? 'linkish' : 'btn primary', n ? 'Estimate again' : 'Estimate nutrition');
      var br = el('div', 'btn-row'); br.appendChild(go); panel.appendChild(br); panel.appendChild(status);
      go.addEventListener('click', function () {
        if (pass.need()) { status.className = 'status error'; status.textContent = 'Enter the passcode, then tap ' + go.textContent + ' again.'; return; }
        go.disabled = true;
        var t0 = Date.now();
        status.className = 'status'; status.textContent = 'Claude is working it out… this takes about 20–40 seconds.';
        var tick = setInterval(function () { status.textContent = 'Claude is working it out… ' + Math.round((Date.now() - t0) / 1000) + ' sec'; }, 1000);
        helper('/nutrition', { passcode: pass.get(), person: PERSON, id: r.id }).then(function (j) {
          pass.ok();
          library.forEach(function (lr) { if (lr.id === r.id) lr.nutrition = j.nutrition; });
          r.nutrition = j.nutrition;
          pill.textContent = 'Nutrition · ' + Math.round(j.nutrition.perServing.calories) + ' cal';
          draw();
        }).catch(function (e) {
          if (e.status === 401) pass.bad();
          status.className = 'status error'; status.textContent = errText(e);
        }).then(function () { clearInterval(tick); go.disabled = false; });
      });
    }
  }

  // A step's text, with its times and temperatures wrapped so the printout can set them in bold
  // ("Sear 2–3 min per side", "Bake at 350°F"). On screen they look like the rest of the step.
  var KEY_RE = /\d+(?:\s?[½¼¾⅓⅔])?(?:\s*(?:–|-|to)\s*\d+(?:\s?[½¼¾⅓⅔])?)?\s*(?:minutes?|min|hours?|hrs?|seconds?|sec)\b|\d+\s?°F/g;
  function stepText(t) {
    var span = el('span', 'txt'), last = 0, m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(t))) {
      if (m.index > last) span.appendChild(document.createTextNode(t.slice(last, m.index)));
      span.appendChild(el('b', 'kp', m[0]));
      last = m.index + m[0].length;
    }
    if (last < t.length) span.appendChild(document.createTextNode(t.slice(last)));
    return span;
  }
  // The printout's photo sits just under the title block (the on-screen photo is above the facts).
  function syncPrintPhoto(body, src) {
    var fig = body.querySelector('.vprint-photo'), facts = body.querySelector('.vfacts');
    if (!src) { if (fig) fig.remove(); return; }
    if (!fig) { fig = el('figure', 'print-only vprint-photo'); fig.appendChild(el('img')); }
    body.insertBefore(fig, facts ? facts.nextSibling : body.firstChild);
    var img = fig.querySelector('img'); img.src = src; img.alt = '';
  }

  /* ---------- Recipe body (recipe view and add preview) ---------- */
  function renderRecipeBody(r, body, opts) {
    var interactive = opts.interactive;
    var saved = interactive ? (load('ek-check-' + r.id) || { i: [], s: [] }) : { i: [], s: [] };
    function save() { if (interactive) store('ek-check-' + r.id, saved); }
    body.appendChild(el(opts.headingTag || 'h1', 'vtitle', r.title));
    body.appendChild(tagsFor(r));
    if (interactive) photoBlock(r, body);
    var facts = [['Serves', r.servings], ['Prep', r.prep], ['Cook', r.cook], ['Total', r.total]].filter(function (f) { return f[1]; });
    var servesDd = null;
    if (facts.length) {
      var fg = el('dl', 'vfacts');
      facts.forEach(function (f) {
        var d = el('div'), dd = el('dd', null, f[1]); if (f[0] === 'Serves') servesDd = dd;
        d.appendChild(el('dt', null, f[0])); d.appendChild(dd); fg.appendChild(d);
      });
      body.appendChild(fg);
    }
    if (interactive) nutritionBlock(r, body);
    if (opts.panel) opts.panel(body);
    if (r.blurb) {
      var note = el('p', 'vnote');
      note.appendChild(el('b', null, blurbLabel(r)));
      note.appendChild(document.createTextNode(r.blurb));
      if (CONF_NOTE[r.confidence]) note.appendChild(el('span', 'conf', CONF_NOTE[r.confidence]));
      body.appendChild(note);
    }
    if (r.equipment && r.equipment.length) {
      var eh = el('div', 'vhead'); eh.appendChild(el('h2', null, 'Equipment')); body.appendChild(eh);
      var eq = el('ul', 'vequip'); r.equipment.forEach(function (x) { eq.appendChild(el('li', null, x)); }); body.appendChild(eq);
    }
    var nItems = r.ingredients.reduce(function (n, g) { return n + g.items.length; }, 0);
    var ih = el('div', 'vhead'), ihh = el('h2', null, 'Ingredients');
    ihh.appendChild(el('span', 'vcount', ' (' + nItems + ')')); ih.appendChild(ihh);
    var resetBtn = null;
    if (interactive) { resetBtn = btn(null, 'Uncheck all'); ih.appendChild(resetBtn); }
    body.appendChild(ih);
    // How much to make: changes the ingredient amounts and the Serves line, remembered per recipe.
    var scaleRow = null, scaleNote = null, itemSpans = [];
    if (interactive) {
      scaleRow = el('div', 'scale');
      scaleRow.setAttribute('role', 'group'); scaleRow.setAttribute('aria-label', 'How much to make');
      scaleRow.appendChild(el('span', 'scale-label', 'Make'));
      var pills = [[0.5, '½×'], [1, '1×'], [1.5, '1½×'], [2, '2×'], [3, '3×']].map(function (p) {
        var b = btn('pill', p[1]); b.setAttribute('data-f', p[0]);
        b.addEventListener('click', function () { setScale(p[0]); });
        scaleRow.appendChild(b); return b;
      });
      var other = el('input'); other.type = 'number'; other.inputMode = 'decimal'; other.min = '0.1'; other.max = '20'; other.step = 'any';
      other.placeholder = 'Other'; other.className = 'scale-other'; other.setAttribute('aria-label', 'Other amount, like 0.75 or 4');
      other.addEventListener('change', function () { var v = parseFloat(other.value); if (v > 0 && v <= 20) setScale(v); });
      scaleRow.appendChild(other);
      body.appendChild(scaleRow);
    }
    var idx = 0, boxes = [];
    r.ingredients.forEach(function (g) {
      if (g.group) body.appendChild(el('h3', 'vgroup', g.group));
      var ul = el('ul', 'checks');
      g.items.forEach(function (it) {
        var k = idx++;
        var li = el('li'), lab = el('label'), cb = el('input');
        cb.type = 'checkbox'; cb.checked = saved.i.indexOf(k) !== -1; boxes.push(cb);
        if (!interactive) cb.disabled = true;
        cb.addEventListener('change', function () {
          saved.i = saved.i.filter(function (x) { return x !== k; }); if (cb.checked) saved.i.push(k); save();
        });
        var sp = el('span', null, it); sp._orig = it; itemSpans.push(sp);
        lab.appendChild(cb); lab.appendChild(sp); li.appendChild(lab); ul.appendChild(li);
      });
      body.appendChild(ul);
    });
    if (interactive) {
      scaleNote = el('p', 'vhint scale-note'); body.appendChild(scaleNote);
      var setScale = function (f) {
        f = Math.round(f * 100) / 100;
        if (f === 1) forget('ek-scale-' + r.id); else store('ek-scale-' + r.id, f);
        itemSpans.forEach(function (sp) { sp.textContent = scaleText(sp._orig, f); });
        if (servesDd) servesDd.textContent = scaleText(r.servings, f);
        var preset = false;
        pills.forEach(function (b) { var on = +b.getAttribute('data-f') === f; if (on) preset = true; b.setAttribute('aria-pressed', String(on)); });
        other.value = preset ? '' : String(f);
        other.classList.toggle('on', !preset);
        scaleNote.hidden = f === 1;
        scaleNote.textContent = 'Ingredient amounts and servings are scaled ' + fmtNum(f) + '×. Amounts in the steps, pan sizes and cook times are as written; a bigger batch may need a larger pan or a few more minutes.';
      };
      setScale(load('ek-scale-' + r.id) || 1);
    }
    var sh = el('div', 'vhead'); sh.appendChild(el('h2', null, 'Steps')); body.appendChild(sh);
    var ol = el('ol', 'vsteps'), stepBtns = [];
    r.steps.forEach(function (t, k) {
      var li = el('li'), b = btn('step');
      b.setAttribute('aria-pressed', String(saved.s.indexOf(k) !== -1));
      b.appendChild(el('span', 'num', String(k + 1))); b.appendChild(stepText(t));
      if (interactive) b.addEventListener('click', function () {
        var on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on));
        saved.s = saved.s.filter(function (x) { return x !== k; }); if (on) saved.s.push(k); save();
      });
      stepBtns.push(b); li.appendChild(b); ol.appendChild(li);
    });
    body.appendChild(ol);
    if (r.tips && r.tips.length) {
      var tb = el('div', 'vbox'); tb.appendChild(el('h3', null, 'Tips'));
      var tl = el('ul'); r.tips.forEach(function (x) { tl.appendChild(el('li', null, x)); }); tb.appendChild(tl);
      body.appendChild(tb);
    }
    if (r.storage) {
      var sb = el('div', 'vbox'); sb.appendChild(el('h3', null, 'Leftovers')); sb.appendChild(el('p', null, r.storage));
      body.appendChild(sb);
    }
    if (r.credit) body.appendChild(el('p', 'vcredit', 'Source: ' + r.credit));
    if (interactive) {
      body.appendChild(el('p', 'vhint', 'Tap an ingredient or a step to check it off. Your checkmarks stay on this device until you uncheck them.'));
      resetBtn.addEventListener('click', function () {
        saved = { i: [], s: [] }; save();
        boxes.forEach(function (c) { c.checked = false; });
        stepBtns.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      });
    }
  }

  /* ---------- Recipe photo (one per recipe, shared by every kitchen) ---------- */
  var localPhotos = {}; // just-saved photos, shown from this device until the site rebuild publishes them
  function photoSrc(r) { return localPhotos[r.id] || (r.photo ? ROOT + r.photo : null); }
  function photoBlock(r, body) {
    var wrap = el('div', 'vphoto-wrap'), shown = el('div'), tools = el('div', 'photo-tools');
    var file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    wrap.appendChild(shown); wrap.appendChild(tools); wrap.appendChild(file);
    var pass = passRow(wrap, true);
    var status = el('p', 'status'); status.setAttribute('aria-live', 'polite'); wrap.appendChild(status);
    body.appendChild(wrap);
    var pending = null, retry = null, sure = false;

    function setStatus(msg, isErr) { status.textContent = msg; status.className = 'status' + (isErr ? ' error' : ''); }
    function draw() {
      shown.textContent = ''; tools.textContent = '';
      var src = pending ? pending.preview : photoSrc(r);
      if (src) {
        var fig = el('figure', 'vphoto'), img = el('img');
        img.src = src; img.alt = 'Photo of ' + r.title;
        fig.appendChild(img); shown.appendChild(fig);
      }
      if (retry) {
        var save = btn('btn primary', pending ? 'Save photo' : 'Remove photo');
        save.addEventListener('click', retry); tools.appendChild(save);
      }
      var pick = btn('linkish', src ? 'Change photo' : 'Add a photo of this dish');
      pick.addEventListener('click', function () { file.click(); });
      tools.appendChild(pick);
      if (src && !pending) {
        var adj = btn('linkish', 'Adjust framing');
        adj.addEventListener('click', function () { frame(src); });
        tools.appendChild(adj);
      }
      if (src && !pending) {
        var rm = btn('linkish', sure ? 'Tap again to remove the photo' : 'Remove photo');
        rm.addEventListener('click', function () {
          if (!sure) { sure = true; draw(); return; }
          sure = false; send(null);
        });
        tools.appendChild(rm);
      }
    }
    function send(image) {
      pending = image;
      retry = function () { send(image); };
      draw();
      if (pass.need()) { setStatus('Enter the passcode, then tap ' + (image ? 'Save photo.' : 'Remove photo.'), true); return; }
      setStatus(image ? 'Saving the photo…' : 'Removing the photo…');
      helper('/photo', { passcode: pass.get(), person: PERSON, id: r.id, image: image ? { media_type: image.media_type, data: image.data } : null })
        .then(function (j) {
          pass.ok();
          if (image) localPhotos[r.id] = image.preview; else delete localPhotos[r.id];
          library.forEach(function (lr) { if (lr.id === r.id) lr.photo = j.photo; });
          pending = null; retry = null;
          refresh(); r = byId[r.id];
          draw();
          syncPrintPhoto(body, photoSrc(r));
          setStatus(image ? 'Saved. Everyone will see it on the site in a minute or two.' : 'Photo removed.');
        })
        .catch(function (e) {
          if (e.status === 401) pass.bad();
          setStatus(errText(e), true);
        });
    }
    function frame(source) {
      setStatus('');
      cropImage(source).then(function (im) { if (im) send(im); })
        .catch(function (e) { setStatus(e.message, true); });
    }
    file.addEventListener('change', function () {
      var f = file.files[0]; file.value = '';
      if (f) frame(f);
    });
    draw();
  }

  // This kitchen's own note on a recipe, shown above the ingredients on screen and on paper.
  function syncNote(body, r) {
    var box = body.querySelector('.vmynote');
    if (!r.myNote) { if (box) box.remove(); return; }
    if (!box) { box = el('div', 'vnote vmynote'); body.insertBefore(box, body.querySelector('.vhead')); }
    box.textContent = '';
    box.appendChild(el('b', null, 'My note'));
    box.appendChild(document.createTextNode(r.myNote));
  }

  /* ---------- "My box" panel inside a recipe ---------- */
  function boxPanel(r) {
    return function (body) {
      var panel = el('section', 'mybox');
      panel.setAttribute('aria-label', person.name + "'s box");
      body.appendChild(panel);
      draw();

      function act(op, extra, statusEl, done) {
        if (pass.need()) { statusEl.className = 'status error'; statusEl.textContent = 'Enter the passcode first.'; return; }
        statusEl.className = 'status'; statusEl.textContent = 'Saving…';
        helper('/box', Object.assign({ passcode: pass.get(), person: PERSON, id: r.id, op: op }, extra || {}))
          .then(function (j) {
            pass.ok();
            person.box = person.box.filter(function (b) { return b.id !== r.id; });
            if (j.entry) {
              var at = person.box.length;
              if (r.entry) { var old = r._order; at = Math.min(old, person.box.length); }
              person.box.splice(at, 0, j.entry);
            }
            if (j.updated) person.updated = j.updated;
            refresh();
            r = byId[r.id];
            if (op === 'note') { noteDraft = null; sentNote = null; }
            syncNote(body, r);
            if (done) done();
            draw();
          })
          .catch(function (e) {
            if (op === 'note') sentNote = null;
            if (e.status === 401) pass.bad();
            statusEl.className = 'status error'; statusEl.textContent = errText(e);
          });
      }

      var pass;
      // Typed-but-unsaved note text survives redraws (like after tapping Made it), and is saved on its own.
      var noteDraft = null, sentNote = null;
      function draw() {
        panel.textContent = '';
        var head = el('div', 'mybox-head');
        head.appendChild(el('h2', null, person.name + "'s box"));
        panel.appendChild(head);
        var status = el('p', 'status'); status.setAttribute('aria-live', 'polite');

        if (!r.inBox) {
          panel.appendChild(el('p', null, 'This recipe is in the whole library but not in ' + person.name + "'s box."));
          var f = el('div', 'field');
          var sid = 'sec-' + r.id;
          var l = el('label', null, 'Section'); l.htmlFor = sid;
          var s = el('select'); s.id = sid;
          person.sections.forEach(function (x) { var o = el('option', null, x.title); o.value = x.id; s.appendChild(o); });
          f.appendChild(l); f.appendChild(s); panel.appendChild(f);
          pass = passRow(panel);
          var addB = btn('btn primary', 'Add to ' + person.name + "'s box");
          addB.addEventListener('click', function () { act('add', { section: s.value }, status); });
          var addMadeB = btn('btn', 'Add as already made');
          addMadeB.addEventListener('click', function () {
            act('add', { section: s.value }, status, function () { act('madebefore', { date: '' }, status); });
          });
          var row = el('div', 'btn-row'); row.appendChild(addB); row.appendChild(addMadeB); panel.appendChild(row);
          panel.appendChild(status);
          return;
        }

        var e = r.entry;
        var madeLine = e.made.count ? madeLabel(e.made.count) + (e.made.log.length ? ' · last ' + e.made.log[e.made.log.length - 1] : '') : 'Not made yet';
        panel.appendChild(el('p', 'mybox-made', madeLine));

        pass = passRow(panel);

        var row1 = el('div', 'btn-row');
        var madeB = btn('btn primary', 'Made it today');
        madeB.addEventListener('click', function () { act('made', { date: fmtDate(new Date()) }, status); });
        row1.appendChild(madeB);
        // For recipes made in the past: counts as made, with a date only if you know it.
        var beforeB = btn('btn', 'Made it before');
        beforeB.setAttribute('aria-expanded', 'false');
        row1.appendChild(beforeB);
        var before = el('div', 'field made-before'); before.hidden = true;
        var bid = 'before-' + r.id;
        var bl = el('label', null, 'When did you make it?'); bl.htmlFor = bid;
        var bd = el('input'); bd.type = 'date'; bd.id = bid;
        var now = new Date(); bd.max = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        before.appendChild(bl); before.appendChild(bd);
        before.appendChild(el('span', 'hint', "Leave it blank if you don't remember. It still counts as made."));
        var brow = el('div', 'btn-row');
        var bsave = btn('btn primary', 'Save'), bcancel = btn('linkish', 'Cancel');
        brow.appendChild(bsave); brow.appendChild(bcancel); before.appendChild(brow);
        beforeB.addEventListener('click', function () {
          before.hidden = !before.hidden; beforeB.setAttribute('aria-expanded', String(!before.hidden));
          if (!before.hidden) bd.focus();
        });
        bcancel.addEventListener('click', function () { before.hidden = true; beforeB.setAttribute('aria-expanded', 'false'); beforeB.focus(); });
        bsave.addEventListener('click', function () { act('madebefore', { date: bd.value || '' }, status); });
        if (e.made.count) {
          var undo = btn('btn', 'Undo last');
          undo.addEventListener('click', function () { act('unmade', null, status); });
          row1.appendChild(undo);
        }
        panel.appendChild(row1);
        panel.appendChild(before);

        // Tags
        var tf = el('div', 'field');
        tf.appendChild(el('span', 'flabel-lg', 'Tags'));
        var tagsWrap = el('div', 'tags editable');
        (e.tags || []).forEach(function (t) {
          var c = el('span', 'tag mine', t + ' ');
          var x = btn('tagx', '×'); x.setAttribute('aria-label', 'Remove tag ' + t);
          x.addEventListener('click', function () { act('tags', { tags: e.tags.filter(function (y) { return y !== t; }) }, status); });
          c.appendChild(x); tagsWrap.appendChild(c);
        });
        if (!e.tags.length) tagsWrap.appendChild(el('span', 'hint', 'No tags yet.'));
        tf.appendChild(tagsWrap);
        var suggestions = allTags().filter(function (t) { return !e.tags.some(function (y) { return norm(y) === norm(t); }); });
        if (suggestions.length) {
          var sug = el('div', 'tags');
          suggestions.forEach(function (t) {
            var b = btn('tag add', '+ ' + t);
            b.addEventListener('click', function () { act('tags', { tags: e.tags.concat([t]) }, status); });
            sug.appendChild(b);
          });
          tf.appendChild(sug);
        }
        var nt = el('div', 'inline');
        var tid = 'tag-' + r.id;
        var ti = el('input'); ti.type = 'text'; ti.id = tid; ti.placeholder = 'New tag, like date night'; ti.maxLength = 30;
        ti.setAttribute('aria-label', 'New tag');
        var tb = btn('btn', 'Add tag');
        function addTag() { var v = ti.value.trim(); if (!v) { ti.focus(); return; } act('tags', { tags: e.tags.concat([v]) }, status); }
        tb.addEventListener('click', addTag);
        ti.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addTag(); } });
        nt.appendChild(ti); nt.appendChild(tb); tf.appendChild(nt);
        panel.appendChild(tf);

        // Note
        var nf = el('div', 'field');
        var nid = 'note-' + r.id;
        var nl = el('label', null, 'My note'); nl.htmlFor = nid;
        var na = el('textarea'); na.id = nid; na.rows = 2; na.maxLength = 1000; na.placeholder = 'Like: double the garlic';
        na.value = noteDraft != null ? noteDraft : (e.note || '');
        var ns = btn('btn', 'Save note');
        var saveNote = function () {
          var v = na.value.trim();
          if (v === (e.note || '') || v === sentNote) return;
          sentNote = v; act('note', { note: v }, status);
        };
        na.addEventListener('input', function () { noteDraft = na.value; });
        na.addEventListener('change', saveNote); // tapping outside the box saves it
        ns.addEventListener('click', saveNote);
        nf.appendChild(nl); nf.appendChild(na);
        nf.appendChild(el('span', 'hint', 'Saves when you tap Save note or tap outside the box. It shows at the top of this recipe and on its card.'));
        var nr = el('div', 'btn-row'); nr.appendChild(ns); nf.appendChild(nr);
        panel.appendChild(nf);

        // Section + remove
        var sf = el('div', 'field');
        var sid2 = 'sec2-' + r.id;
        var sl = el('label', null, 'Section'); sl.htmlFor = sid2;
        var ss = el('select'); ss.id = sid2;
        person.sections.forEach(function (x) { var o = el('option', null, x.title); o.value = x.id; if (x.id === e.section) o.selected = true; ss.appendChild(o); });
        ss.addEventListener('change', function () { act('section', { section: ss.value }, status); });
        sf.appendChild(sl); sf.appendChild(ss); panel.appendChild(sf);

        var rm = btn('linkish', 'Remove from ' + person.name + "'s box");
        rm.addEventListener('click', function () {
          if (rm.getAttribute('data-sure') !== '1') { rm.setAttribute('data-sure', '1'); rm.textContent = 'Tap again to remove. It stays in the whole library.'; return; }
          act('remove', null, status);
        });
        panel.appendChild(rm);
        panel.appendChild(status);
      }
    };
  }

  /* ---------- Recipe editor (a saved recipe, or a new one before it's saved) ---------- */
  var PROTEIN_IDS = ['chicken', 'beef', 'pork', 'seafood', 'eggs', 'meatless'];
  function lines(s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
  // opts: { saveLabel, onSave(recipe, ui) -> Promise, onCancel(), askClaude, notice }
  function recipeForm(host, r, opts) {
    host.textContent = '';
    var uid = Math.random().toString(36).slice(2, 7), n = 0;
    var form = el('form', 'editor'); form.noValidate = true;
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    if (opts.notice) form.appendChild(opts.notice);
    function field(label, input, hint, parent) {
      var f = el('div', 'field'), id = 'ed-' + uid + '-' + (++n);
      input.id = id; var l = el('label', null, label); l.htmlFor = id;
      f.appendChild(l); f.appendChild(input); if (hint) f.appendChild(el('span', 'hint', hint));
      (parent || form).appendChild(f); return input;
    }
    function text(v, ph) { var i = el('input'); i.type = 'text'; i.value = v || ''; if (ph) i.placeholder = ph; return i; }
    function area(v, rows, ph) { var t = el('textarea'); t.rows = rows; t.value = v || ''; if (ph) t.placeholder = ph; return t; }
    function checks(legend) { var fs = el('fieldset', 'field echecks'); fs.appendChild(el('legend', null, legend)); form.appendChild(fs); return fs; }
    function check(fs, label, on) {
      var l = el('label', 'echeck'), c = el('input'); c.type = 'checkbox'; c.checked = !!on;
      l.appendChild(c); l.appendChild(el('span', null, label)); fs.appendChild(l); return c;
    }

    var title = field('Recipe name', text(r.title));
    var pfs = checks('Protein'), pBoxes = {};
    PROTEIN_IDS.forEach(function (p) { pBoxes[p] = check(pfs, LABEL[p], (r.proteins || []).indexOf(p) !== -1); });
    var sfs = checks('Style');
    var slow = check(sfs, 'Slow cooker', r.slowCooker), cozy = check(sfs, 'Warm & cozy', r.cozy);
    var grid = el('div', 'egrid'); form.appendChild(grid);
    var servings = field('Serves', text(r.servings, '4 servings'), null, grid);
    var prep = field('Prep', text(r.prep, '15 min'), null, grid);
    var cook = field('Cook', text(r.cook, '30 min'), null, grid);
    var total = field('Total', text(r.total, '45 min'), null, grid);
    var equipment = field('Equipment', area((r.equipment || []).join('\n'), 4, '12-inch skillet'), 'One item per line.');

    var ing = el('fieldset', 'field egroups'); ing.appendChild(el('legend', null, 'Ingredients'));
    ing.appendChild(el('span', 'hint', 'One ingredient per line. Use more than one group for parts like a sauce or toppings.'));
    var groupList = el('div', 'egroup-list'); ing.appendChild(groupList);
    var groups = [];
    function addGroup(g) {
      var box = el('div', 'egroup');
      var name = text(g.group || '', groups.length ? 'Group name, like Sauce or To serve' : 'Group name (optional)');
      name.setAttribute('aria-label', 'Ingredient group name');
      var items = area((g.items || []).join('\n'), Math.min(14, Math.max(4, (g.items || []).length + 1)));
      items.setAttribute('aria-label', 'Ingredients in this group, one per line');
      var rm = btn('linkish', 'Remove this group');
      var entry = { name: name, items: items };
      rm.addEventListener('click', function () {
        if (groups.length === 1) { name.value = ''; items.value = ''; return; }
        groups.splice(groups.indexOf(entry), 1); box.remove();
      });
      box.appendChild(name); box.appendChild(items); box.appendChild(rm);
      groupList.appendChild(box); groups.push(entry);
      return entry;
    }
    (r.ingredients && r.ingredients.length ? r.ingredients : [{ group: null, items: [] }]).forEach(addGroup);
    var addG = btn('btn', '+ Add a group');
    addG.addEventListener('click', function () { addGroup({ group: '', items: [] }).name.focus(); });
    ing.appendChild(addG); form.appendChild(ing);

    var steps = field('Steps', area((r.steps || []).join('\n\n'), 12), 'Each line is one step. Blank lines between steps are fine.');
    var tips = field('Tips', area((r.tips || []).join('\n\n'), 4), 'Each line is one tip. Optional.');
    var storage = field('Leftovers', area(r.storage, 3, 'Fridge up to 4 days. Reheat...'));
    var credit = field('Source', text(r.credit, "Like: Grandma's card, or a website name"), 'Optional.');

    // A passcode typed in just for this editor (opts.passcode) is used as is and never remembered.
    var pass = opts.passcode ? {
      get: function () { return opts.passcode; }, ok: function () {}, need: function () { return false; },
      bad: function () { setStatus('That passcode stopped working. Go back to the recipe and open the editor again.', true); }
    } : passRow(form, true);
    var status = el('p', 'status'); status.setAttribute('aria-live', 'polite');
    function setStatus(msg, isErr) { status.textContent = msg; status.className = 'status' + (isErr ? ' error' : ''); }

    function read() {
      return {
        title: title.value.trim(),
        proteins: PROTEIN_IDS.filter(function (p) { return pBoxes[p].checked; }),
        slowCooker: slow.checked, cozy: cozy.checked,
        servings: servings.value.trim(), prep: prep.value.trim(), cook: cook.value.trim(), total: total.value.trim(),
        equipment: lines(equipment.value),
        ingredients: groups.map(function (g) { return { group: g.name.value.trim() || null, items: lines(g.items.value) }; })
          .filter(function (g) { return g.items.length; }),
        steps: lines(steps.value), tips: lines(tips.value),
        storage: storage.value.trim().replace(/\s*\n\s*/g, ' '),
        credit: credit.value.trim() || null
      };
    }
    function problems(x) {
      var miss = [];
      if (!x.title) miss.push([title, 'a recipe name']);
      if (!x.proteins.length) miss.push([pBoxes.meatless, 'a protein (Meatless if none)']);
      [[servings, 'Serves'], [prep, 'Prep'], [cook, 'Cook'], [total, 'Total']].forEach(function (f) { if (!f[0].value.trim()) miss.push([f[0], f[1]]); });
      if (!x.ingredients.length) miss.push([groups[0].items, 'at least one ingredient']);
      if (!x.steps.length) miss.push([steps, 'at least one step']);
      if (!x.storage) miss.push([storage, 'leftovers']);
      return miss;
    }

    if (opts.askClaude) {
      var askWrap = el('div', 'vbox easky');
      askWrap.appendChild(el('h3', null, 'Or ask Claude to change it'));
      var ask = field('What should change?', area('', 2, 'Like: make it for 2 people, or add an air fryer option'), 'Claude rewrites the form below. Nothing is saved until you tap ' + opts.saveLabel + '.', askWrap);
      var askBtn = btn('btn', 'Ask Claude');
      var ar = el('div', 'btn-row'); ar.appendChild(askBtn); askWrap.appendChild(ar);
      form.insertBefore(askWrap, opts.notice ? opts.notice.nextSibling : form.firstChild);
      askBtn.addEventListener('click', function () {
        if (!ask.value.trim()) { ask.focus(); return; }
        if (pass.need()) { setStatus('Enter the passcode, then tap Ask Claude again.', true); return; }
        askBtn.disabled = true;
        var t0 = Date.now(), tick = setInterval(function () { askBtn.textContent = 'Claude is working… ' + Math.round((Date.now() - t0) / 1000) + ' sec'; }, 1000);
        helper('/parse', { passcode: pass.get(), person: PERSON, previous: read(), fix: ask.value.trim(), sections: person.sections.map(function (s) { return { id: s.id, title: s.title }; }) })
          .then(function (j) {
            pass.ok();
            var note = el('div', 'vbox warn');
            note.appendChild(el('h3', null, 'Claude changed the form. Check it, then tap ' + opts.saveLabel + '.'));
            if (j.assumptions && j.assumptions.length) { var ul = el('ul'); j.assumptions.forEach(function (a) { ul.appendChild(el('li', null, a)); }); note.appendChild(ul); }
            recipeForm(host, j.recipe, Object.assign({}, opts, { notice: note }));
            host.scrollIntoView({ block: 'start' });
          })
          .catch(function (e) { if (e.status === 401) pass.bad(); setStatus(errText(e), true); })
          .then(function () { clearInterval(tick); askBtn.disabled = false; askBtn.textContent = 'Ask Claude'; });
      });
    }

    var row = el('div', 'btn-row');
    var save = btn('btn primary', opts.saveLabel), cancel = btn('btn', 'Cancel');
    row.appendChild(save); row.appendChild(cancel);
    form.appendChild(row); form.appendChild(status);
    cancel.addEventListener('click', function () { opts.onCancel(); });
    save.addEventListener('click', function () {
      var x = read(), miss = problems(x);
      if (miss.length) { setStatus('Still needed: ' + miss.map(function (m) { return m[1]; }).join(', ') + '.', true); miss[0][0].focus(); return; }
      save.disabled = true;
      opts.onSave(x, { pass: pass, setStatus: setStatus }).catch(function (e) {
        if (e.status === 401) pass.bad();
        setStatus(errText(e), true);
      }).then(function () { save.disabled = false; });
    });
    host.appendChild(form);
    // Text boxes grow to fit, so long ingredient lists and steps don't scroll inside a small box.
    function grow(t) {
      if (!t.offsetParent) return; // not on screen yet; measuring now would collapse it
      t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px';
    }
    setTimeout(function () { Array.prototype.forEach.call(form.querySelectorAll('textarea'), grow); }, 0);
    form.addEventListener('input', function (e) { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
    return form;
  }

  var flash = null; // a one-time message shown at the top of the next recipe opened
  function openEditor(r) {
    current = r;
    viewer.textContent = '';
    var b = el('div', 'vbar');
    var back = btn('vback', '← Back to recipe');
    function toRecipe() { location.hash = 'r-' + r.id; }
    back.addEventListener('click', toRecipe);
    b.appendChild(back); b.appendChild(homeButton()); viewer.appendChild(b);
    var body = el('article', 'vbody');
    body.appendChild(el('span', 'eyebrow', 'Edit recipe'));
    body.appendChild(el('h1', 'vtitle', r.title));
    body.appendChild(el('p', 'vhint', "Changes go into the shared library, so they show in every kitchen. Your box, tags, notes and photo stay as they are."));
    var host = el('div'); body.appendChild(host);
    viewer.appendChild(body);

    // Editing always asks for the passcode, even on a device that remembers it for other changes.
    var gate = el('form', 'editor egate'); gate.noValidate = true;
    var gf = el('div', 'field');
    var gl = el('label', null, person.name + "'s passcode"); gl.htmlFor = 'edit-pass';
    var gi = el('input'); gi.type = 'password'; gi.id = 'edit-pass'; gi.autocomplete = 'current-password';
    gf.appendChild(gl); gf.appendChild(gi);
    gf.appendChild(el('span', 'hint', 'Editing asks for the passcode every time, and this device doesn\'t keep it.'));
    gate.appendChild(gf);
    var go = btn('btn primary', 'Start editing'); go.type = 'submit';
    var cancel = btn('btn', 'Cancel'); cancel.addEventListener('click', toRecipe);
    var gr = el('div', 'btn-row'); gr.appendChild(go); gr.appendChild(cancel); gate.appendChild(gr);
    var gs = el('p', 'status'); gs.setAttribute('aria-live', 'polite'); gate.appendChild(gs);
    host.appendChild(gate);
    function gateErr(msg) { gs.className = 'status error'; gs.textContent = msg; gi.select(); gi.focus(); }
    gate.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = gi.value.trim();
      if (!code) { gateErr('Enter the passcode first.'); return; }
      go.disabled = true; gs.className = 'status'; gs.textContent = 'Checking…';
      helper('/check', { passcode: code }).then(function (j) {
        if (j.person !== PERSON) { gateErr("That isn't " + person.name + "'s passcode."); return; }
        openForm(code);
      }).catch(function (err) {
        gateErr(err.status === 401 ? "That passcode didn't work." : errText(err));
      }).then(function () { go.disabled = false; });
    });

    function openForm(code) {
      recipeForm(host, r, {
        saveLabel: 'Save changes', askClaude: true, onCancel: toRecipe, passcode: code,
        onSave: function (x, ui) {
          ui.setStatus('Saving…');
          return helper('/edit', { passcode: code, person: PERSON, id: r.id, recipe: x }).then(function (j) {
            library.forEach(function (lr, i) { if (lr.id === r.id) library[i] = j.recipe; });
            refresh();
            flash = j.changed ? 'Saved. It shows here now; everyone else sees the change in a minute or two.' : 'Nothing had changed, so there was nothing to save.';
            toRecipe();
          });
        }
      });
      var first = host.querySelector('textarea, input');
      if (first) first.focus({ preventScroll: true });
    }

    show('viewer');
    document.title = 'Edit ' + r.title + ' · ' + person.title;
    window.scrollTo(0, 0);
    gi.focus({ preventScroll: true });
  }

  /* ---------- Recipe view ---------- */
  var wakeLock = null, wantWake = false;
  function setWake(on) {
    wantWake = on;
    var b = $('wake'); if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Screen stays on' : 'Keep screen on'; }
    if (on) navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
    }).catch(function () { wantWake = false; var b2 = $('wake'); if (b2) { b2.setAttribute('aria-pressed', 'false'); b2.textContent = 'Keep screen on'; } });
    else if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (wantWake && document.visibilityState === 'visible' && !viewer.hidden) setWake(true);
  });
  var HOUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>';
  function homeButton() {
    var b = btn('vback vhome');
    b.innerHTML = HOUSE + '<span>Home</span>';
    b.title = person.title + ' home';
    b.addEventListener('click', goHome);
    return b;
  }
  function bar(target) {
    var b = el('div', 'vbar');
    var home = homeButton();
    b.appendChild(home);
    target.appendChild(b);
    return { bar: b, back: home };
  }
  function show(which) {
    main.hidden = which !== 'main'; viewer.hidden = which !== 'viewer'; adder.hidden = which !== 'adder';
  }
  function openRecipe(r) {
    current = r;
    viewer.textContent = '';
    var top = bar(viewer);
    var right = el('div', 'vbar-right'); top.bar.appendChild(right);
    var pr = btn('wake vprint-btn');
    pr.setAttribute('aria-label', 'Print this recipe');
    pr.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg><span class="lbl">Print</span>';
    pr.addEventListener('click', function () { window.print(); });
    right.appendChild(pr);
    if ('wakeLock' in navigator) {
      var w = btn('wake', wantWake ? 'Screen stays on' : 'Keep screen on'); w.id = 'wake';
      w.setAttribute('aria-pressed', String(wantWake));
      w.addEventListener('click', function () { setWake(!wantWake); });
      right.appendChild(w);
      // The lock is released when a recipe closes; if it was on, take it again for this one.
      if (wantWake && !wakeLock) setWake(true);
    }
    var body = el('article', 'vbody');
    var sec = r.section ? sectionById(r.section) : null;
    var vtop = el('div', 'vtop');
    vtop.appendChild(el('span', 'eyebrow', r.inBox ? (person.name + "'s box" + (sec ? ' · ' + sec.title : '')) : 'Whole library'));
    var editTop = el('a', 'linkish', 'Edit recipe'); editTop.href = '#e-' + r.id;
    vtop.appendChild(editTop); body.appendChild(vtop);
    if (flash) { body.appendChild(el('p', 'status saved', flash)); flash = null; }
    renderRecipeBody(r, body, { interactive: true, panel: boxPanel(r) });
    var editRow = el('div', 'btn-row vedit');
    var editBtn = el('a', 'btn', 'Edit this recipe'); editBtn.href = '#e-' + r.id;
    editRow.appendChild(editBtn); body.appendChild(editRow);
    // Only on paper: this person's own note, and where the printout came from.
    syncNote(body, r);
    syncPrintPhoto(body, photoSrc(r));
    var titleEl = body.querySelector('.vtitle');
    body.insertBefore(el('p', 'print-only vprint-from', person.title + ' · printed ' + fmtDate(new Date())), titleEl);
    var foot = el('div', 'vfoot'); foot.appendChild(homeButton()); body.appendChild(foot);
    viewer.appendChild(body);
    show('viewer');
    document.title = r.title + ' · ' + person.title;
    window.scrollTo(0, 0);
    top.back.focus({ preventScroll: true });
  }
  function closeViews() {
    current = null;
    if (main.hidden === false) return;
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
    viewer.textContent = '';
    show('main');
    document.title = person.title;
    window.scrollTo({ top: listScroll, behavior: 'auto' });
  }
  // Home always lands on this kitchen's main page, never just one step back: at the spot you left
  // the list if you came from it, otherwise at the top.
  function goHome() {
    if (!openedFromList) listScroll = 0;
    if (location.hash.length > 1) history.pushState(null, '', location.pathname + location.search);
    route();
  }
  function route() {
    var h = location.hash.slice(1);
    if (h.indexOf('r-') === 0 && byId[h.slice(2)]) openRecipe(byId[h.slice(2)]);
    else if (h.indexOf('e-') === 0 && byId[h.slice(2)]) openEditor(byId[h.slice(2)]);
    else if (h === 'add') openAdd();
    else { closeViews(); openedFromList = false; }
  }
  window.addEventListener('hashchange', route);

  /* ---------- Add a recipe ---------- */
  var add = { images: [], pdf: null, parsed: null, busy: false };

  function shrink(file, max, quality) {
    max = max || 1600; quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var dataUrl = c.toDataURL('image/jpeg', quality);
        resolve({ media_type: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file couldn't be read as an image.")); };
      img.src = url;
    });
  }

  // A framing window for recipe photos: the photo moves and zooms under a fixed 4:3 frame (drag,
  // pinch, scroll wheel, slider, or arrow and +/- keys). Resolves with the framed JPEG, or null if
  // cancelled. The site shows recipe photos at 4:3, so what's in the frame is exactly what shows.
  function cropImage(source) {
    return new Promise(function (resolve, reject) {
      var isUrl = typeof source === 'string';
      var url = isUrl ? source : URL.createObjectURL(source);
      var img = new Image();
      img.onload = function () { open(); };
      img.onerror = function () { if (!isUrl) URL.revokeObjectURL(url); reject(new Error("That file couldn't be read as an image.")); };
      img.src = url;

      function open() {
        var nw = img.naturalWidth, nh = img.naturalHeight;
        var back = document.activeElement;
        var modal = el('div', 'crop-modal');
        var card = el('div', 'crop-card');
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'crop-title');
        var h = el('h2', null, 'Frame the food'); h.id = 'crop-title'; card.appendChild(h);
        card.appendChild(el('p', 'hint', 'It starts with the whole photo. Pinch, scroll or use the slider to zoom in, and drag to move. What is inside the frame is what shows on the recipe; any empty space is filled with a soft blur of the photo.'));
        var stage = el('div', 'crop-stage'); stage.tabIndex = 0;
        stage.setAttribute('aria-label', 'Photo frame. Arrow keys move the photo, plus and minus zoom.');
        var blur = el('img', 'crop-bg'); blur.src = url; blur.alt = ''; blur.draggable = false;
        img.className = 'crop-img'; img.alt = ''; img.draggable = false;
        img.style.width = nw + 'px'; img.style.height = nh + 'px';
        stage.appendChild(blur); stage.appendChild(img); stage.appendChild(el('div', 'crop-grid'));
        card.appendChild(stage);
        var zl = el('label', 'crop-zoom'); zl.appendChild(el('span', null, 'Zoom'));
        var zoom = el('input'); zoom.type = 'range'; zoom.min = '1'; zoom.max = '5'; zoom.step = '0.01'; zoom.value = '1';
        zl.appendChild(zoom); card.appendChild(zl);
        var row = el('div', 'btn-row');
        var use = btn('btn primary', 'Use this framing'), cancel = btn('btn', 'Cancel');
        row.appendChild(use); row.appendChild(cancel); card.appendChild(row);
        modal.appendChild(card); document.body.appendChild(modal);
        var overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';

        // State: the photo point at the frame's center (cx, cy) and zoom z. z = 1 shows the whole photo;
        // zooming in to where it fills the frame and beyond (up to 5x that) is up to you.
        var W, H, base, zMax = 5, z = 1, cx = nw / 2, cy = nh / 2;
        function measure() {
          var b = stage.getBoundingClientRect(); W = b.width; H = b.height;
          base = Math.min(W / nw, H / nh);
          zMax = 5 * Math.max(W / nw, H / nh) / base; zoom.max = String(zMax);
        }
        // Along a side where the photo is smaller than the frame it stays centered; along a side where
        // it is bigger it can move, but never so far that a gap opens.
        function fit(c, n, frame, s) { return n * s <= frame ? n / 2 : Math.min(Math.max(c, frame / (2 * s)), n - frame / (2 * s)); }
        function draw() {
          var s = base * z;
          cx = fit(cx, nw, W, s); cy = fit(cy, nh, H, s);
          img.style.transform = 'translate(' + (W / 2 - cx * s) + 'px,' + (H / 2 - cy * s) + 'px) scale(' + s + ')';
          zoom.value = String(z);
        }
        function zoomAt(nz, px, py) { // keep the photo point under (px, py) where it is
          nz = Math.min(zMax, Math.max(1, nz));
          var s = base * z, ns = base * nz;
          var ix = cx + (px - W / 2) / s, iy = cy + (py - H / 2) / s;
          cx = ix - (px - W / 2) / ns; cy = iy - (py - H / 2) / ns; z = nz; draw();
        }
        function pan(dx, dy) { var s = base * z; cx -= dx / s; cy -= dy / s; draw(); }
        measure(); draw();
        var onResize = function () { measure(); draw(); };
        window.addEventListener('resize', onResize);

        var pts = {};
        function local(e) { var b = stage.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
        stage.addEventListener('pointerdown', function (e) {
          try { stage.setPointerCapture(e.pointerId); } catch (err) { /* still works without capture */ }
          pts[e.pointerId] = local(e); e.preventDefault();
        });
        stage.addEventListener('pointermove', function (e) {
          if (!pts[e.pointerId]) return;
          var ids = Object.keys(pts), p = local(e);
          if (ids.length === 1) { pan(p.x - pts[e.pointerId].x, p.y - pts[e.pointerId].y); pts[e.pointerId] = p; return; }
          var other = pts[ids[0] === String(e.pointerId) ? ids[1] : ids[0]], prev = pts[e.pointerId];
          var d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(p.x - other.x, p.y - other.y);
          var m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 }, m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
          if (d0 > 0) zoomAt(z * d1 / d0, m1.x, m1.y);
          pan(m1.x - m0.x, m1.y - m0.y);
          pts[e.pointerId] = p;
        });
        function lift(e) { delete pts[e.pointerId]; }
        stage.addEventListener('pointerup', lift); stage.addEventListener('pointercancel', lift);
        stage.addEventListener('wheel', function (e) { e.preventDefault(); var p = local(e); zoomAt(z * Math.exp(-e.deltaY * 0.0015), p.x, p.y); }, { passive: false });
        zoom.addEventListener('input', function () { zoomAt(+zoom.value, W / 2, H / 2); });
        stage.addEventListener('keydown', function (e) {
          var k = e.key, step = 24;
          if (k === 'ArrowLeft') pan(step, 0); else if (k === 'ArrowRight') pan(-step, 0);
          else if (k === 'ArrowUp') pan(0, step); else if (k === 'ArrowDown') pan(0, -step);
          else if (k === '+' || k === '=') zoomAt(z * 1.1, W / 2, H / 2); else if (k === '-') zoomAt(z / 1.1, W / 2, H / 2);
          else return;
          e.preventDefault();
        });
        modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } });

        function close(result) {
          window.removeEventListener('resize', onResize);
          document.body.style.overflow = overflow;
          modal.remove();
          if (!isUrl) URL.revokeObjectURL(url);
          if (back && back.focus) back.focus({ preventScroll: true });
          resolve(result);
        }
        cancel.addEventListener('click', function () { close(null); });
        use.addEventListener('click', function () {
          var s = base * z, sw = W / s;
          var outW = Math.round(Math.min(1400, sw)), outH = Math.round(outW * H / W), k = outW / W;
          var c = document.createElement('canvas'); c.width = outW; c.height = outH;
          var ctx = c.getContext('2d');
          if (nw * s < W - 0.5 || nh * s < H - 0.5) {
            // Empty space around the photo: fill it with the photo itself, stretched to cover and
            // blurred (drawn tiny, then scaled up, which works in every browser), and darkened a bit.
            var tiny = document.createElement('canvas'); tiny.width = 24; tiny.height = 18;
            var cover = Math.max(24 / nw, 18 / nh);
            tiny.getContext('2d').drawImage(img, (24 - nw * cover) / 2, (18 - nh * cover) / 2, nw * cover, nh * cover);
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(tiny, 0, 0, outW, outH);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.25)'; ctx.fillRect(0, 0, outW, outH);
          }
          ctx.drawImage(img, (W / 2 - cx * s) * k, (H / 2 - cy * s) * k, nw * s * k, nh * s * k);
          var dataUrl = c.toDataURL('image/jpeg', 0.85);
          close({ media_type: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl });
        });
        stage.focus({ preventScroll: true });
      }
    });
  }

  // Documents are read in the browser so their text lands in the text box, where it can be checked
  // before Claude sees it. PDFs go to Claude as they are: it reads both their text and their page
  // images, so scanned recipes work too. Each reader is downloaded only the first time it's needed.
  var LIBS = {
    mammoth: { src: 'https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js', integrity: 'sha384-xqNXvcKbEqifokHcBnB0H32p+OQchhD/T/xJGWCMAW5fC0c0MBf9atO3weoPCT84' },
    CFB: { src: 'https://cdn.jsdelivr.net/npm/cfb@1.2.2/dist/cfb.min.js', integrity: 'sha384-peTByNpmIz2Wq5hOZJ3dZmZP4MJ6ZXwF9dZ3R8kW7/C6bMWdHEME3on5mt9DH7d5' }
  };
  var libLoads = {};
  function loadLib(name) {
    if (window[name]) return Promise.resolve(window[name]);
    if (!libLoads[name]) libLoads[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIBS[name].src; s.integrity = LIBS[name].integrity; s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(window[name]); };
      s.onerror = function () { delete libLoads[name]; s.remove(); reject(new Error("Couldn't load the document reader. Check the connection and try again.")); };
      document.head.appendChild(s);
    });
    return libLoads[name];
  }
  var MAX_PDF = 14500000; // the helper takes up to about 15 MB

  // Go by a file's first bytes, not its name: old recipe files are often mislabeled.
  function fileKind(f) {
    return f.slice(0, 8).arrayBuffer().then(function (b) {
      var u = new Uint8Array(b), head = String.fromCharCode.apply(null, u);
      if (head.slice(0, 4) === '%PDF') return 'pdf';
      if (head.slice(0, 4) === 'PK\x03\x04') return 'docx';
      if (u[0] === 0xD0 && u[1] === 0xCF && u[2] === 0x11 && u[3] === 0xE0) return 'doc';
      if (head.slice(0, 5) === '{\\rtf') return 'rtf';
      if (/^image\//.test(f.type)) return 'image';
      if (/^text\/plain/.test(f.type) || /\.txt$/i.test(f.name || '')) return 'txt';
      return 'unknown';
    });
  }
  function readText(file, kind) {
    var read = kind === 'docx' ? readDocx(file) : file.arrayBuffer().then(function (buf) {
      if (kind === 'txt') return { text: new TextDecoder().decode(buf), pics: [] };
      if (kind === 'rtf') return { text: rtfText(new TextDecoder('windows-1252').decode(buf)), pics: [] };
      return loadLib('CFB').then(function (CFB) {
        try { return { text: docBinaryText(CFB, new Uint8Array(buf)), pics: [] }; }
        catch (e) {
          throw new Error(e.message === 'password' ? file.name + ' has a password. Open it in Word, remove the password, and add it again.'
            : file.name + " couldn't be read. Open it in Word and use Save As → Word Document (.docx), or copy and paste the text.");
        }
      });
    });
    return read.then(function (d) { d.text = d.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return d; });
  }
  function readPdf(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve({ name: file.name, data: String(r.result).split(',')[1] }); };
      r.onerror = function () { reject(new Error(file.name + " couldn't be opened.")); };
      r.readAsDataURL(file);
    });
  }
  function readDocx(file) {
    return Promise.all([loadLib('mammoth'), file.arrayBuffer()]).then(function (r) {
      var m = r[0], buf = r[1], pics = [];
      var keepPic = m.images.imgElement(function (im) { pics.push(im); return Promise.resolve({ src: '' }); });
      return m.convertToHtml({ arrayBuffer: buf }, { convertImage: keepPic }).then(function (out) {
        return { text: docText(out.value), pics: pics };
      }, function () { throw new Error(file.name + " couldn't be read. If it's a Word document, open it in Word and save it again, or copy and paste the text."); });
    });
  }
  // Turns the document into plain lines: one per paragraph, list items keep their numbers or
  // bullets, and each table row stays on one line ("1 cup | oats") so amounts stay with ingredients.
  function docText(html) {
    var body = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html').body, lines = [];
    var clean = function (s) { return s.replace(/\s+/g, ' ').trim(); };
    function list(n, depth) {
      var i = 0;
      Array.prototype.forEach.call(n.children, function (li) {
        if (li.tagName !== 'LI') return;
        var own = li.cloneNode(true);
        Array.prototype.forEach.call(own.querySelectorAll('ol, ul'), function (x) { x.remove(); });
        var t = clean(own.textContent);
        if (t) lines.push('  '.repeat(depth) + (n.tagName === 'OL' ? ++i + '. ' : '• ') + t);
        Array.prototype.forEach.call(li.children, function (c) { if (c.tagName === 'OL' || c.tagName === 'UL') list(c, depth + 1); });
      });
    }
    Array.prototype.forEach.call(body.children, function (n) {
      if (n.tagName === 'OL' || n.tagName === 'UL') list(n, 0);
      else if (n.tagName === 'TABLE') Array.prototype.forEach.call(n.querySelectorAll('tr'), function (tr) {
        var cells = Array.prototype.map.call(tr.children, function (c) { return clean(c.textContent); }).filter(Boolean);
        if (cells.length) lines.push(cells.join(' | '));
      });
      else {
        var t = clean(n.textContent);
        if (/^H\d$/.test(n.tagName)) lines.push('');
        if (t) lines.push(t);
      }
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function picToImage(im) {
    return im.readAsBase64String().then(function (b64) {
      var bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return shrink(new Blob([bytes], { type: im.contentType }));
    }).catch(function () { return null; }); // pictures the browser can't show (old Windows formats) are skipped
  }

  // Old Word (.doc, Word 97–2003) is a binary "compound file". cfb opens the container; the text is
  // then put back together from Word's piece table ([MS-DOC] 2.4.1). Formatting and automatic list
  // numbers are lost, table rows come out as "a | b", and links keep only their visible text.
  function docBinaryText(CFB, bytes) {
    var cfb = CFB.read(bytes, { type: 'array' });
    var wdEntry = CFB.find(cfb, 'WordDocument');
    if (!wdEntry) throw new Error('not a Word file');
    var wd = new Uint8Array(wdEntry.content), v = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (v.getUint16(0, true) !== 0xA5EC) throw new Error('not a Word file');
    var nFib = v.getUint16(2, true), flags = v.getUint16(10, true);
    if (flags & 0x0100) throw new Error('password');
    var text;
    if (nFib < 101) {
      // Word 6/95: the text sits in one run of single-byte characters.
      text = new TextDecoder('windows-1252').decode(wd.subarray(v.getUint32(0x18, true), v.getUint32(0x1C, true)));
    } else {
      var csw = v.getUint16(32, true), lw = 34 + csw * 2 + 2, cslw = v.getUint16(lw - 2, true);
      var ccpText = v.getInt32(lw + 12, true), blob = lw + cslw * 4 + 2;
      var fcClx = v.getUint32(blob + 33 * 8, true), lcbClx = v.getUint32(blob + 33 * 8 + 4, true);
      var tblEntry = CFB.find(cfb, flags & 0x0200 ? '1Table' : '0Table');
      if (!tblEntry || !lcbClx) throw new Error('no text table');
      var tbl = new Uint8Array(tblEntry.content), tv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
      var pos = fcClx, end = fcClx + lcbClx;
      while (pos < end && tbl[pos] === 0x01) pos += 3 + tv.getUint16(pos + 1, true); // skip formatting blocks
      if (tbl[pos] !== 0x02) throw new Error('no piece table');
      var lcb = tv.getUint32(pos + 1, true), plc = pos + 5, n = (lcb - 4) / 12, parts = [];
      var cp1252 = new TextDecoder('windows-1252'), utf16 = new TextDecoder('utf-16le');
      for (var i = 0; i < n; i++) {
        var cpStart = tv.getUint32(plc + i * 4, true), cpEnd = Math.min(tv.getUint32(plc + (i + 1) * 4, true), ccpText);
        if (cpStart >= cpEnd) continue;
        var fc = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true), len = cpEnd - cpStart;
        if (fc & 0x40000000) { var o = (fc & 0x3FFFFFFF) / 2; parts.push(cp1252.decode(wd.subarray(o, o + len))); }
        else parts.push(utf16.decode(wd.subarray(fc, fc + len * 2)));
      }
      text = parts.join('');
    }
    // Fields like links are "\x13 code \x14 shown text \x15": keep only the shown text.
    var out = '', stack = [];
    for (var k = 0; k < text.length; k++) {
      var ch = text[k];
      if (ch === '\x13') stack.push(false);
      else if (ch === '\x14') { if (stack.length) stack[stack.length - 1] = true; }
      else if (ch === '\x15') stack.pop();
      else if (stack.every(Boolean)) out += ch;
    }
    return out
      .replace(/\x07{2,}/g, '\n').replace(/\x07/g, ' | ') // table cells end in \x07, rows in another one
      .replace(/[\r\x0b\x0c]/g, '\n').replace(/\x1e/g, '-').replace(/\xa0/g, ' ')
      .replace(/[\x00-\x08\x0e-\x1f]/g, '');
  }

  // Some ".doc" files are really RTF; read the words out of it.
  function rtfText(s) {
    var out = '', depth = 0, skipAt = -1, uc = 1, skipChars = 0, i = 0;
    var dest = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|fldinst)$/;
    while (i < s.length) {
      var c = s[i];
      if (c === '{') { depth++; i++; continue; }
      if (c === '}') { if (depth === skipAt) skipAt = -1; depth--; i++; continue; }
      if (c === '\\') {
        var m = /^\\(?:([a-zA-Z]+)(-?\d+)? ?|'([0-9a-fA-F]{2})|([^a-zA-Z]))/.exec(s.slice(i, i + 40));
        if (!m) { i++; continue; }
        i += m[0].length;
        if (skipAt !== -1) continue;
        if (m[4] === '*') { skipAt = depth; continue; }
        var ch = '';
        if (m[3]) ch = new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(m[3], 16)]));
        else if (m[4]) ch = m[4] === '~' ? ' ' : m[4] === '_' ? '-' : /[\\{}]/.test(m[4]) ? m[4] : m[4] === '\n' || m[4] === '\r' ? '\n' : '';
        else if (dest.test(m[1])) { skipAt = depth; continue; }
        else if (m[1] === 'uc') uc = +m[2];
        else if (m[1] === 'u') { var code = +m[2]; ch = String.fromCharCode(code < 0 ? code + 65536 : code); skipChars = uc; out += ch; continue; }
        else if (m[1] === 'par' || m[1] === 'line' || m[1] === 'row' || m[1] === 'sect' || m[1] === 'page') ch = '\n';
        else if (m[1] === 'tab') ch = '\t';
        else if (m[1] === 'cell') ch = ' | ';
        else if (m[1] === 'emdash') ch = '—'; else if (m[1] === 'endash') ch = '–';
        else if (m[1] === 'bullet') ch = '•';
        else if (m[1] === 'lquote') ch = '‘'; else if (m[1] === 'rquote') ch = '’';
        else if (m[1] === 'ldblquote') ch = '“'; else if (m[1] === 'rdblquote') ch = '”';
        if (skipChars && m[3]) { skipChars--; continue; }
        out += ch; continue;
      }
      i++;
      if (skipAt !== -1 || c === '\r' || c === '\n') continue;
      if (skipChars) { skipChars--; continue; }
      out += c;
    }
    return out.replace(/(?: \| )+(?=\n|$)/g, '');
  }

  function openAdd() {
    adder.textContent = '';
    // Every visit starts empty, like the text box: no photos or PDF left over from the last recipe.
    add.parsed = null; add.images = []; add.pdf = null;
    bar(adder);
    adder.appendChild(el('h1', 'vtitle', 'Add a recipe'));
    if (!site.worker) {
      adder.appendChild(el('p', 'status error', "Adding recipes isn't switched on yet. The helper service still needs to be set up (see SETUP.md in the GitHub repo)."));
      show('adder'); window.scrollTo(0, 0); return;
    }
    adder.appendChild(el('p', 'vhint', "Paste a link to a recipe page or the recipe's text, or add photos, screenshots, a PDF or a Word document. Claude reads it and writes it in the same format as the other recipes. You'll see a preview before anything is saved. New recipes go into the whole library, so everyone can find them."));

    var f0 = el('div', 'field');
    var l0 = el('label', null, 'Recipe link'); l0.htmlFor = 'add-url';
    var urlIn = el('input'); urlIn.type = 'url'; urlIn.id = 'add-url'; urlIn.inputMode = 'url'; urlIn.autocomplete = 'off';
    urlIn.placeholder = 'https://…'; urlIn.className = 'url-in';
    f0.appendChild(l0); f0.appendChild(urlIn);
    f0.appendChild(el('span', 'hint', "Paste the address of a recipe page. Some sites don't allow it; if so, paste the recipe's text or add screenshots instead."));
    adder.appendChild(f0);

    var f1 = el('div', 'field');
    var l1 = el('label', null, 'Recipe text'); l1.htmlFor = 'add-text';
    var ta = el('textarea'); ta.id = 'add-text'; ta.rows = 7; ta.placeholder = 'Paste the recipe here';
    f1.appendChild(l1); f1.appendChild(ta); adder.appendChild(f1);

    var drop = el('div', 'drop');
    var file = el('input'); file.type = 'file'; file.multiple = true; file.id = 'add-file'; file.hidden = true;
    file.accept = 'image/*,.pdf,.docx,.doc,.rtf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/rtf,text/plain';
    var pick = btn('btn', 'Add a photo or file');
    pick.addEventListener('click', function () { file.click(); });
    var thumbs = el('div', 'thumbs');
    drop.appendChild(pick); drop.appendChild(file);
    drop.appendChild(el('span', 'hint', "Up to 3 photos or screenshots, and one PDF. A Word document's text (.docx or .doc) goes into the box above so you can check it. On a computer you can also drag or paste files here."));
    drop.appendChild(thumbs); adder.appendChild(drop);

    function drawThumbs() {
      thumbs.textContent = '';
      add.images.forEach(function (im, i) {
        var t = el('div', 'thumb'); var img = el('img'); img.src = im.preview; img.alt = 'Recipe image ' + (i + 1);
        var x = btn(null, '×'); x.setAttribute('aria-label', 'Remove image ' + (i + 1));
        x.addEventListener('click', function () { add.images.splice(i, 1); drawThumbs(); });
        t.appendChild(img); t.appendChild(x); thumbs.appendChild(t);
      });
      if (add.pdf) {
        var t = el('div', 'thumb file'); t.appendChild(el('strong', null, 'PDF')); t.appendChild(el('span', null, add.pdf.name));
        var x = btn(null, '×'); x.setAttribute('aria-label', 'Remove ' + add.pdf.name);
        x.addEventListener('click', function () { add.pdf = null; drawThumbs(); });
        t.appendChild(x); thumbs.appendChild(t);
      }
    }
    function takeDoc(f, kind) {
      setStatus('Reading ' + f.name + '…');
      return readText(f, kind).then(function (d) {
        if (d.text) ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + d.text;
        // A doc that's mostly a pasted-in picture of a recipe: send the pictures. Otherwise the
        // text is the recipe and any photos are just decoration, so leave them out.
        var pics = d.text.length < 80 ? d.pics.slice(0, 3 - add.images.length) : [];
        return Promise.all(pics.map(picToImage)).then(function (ims) {
          ims = ims.filter(Boolean);
          add.images = add.images.concat(ims).slice(0, 3); drawThumbs();
          if (!d.text && !ims.length) { setStatus(f.name + " didn't have any text or pictures that could be read.", true); return; }
          if (ta.value.length > 30000) { setStatus('That document is very long. Trim the text above down to just the recipe, then tap Read recipe.', true); return; }
          var got = d.text && ims.length ? 'the text and pictures' : d.text ? 'the text' : 'the pictures';
          setStatus('Got ' + got + ' from ' + f.name + '. Check ' + (d.text ? 'the text above' : 'them') + ', then tap Read recipe.');
        });
      }).catch(function (e) { setStatus(e.message, true); });
    }
    function takePdf(f) {
      if (f.size > MAX_PDF) { setStatus(f.name + ' is over 14 MB. Save just the recipe pages as a new PDF, or use screenshots.', true); return Promise.resolve(); }
      var replacing = !!add.pdf;
      setStatus('Reading ' + f.name + '…');
      return readPdf(f).then(function (p) {
        add.pdf = p; drawThumbs();
        setStatus((replacing ? 'Swapped in ' : 'Added ') + f.name + '. Claude reads the whole PDF when you tap Read recipe.');
      }).catch(function (e) { setStatus(e.message, true); });
    }
    function takeImages(files) {
      files = files.slice(0, 3 - add.images.length);
      if (!files.length) { setStatus('You can add up to 3 photos. Remove one to add another.', true); return Promise.resolve(); }
      setStatus('Preparing images…');
      return Promise.all(files.map(function (f) { return shrink(f); })).then(function (ims) { add.images = add.images.concat(ims).slice(0, 3); drawThumbs(); setStatus(''); })
        .catch(function (e) { setStatus(e.message, true); });
    }
    function takeFiles(list) {
      var all = Array.prototype.slice.call(list);
      Promise.all(all.map(fileKind)).then(function (kinds) {
        var imgs = [], pdfs = [], docs = [], bad = [];
        all.forEach(function (f, i) { (kinds[i] === 'image' ? imgs : kinds[i] === 'pdf' ? pdfs : kinds[i] === 'unknown' ? bad : docs).push({ f: f, kind: kinds[i] }); });
        var steps = Promise.resolve();
        if (pdfs.length) steps = steps.then(function () { return takePdf(pdfs[pdfs.length - 1].f); });
        docs.forEach(function (d) { steps = steps.then(function () { return takeDoc(d.f, d.kind); }); });
        if (imgs.length) steps = steps.then(function () { return takeImages(imgs.map(function (x) { return x.f; })); });
        if (bad.length) steps.then(function () { setStatus(bad[0].f.name + " isn't a kind of file that can be read here. Use a photo, screenshot, PDF or Word document, or paste the text.", true); });
      });
    }
    file.addEventListener('change', function () { takeFiles(file.files); file.value = ''; });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); takeFiles(e.dataTransfer.files); });
    adder.onpaste = function (e) {
      var files = Array.prototype.map.call(e.clipboardData.items || [], function (it) { return it.kind === 'file' ? it.getAsFile() : null; }).filter(Boolean);
      if (files.length) { e.preventDefault(); takeFiles(files); }
    };
    drawThumbs();

    var pass = passRow(adder);
    var go = btn('btn primary', 'Read recipe');
    var row = el('div', 'btn-row'); row.appendChild(go); adder.appendChild(row);
    var status = el('p', 'status'); status.setAttribute('aria-live', 'polite'); adder.appendChild(status);
    var previewWrap = el('div'); adder.appendChild(previewWrap);

    function setStatus(msg, isErr) { status.textContent = msg; status.className = 'status' + (isErr ? ' error' : ''); }

    function runParse(extra) {
      if (add.busy) return;
      var text = ta.value.trim(), url = urlIn.value.trim();
      // A link pasted into the text box on its own is treated as a recipe link.
      if (!url && /^https?:\/\/\S+$/i.test(text)) { url = text; urlIn.value = text; ta.value = ''; text = ''; }
      if (url && !/^https?:\/\/\S+\.\S+/i.test(url)) { setStatus('That link doesn\'t look right. Copy the whole address, starting with https://.', true); urlIn.focus(); return; }
      if (!text && !url && !add.images.length && !add.pdf) { setStatus('Paste a link or some text, or add a photo or file first.', true); return; }
      if (pass.need()) { setStatus('Enter the passcode.', true); return; }
      add.busy = true; go.disabled = true;
      var t0 = Date.now();
      setStatus('Reading the recipe… this usually takes 20–60 seconds.');
      var tick = setInterval(function () { setStatus('Reading the recipe… ' + Math.round((Date.now() - t0) / 1000) + ' sec'); }, 1000);
      var payload = {
        passcode: pass.get(), person: PERSON, text: text,
        images: add.images.map(function (im) { return { media_type: im.media_type, data: im.data }; }),
        sections: person.sections.map(function (s) { return { id: s.id, title: s.title }; })
      };
      if (add.pdf) payload.pdf = { name: add.pdf.name, data: add.pdf.data };
      if (url) payload.url = url;
      if (extra) { payload.previous = extra.previous; payload.fix = extra.fix; }
      helper('/parse', payload).then(function (j) {
        pass.ok();
        add.parsed = j;
        setStatus('');
        renderPreview();
      }).catch(function (e) {
        if (e.status === 401) pass.bad();
        setStatus(errText(e), true);
      }).then(function () { clearInterval(tick); add.busy = false; go.disabled = false; });
    }
    go.addEventListener('click', function () { runParse(); });

    function renderPreview() {
      previewWrap.textContent = '';
      var p = add.parsed;
      var r = Object.assign({ myTags: [], made: 0, inBox: false, confidence: 'clear', blurb: p.note || '' }, p.recipe);
      var pv = el('div', 'preview');
      pv.appendChild(el('span', 'eyebrow', 'Preview, not saved yet'));
      renderRecipeBody(r, pv, { interactive: false, headingTag: 'h2' });
      if (p.assumptions && p.assumptions.length) {
        var ab = el('div', 'vbox warn'); ab.appendChild(el('h3', null, 'What Claude filled in or changed'));
        var ul = el('ul'); p.assumptions.forEach(function (a) { ul.appendChild(el('li', null, a)); }); ab.appendChild(ul);
        pv.appendChild(ab);
      }

      var ff = el('div', 'field');
      var fl = el('label', null, 'Something off?'); fl.htmlFor = 'add-fix';
      var fix = el('textarea'); fix.id = 'add-fix'; fix.rows = 2; fix.placeholder = "Like: it's 2 cups of rice, not 1";
      var fixBtn = btn('btn', 'Fix it');
      fixBtn.addEventListener('click', function () {
        if (!fix.value.trim()) { fix.focus(); return; }
        runParse({ previous: p.recipe, fix: fix.value.trim() });
      });
      var editNew = btn('btn', 'Edit it myself');
      editNew.addEventListener('click', function () {
        p.note = nt.value; // keep the card description typed so far
        var top = previewWrap.getBoundingClientRect().top + window.scrollY;
        recipeForm(previewWrap, p.recipe, {
          saveLabel: 'Done editing', askClaude: false, onCancel: renderPreview,
          notice: el('p', 'vhint', 'Change anything below, then tap Done editing to see the preview again. Nothing is saved yet.'),
          onSave: function (x) { p.recipe = x; renderPreview(); return Promise.resolve(); }
        });
        window.scrollTo(0, top - 10);
      });
      ff.appendChild(fl); ff.appendChild(fix); var fr = el('div', 'btn-row'); fr.appendChild(fixBtn); fr.appendChild(editNew); ff.appendChild(fr);
      pv.appendChild(ff);

      var fs = el('fieldset', 'field choices');
      fs.appendChild(el('legend', null, 'Where should it go?'));
      var opts = [['new', 'Library and ' + person.name + "'s box"], ['made', 'Library and ' + person.name + "'s box, made today"],
        ['madebefore', 'Library and ' + person.name + "'s box, made before (no date)"], ['library', 'Library only']];
      opts.forEach(function (o, i) {
        var lab = el('label', 'choice'); var rb = el('input'); rb.type = 'radio'; rb.name = 'add-where'; rb.value = o[0]; rb.checked = i === 0;
        lab.appendChild(rb); lab.appendChild(el('span', null, o[1])); fs.appendChild(lab);
      });
      pv.appendChild(fs);

      var fsec = el('div', 'field');
      var sl = el('label', null, 'Section'); sl.htmlFor = 'add-section';
      var ss = el('select'); ss.id = 'add-section';
      person.sections.forEach(function (s) {
        var o = el('option', null, s.title); o.value = s.id; if (s.id === p.suggestedSection) o.selected = true; ss.appendChild(o);
      });
      fsec.appendChild(sl); fsec.appendChild(ss); pv.appendChild(fsec);

      var fn = el('div', 'field');
      var nl = el('label', null, 'Short description for the card'); nl.htmlFor = 'add-note';
      var nt = el('textarea'); nt.id = 'add-note'; nt.rows = 2; nt.value = p.note || '';
      fn.appendChild(nl); fn.appendChild(nt); pv.appendChild(fn);

      fs.addEventListener('change', function () { fsec.hidden = fs.querySelector('input:checked').value === 'library'; });

      var saveBtn = btn('btn primary', 'Save recipe');
      var again = btn('btn', 'Start over');
      again.addEventListener('click', function () { openAdd(); window.scrollTo(0, 0); });
      var sr = el('div', 'btn-row'); sr.appendChild(saveBtn); sr.appendChild(again); pv.appendChild(sr);
      var sstatus = el('p', 'status'); sstatus.setAttribute('aria-live', 'polite'); pv.appendChild(sstatus);

      saveBtn.addEventListener('click', function () {
        if (add.busy) return;
        var where = fs.querySelector('input:checked').value;
        add.busy = true; saveBtn.disabled = true;
        sstatus.className = 'status'; sstatus.textContent = 'Saving…';
        helper('/save', {
          passcode: pass.get(), person: PERSON, recipe: p.recipe,
          box: { mode: where, section: ss.value, blurb: nt.value.trim(), date: fmtDate(new Date()) }
        }).then(function (j) {
          library.push(j.recipe);
          if (j.entry) person.box.push(j.entry);
          refresh();
          renderDone(j.recipe, !!j.entry);
        }).catch(function (e) {
          if (e.status === 401) pass.bad();
          sstatus.className = 'status error'; sstatus.textContent = errText(e);
        }).then(function () { add.busy = false; saveBtn.disabled = false; });
      });

      previewWrap.appendChild(pv);
      pv.scrollIntoView({ block: 'start' });
    }

    function renderDone(r, inBox) {
      adder.textContent = '';
      bar(adder);
      adder.appendChild(el('h1', 'vtitle', 'Saved'));
      adder.appendChild(el('p', null, '"' + r.title + '" is in the whole library' + (inBox ? ' and in ' + person.name + "'s box" : '') + '. It shows here now. Everyone else will see it in about 2 minutes, once the site rebuilds.'));
      var row2 = el('div', 'btn-row');
      var view = el('a', 'btn primary', 'View recipe'); view.href = '#r-' + r.id;
      var another = btn('btn', 'Add another');
      another.addEventListener('click', function () { openAdd(); window.scrollTo(0, 0); });
      row2.appendChild(view); row2.appendChild(another); adder.appendChild(row2);
      window.scrollTo(0, 0);
    }

    show('adder');
    document.title = 'Add a recipe · ' + person.title;
    window.scrollTo(0, 0);
  }

  /* ---------- Start ---------- */
  Promise.all([getJSON('library/recipes.json'), getJSON('people/' + PERSON + '.json'), getJSON('site.json').catch(function () { return {}; })])
    .then(function (res) {
      library = res[0].recipes; person = res[1]; site = res[2] || {};
      pron = PRON[person.pronoun] || PRON.they;
      merge();
      var savedSel = load('ek-filters-' + PERSON);
      if (savedSel) GROUPS.forEach(function (g) { if (Array.isArray(savedSel[g])) sel[g] = savedSel[g].slice(); });
      mode = load('ek-mode-' + PERSON) === 'library' ? 'library' : 'box';
      buildFilters();
      renderHeader();
      chips().forEach(function (b) {
        var g = b.getAttribute('data-group');
        sel[g] = sel[g].filter(function (v) { return chips().some(function (c) { return c.getAttribute('data-group') === g && c.getAttribute('data-value') === v; }); });
      });
      renderList(); apply(); route();
    }).catch(function () {
      results.textContent = '';
      results.appendChild(el('p', 'loading', "The recipes didn't load. Check your connection and refresh the page."));
    });
})();
