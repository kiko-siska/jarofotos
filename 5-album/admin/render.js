/* Renders direction 5's pages from 5-album/content.json and the templates in 5-album/admin/templates/.
   One file, two users: scripts/build.mjs (Node) and the admin page (browser) import it, so a page published from the admin
   is byte-identical to one built locally from the same content. No Node or DOM APIs in here on purpose.

   Template syntax (a small Mustache subset):
     {{path}}            text from the content, HTML-escaped; an unknown path is an error, never an empty gap
     {{{path}}}          already-safe HTML computed in this file (photo strips, <img> tags)
     {{{paras path}}}    text split at blank lines into <p> elements
     {{#path}}...{{/path}}  repeats for every item of a list (an empty list drops the block: also used as "if")
   Inside a block, names are looked up in the item first, then outward. */

export const STRIP_SLOTS = 5; // tiles visible per category strip on the home page; the rest only show in "Zobraziť všetky"
export const CATEGORY_IDS = ['stuzkove', 'svadby', 'festivaly', 'hobby']; // Jaro removed "Eventy" on 2026-11-24; the files stay in the repo

const ESC = { '&': '&amp;', '"': '&quot;', '<': '&lt;' };
export const esc = (s) => String(s ?? '').replace(/[&"<]/g, (c) => ESC[c]);

/** Where one size of a photo lives. `opts.url` lets the admin preview point staged photos at in-memory blobs. */
export function photoFile(p, w) { return `assets/img/${p.id}-${w}.${p.ext || 'webp'}`; }
const urlOf = (R, opts) => (p, w) => (opts.url ? opts.url(p, w) : `${R}${photoFile(p, w)}`);
const largest = (p) => p.widths[p.widths.length - 1];

/** Links the admin lets through: web, mail, phone and in-page links. Anything else (javascript:, data:) is refused. */
export function safeHref(href) {
  const h = String(href ?? '').trim();
  if (!/^(https?:\/\/|mailto:|tel:|#|\/|\.\.?\/)/i.test(h)) throw new Error(`Neplatný odkaz: ${h || '(prázdny)'}`);
  return h;
}
/** The Apps Script address: Google's own, or a local one for tests. Empty = demo mode. */
export function safeApiUrl(u) {
  const s = String(u ?? '').trim();
  if (s === '') return '';
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(s)) return s;
  throw new Error('Adresa Apps Scriptu má končiť na /exec (https://script.google.com/macros/s/…/exec).');
}

// ---------- photo markup ----------
export function imgTag(p, o, { sizes = '100vw', cls = '', loading = 'lazy', prio = '', alt = '' } = {}) {
  const url = urlOf(o.R, o);
  const srcset = p.widths.map((w) => `${url(p, w)} ${w}w`).join(', ');
  return `<img src="${url(p, p.widths[1] ?? p.widths[0])}" srcset="${srcset}" sizes="${esc(sizes)}" width="${p.w}" height="${p.h}" alt="${esc(alt || p.alt)}"` +
    `${cls ? ` class="${cls}"` : ''} loading="${loading}" decoding="async"${prio ? ` fetchpriority="${prio}"` : ''}>`;
}

/** "Title, place", unless one already contains the other ("Stužková" + "Stužková slávnosť" -> the longer one). */
export function caption({ title, place }) {
  if (!place) return esc(title);
  const a = title.toLowerCase(), b = place.toLowerCase();
  return esc(b.includes(a) ? place : a.includes(b) ? title : `${title}, ${place}`);
}

/** A category strip: the first STRIP_SLOTS photos are tiles that open in the lightbox, the rest are .more tiles that
    CSS hides when JS runs and the category view collects. Without JS they all show. */
export function stripHtml(cat, o, labels) {
  const url = urlOf(o.R, o);
  const tile = (p, i) => {
    const shown = i < STRIP_SLOTS;
    return `<a class="t${shown ? ' rev' : ' more'}" href="${url(p, largest(p))}"${shown ? ' data-lightbox' : ''} data-caption="${caption(p)}">${imgTag(p, o, { sizes: '(min-width: 861px) 214px, 42vw' })}</a>`;
  };
  const out = cat.photos.map(tile);
  for (let i = cat.photos.length; i < STRIP_SLOTS; i++) out.push(`<div class="t ph rev" aria-hidden="true">${esc(labels.placeholderTile)}</div>`);
  return out.join('\n      ');
}

// ---------- template engine ----------
function parse(tpl) {
  const re = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([#/]?)\s*([^{}]+?)\s*\}\}/g;
  const root = { kids: [] };
  const stack = [root];
  let last = 0, m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) stack.at(-1).kids.push({ t: 'text', v: tpl.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1] !== undefined) stack.at(-1).kids.push({ t: 'var', name: m[1], raw: true });
    else if (m[2] === '#') { const n = { t: 'sec', name: m[3], kids: [] }; stack.at(-1).kids.push(n); stack.push(n); }
    else if (m[2] === '/') {
      if (stack.length < 2 || stack.at(-1).name !== m[3]) throw new Error(`Šablóna: {{/${m[3]}}} nepasuje k otvorenému bloku`);
      stack.pop();
    } else stack.at(-1).kids.push({ t: 'var', name: m[3], raw: false });
  }
  if (stack.length > 1) throw new Error(`Šablóna: blok {{#${stack.at(-1).name}}} nie je zatvorený`);
  if (last < tpl.length) root.kids.push({ t: 'text', v: tpl.slice(last) });
  return root.kids;
}

function lookup(stack, path) {
  const [first, ...rest] = path.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (c && typeof c === 'object' && first in c) {
      let v = c[first];
      for (const k of rest) { if (v == null) break; v = v[k]; }
      return v;
    }
  }
  return undefined;
}

const HELPERS = {
  paras: (text) => String(text).split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n    '),
};

function run(nodes, stack) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') {
      const sp = n.name.indexOf(' ');
      if (sp > 0) {
        const fn = HELPERS[n.name.slice(0, sp)];
        if (!fn) throw new Error(`Šablóna: neznáma funkcia ${n.name}`);
        const v = lookup(stack, n.name.slice(sp + 1).trim());
        if (v === undefined) throw new Error(`Šablóna: chýba hodnota ${n.name}`);
        out += fn(v);
      } else {
        const v = lookup(stack, n.name);
        if (v === undefined) throw new Error(`Šablóna: chýba hodnota {{${n.name}}}`);
        out += n.raw ? String(v) : esc(v);
      }
    } else {
      const v = lookup(stack, n.name);
      if (v === undefined) throw new Error(`Šablóna: chýba zoznam {{#${n.name}}}`);
      if (!Array.isArray(v)) throw new Error(`Šablóna: {{#${n.name}}} nie je zoznam`);
      for (const item of v) out += run(n.kids, [...stack, item]);
    }
  }
  return out;
}
export const renderTemplate = (tpl, ctx) => run(parse(tpl), [ctx]);

// ---------- pages ----------
const REVIEW_PHOTO = /^assets\/img\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/; // a review's round photo: a file already in the repo
const avatar = (r, R) => (r.photo && REVIEW_PHOTO.test(r.photo)
  ? `<img src="${esc(R + r.photo)}" alt="" width="512" height="512" loading="lazy" decoding="async">`
  : esc(r.initials || initials(r.name)));
const initials = (name) => String(name).trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function baseContext(content, o) {
  const cats = content.categories.map((c) => ({
    id: c.id, name: c.name, count: c.photos.length,
    showAll: content.labels.showAll.replace('{n}', c.photos.length),
    strip: stripHtml(c, o, content.labels),
  }));
  return {
    R: o.R, meta: content.meta, menu: content.menu, footer: content.footer, labels: content.labels,
    categories: cats,
    hasReviews: content.reviews.items.length ? [{}] : [],
  };
}

export function renderHome(tpl, content, opts = {}) {
  const o = { R: opts.R ?? '../', url: opts.url };
  const ctx = baseContext(content, o);
  const a = content.about;
  ctx.about = { ...a, portraitHtml: imgTag(a.portrait, o, { sizes: '(min-width: 1160px) 476px, (min-width: 861px) 42vw, (min-width: 521px) 380px, calc(100vw - 32px)', loading: 'eager', prio: 'high' }) };
  ctx.client = content.client;
  ctx.reviews = { heading: content.reviews.heading, items: content.reviews.items.map((r) => ({ ...r, avatar: avatar(r, o.R) })) };
  ctx.contact = {
    intro: content.contact.intro, heading: content.contact.heading,
    items: content.contact.items.map((it) => {
      const href = safeHref(it.href);
      return { label: it.label, text: it.text, href, attrs: /^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : '' };
    }),
  };
  return renderTemplate(tpl, ctx);
}

export function renderGaleria(tpl, content, opts = {}) {
  const o = { R: opts.R ?? '../../', url: opts.url };
  const ctx = baseContext(content, o);
  ctx.meta = { title: content.gallery.title, description: content.gallery.description };
  ctx.gallery = content.gallery;
  // the demo gallery (only while no Apps Script is connected) shows the first photo of every category
  const url = urlOf(o.R, o);
  // The sample gallery shown for code UKAZKA while no Apps Script is connected: Jaro's own sample photos (kept as he had them).
  ctx.demo = (content.gallery.demo || []).map((p) => ({ href: url(p, largest(p)), img: imgTag(p, o, { sizes: '(min-width: 1160px) 210px, (min-width: 900px) 22vw, 50vw' }) }));
  return renderTemplate(tpl, ctx);
}

/** 5-album/galeria/config.js: the one place the gallery page learns the Apps Script address. */
export function renderConfig(content) {
  const url = safeApiUrl(content.gallery.apiUrl);
  return `/* Nastavenie galérie pre klientov. Tento súbor vytvára správa webu (5-album/admin/), ručne ho netreba upravovať.
   apiUrl: adresa webovej aplikácie z Apps Scriptu, končí na /exec (návod: google-apps-script/NAVOD.md).
   Kým je prázdna, galéria beží ako ukážka s kódom UKAZKA a stránka sa ku Googlu vôbec nepripája. */
window.JAROFOTOS_GALERIA = {
  apiUrl: ${JSON.stringify(url)}
};
`;
}

/** The files a build or a publish writes for direction 5, as path -> text. */
export function renderAll(templates, content, opts = {}) {
  return {
    '5-album/index.html': renderHome(templates.home, content, opts),
    '5-album/galeria/index.html': renderGaleria(templates.galeria, content, opts),
    '5-album/galeria/config.js': renderConfig(content),
  };
}
