/* Správa webu: photos (order, add, remove, texts), all page texts, codes for client galleries.
   Everything the visitors see is published as ONE GitHub commit made from this page (see github.js); the pages are rendered
   here with the same module the local build uses (render.js), so what is published is what the preview shows.
   Codes for client galleries go to the Apps Script instead (gas.js): those photos must stay private, the repo is public. */
import { renderAll, renderHome, safeHref, safeApiUrl, photoFile, STRIP_SLOTS } from './render.js';
import { GitHub, GitHubError } from './github.js';
import { processImage, readBytes } from './images.js';
import { gasCall, GasError } from './gas.js';
import * as vault from './vault.js';

const $ = (s, r = document) => r.querySelector(s);
const SITE_ROOT = new URL('../../', location.href).href;
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);
const params = new URLSearchParams(location.search);
const API_BASE = LOCAL && params.get('api') ? params.get('api') : 'https://api.github.com'; // only overridable on localhost (tests)
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'multiple', 'min', 'max']);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? (k === 'draggable' ? 'true' : '') : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

// ---------- state ----------
const S = {
  gh: null, user: '', repo: '', branch: 'main',
  secrets: { token: '', gasPassword: '' }, pass: '', remember: false,
  loaded: null,            // { json, sha, templates: { home, galeria }, shas: { home, galeria } } as last read from / written to GitHub
  content: null,           // the working copy being edited
  staged: new Map(),       // photo id -> { blobs, urls, uploaded }  (photos added in this session)
  removed: new Set(),      // photo ids marked for removal
  tab: 'photos', cat: 'stuzkove',
  codes: { state: 'idle', list: [], error: '' },
  newCode: null,
};

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => (iso ? `${+iso.slice(8, 10)}. ${+iso.slice(5, 7)}. ${iso.slice(0, 4)}` : '');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast is-on${err ? ' is-err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), err ? 7000 : 3500);
}

// ---------- content helpers ----------
const live = (cat) => cat.photos.filter((p) => !S.removed.has(p.id));
const allPhotos = () => S.content.categories.flatMap((c) => c.photos);
const incomplete = (p) => !p.title.trim() || !p.alt.trim();

/** The content as it would be published: removed photos left out. */
function finalContent() {
  const c = clone(S.content);
  for (const cat of c.categories) cat.photos = cat.photos.filter((p) => !S.removed.has(p.id));
  return c;
}
const pending = () => [...S.staged.entries()].filter(([, s]) => !s.uploaded);
const isDirty = () => !!S.loaded && (JSON.stringify(finalContent()) !== JSON.stringify(JSON.parse(S.loaded.json)));

function summary() {
  const before = JSON.parse(S.loaded.json), after = finalContent();
  const ids = (c) => c.categories.flatMap((x) => x.photos.map((p) => p.id));
  const b = new Set(ids(before)), a = new Set(ids(after));
  const added = [...a].filter((i) => !b.has(i)).length, removed = [...b].filter((i) => !a.has(i)).length;
  const photoEdits = after.categories.flatMap((c) => c.photos).filter((p) => {
    const old = before.categories.flatMap((c) => c.photos).find((q) => q.id === p.id);
    return old && (old.title !== p.title || old.place !== p.place || old.alt !== p.alt);
  }).length;
  const keptOrder = (c) => c.categories.map((x) => x.photos.filter((p) => b.has(p.id) && a.has(p.id)).map((p) => p.id).join()).join('|');
  const moved = keptOrder(before) !== keptOrder(after);
  const rest = (c) => JSON.stringify(c, (k, v) => (k === 'photos' ? undefined : v)); // everything except the photo lists
  const texts = rest(before) !== rest(after);
  return { added, removed, photoEdits, moved, texts };
}

function commitMessage(s) {
  const parts = [];
  if (s.added) parts.push(`pridané ${s.added} ${plural(s.added, 'fotka', 'fotky', 'fotiek')}`);
  if (s.removed) parts.push(`odstránené ${s.removed} ${plural(s.removed, 'fotka', 'fotky', 'fotiek')}`);
  if (s.moved) parts.push('zmenené poradie');
  if (s.photoEdits) parts.push('upravené popisy fotiek');
  if (s.texts) parts.push('upravené texty');
  return `Správa webu: ${parts.join(', ') || 'zmeny'}`;
}

/** Everything that blocks publishing, as [message, tabToOpen]. */
function validate() {
  const out = [];
  const c = finalContent();
  let missing = 0;
  for (const cat of c.categories) for (const p of cat.photos) if (incomplete(p)) missing++;
  if (missing) out.push([`${missing} ${plural(missing, 'fotke', 'fotkám', 'fotkám')} chýba názov alebo popis (zvýraznené červenou na karte).`, 'photos']);
  for (const cat of c.categories) if (!cat.name.trim()) out.push(['Kategória nemá názov.', 'texts']);
  for (const [i, r] of c.reviews.items.entries()) if (!r.name.trim() || !r.quote.trim()) out.push([`Recenzia č. ${i + 1} nemá meno alebo text.`, 'texts']);
  for (const [i, it] of c.contact.items.entries()) {
    if (!it.label.trim() || !it.text.trim()) out.push([`Kontakt č. ${i + 1} nemá názov alebo text.`, 'texts']);
    try { safeHref(it.href); } catch { out.push([`Kontakt „${it.label}“ má neplatný odkaz (musí začínať https://, mailto: alebo tel:).`, 'texts']); }
  }
  try { safeApiUrl(c.gallery.apiUrl); } catch (e) { out.push([e.message, 'settings']); }
  for (const [k, v] of [['Názov stránky', c.meta.title], ['Nadpis „O mne“', c.about.heading], ['Text „O mne“', c.about.text], ['Popis fotky v „O mne“', c.about.portrait.alt]]) if (!v.trim()) out.push([`${k} nesmie byť prázdny.`, 'texts']);
  if (!out.length) {
    try { renderAll(S.loaded.templates, c); } catch (e) { out.push([`Stránku sa nepodarilo zostaviť: ${e.message}`, 'texts']); }
  }
  return out;
}

// ---------- dirty state / tabs ----------
function updateDirty() {
  if (!S.loaded) return;
  const d = isDirty();
  const el = $('#dirty');
  el.textContent = d ? 'Máte nezverejnené zmeny' : 'Bez zmien';
  el.classList.toggle('is-dirty', d);
  $('#btn-publish').disabled = !d;
  $('#btn-discard').hidden = !d;
}
addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

const VIEWS = { photos: renderPhotos, texts: renderTexts, codes: renderCodes, settings: renderSettings };
function showTab(name, focus = false) {
  S.tab = name;
  for (const b of document.querySelectorAll('#tabs button')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const k of Object.keys(VIEWS)) $(`#view-${k}`).hidden = k !== name;
  $('#view-connect').hidden = true;
  VIEWS[name]();
  if (focus) $('#main').focus();
}

// ---------- connect / unlock ----------
function guessRepo() {
  if (params.get('repo')) return params.get('repo');
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  const repo = location.pathname.split('/')[1];
  return m && repo ? `${m[1]}/${repo}` : '';
}

function showConnect(saved) {
  const v = $('#view-connect');
  for (const k of Object.keys(VIEWS)) $(`#view-${k}`).hidden = true;
  $('#tabs').hidden = true; $('#pub').hidden = true;
  v.hidden = false;
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (saved) {
    const pass = h('input', { id: 'c-pass', type: 'password', autocomplete: 'current-password', required: true });
    v.replaceChildren(
      h('h2', { id: 'h-connect' }, 'Odomknúť správu'),
      h('p', { class: 'lead' }, `Pripojené k ${saved.repo}. Zadajte heslo, ktorým ste si chránili prístup na tomto zariadení.`),
      h('form', {
        class: 'panel', onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          let secrets;
          try { secrets = await vault.open(saved.sealed, pass.value); } catch { return fail('Heslo nesedí.'); }
          S.pass = pass.value; S.remember = true;
          await connect({ repo: saved.repo, branch: saved.branch, secrets }, fail);
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'c-pass' }, 'Heslo na tomto zariadení'), pass),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary', type: 'submit' }, 'Odomknúť'),
        h('button', { class: 'btn', type: 'button', onclick: () => { vault.forget(); showConnect(null); } }, 'Zabudnúť toto zariadenie')),
      err));
    pass.focus();
    return;
  }
  const f = {
    repo: h('input', { id: 'c-repo', type: 'text', value: guessRepo(), required: true, autocomplete: 'off', spellcheck: false, placeholder: 'majitel/nazov-repozitara' }),
    branch: h('input', { id: 'c-branch', type: 'text', value: 'main', required: true, autocomplete: 'off', spellcheck: false }),
    token: h('input', { id: 'c-token', type: 'password', required: true, autocomplete: 'off', spellcheck: false }),
    pass: h('input', { id: 'c-pass', type: 'password', autocomplete: 'new-password', minlength: 8 }),
    remember: h('input', { id: 'c-rem', type: 'checkbox', checked: true }),
  };
  v.replaceChildren(
    h('h2', { id: 'h-connect' }, 'Pripojenie k webu'),
    h('p', { class: 'lead' }, 'Správa ukladá zmeny priamo do repozitára webu na GitHube. Raz si vytvoríte prístupový kľúč (token) a vložíte ho sem. Postup krok za krokom je v návode „Správa webu“ (SPRAVA.md), ktorý ste dostali od Kika.'),
    h('form', {
      class: 'panel', onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        if (f.remember.checked && f.pass.value.length < 8) return fail('Heslo na zariadení musí mať aspoň 8 znakov.');
        S.pass = f.pass.value; S.remember = f.remember.checked;
        await connect({ repo: f.repo.value.trim(), branch: f.branch.value.trim(), secrets: { token: f.token.value.trim(), gasPassword: '' } }, fail);
      },
    },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { for: 'c-repo' }, 'Repozitár na GitHube'), f.repo),
      h('div', { class: 'field' }, h('label', { for: 'c-branch' }, 'Vetva'), f.branch)),
    h('div', { class: 'field' }, h('label', { for: 'c-token' }, 'Prístupový kľúč (GitHub token)'), f.token,
      h('p', { class: 'hint' }, 'Kľúč sa neposiela nikam inam než na GitHub a ukladá sa len v tomto prehliadači, zašifrovaný vaším heslom.')),
    h('label', { class: 'check', for: 'c-rem' }, f.remember, 'Zapamätať si prístup na tomto zariadení'),
    h('div', { class: 'field' }, h('label', { for: 'c-pass' }, 'Heslo na tomto zariadení (vymyslite si ho, min. 8 znakov)'), f.pass,
      h('p', { class: 'hint' }, 'Pri ďalšom otvorení správy zadáte iba toto heslo. Ak ho zabudnete, stačí kľúč zadať znova.')),
    h('button', { class: 'btn btn--primary', type: 'submit' }, 'Pripojiť'),
    err));
  f.repo.focus();
}

async function connect({ repo, branch, secrets }, fail) {
  const btn = $('#view-connect button[type=submit]');
  btn.disabled = true; btn.textContent = 'Pripájam…';
  try {
    S.gh = new GitHub({ repo, branch, token: secrets.token, apiBase: API_BASE });
    S.repo = repo; S.branch = branch; S.secrets = secrets;
    await S.gh.check();
    S.user = (await S.gh.user()).login;
    await loadContent();
    if (S.remember && S.pass) vault.store({ v: 1, repo, branch, sealed: await vault.seal(secrets, S.pass) });
    enterApp();
  } catch (e) {
    S.gh = null;
    fail(e instanceof GitHubError || e instanceof Error ? e.message : String(e));
    btn.disabled = false; btn.textContent = btn.closest('form').querySelector('#c-rem') ? 'Pripojiť' : 'Odomknúť';
  }
}

async function loadContent() {
  const [c, home, gal] = await Promise.all([
    S.gh.file('5-album/content.json'), S.gh.file('5-album/admin/templates/home.html'), S.gh.file('5-album/admin/templates/galeria.html'),
  ]);
  if (!c || !home || !gal) throw new GitHubError('missing', 'V repozitári chýba 5-album/content.json alebo šablóny stránok. Je to správny repozitár a vetva?');
  S.loaded = { json: c.text, sha: c.sha, templates: { home: home.text, galeria: gal.text }, shas: { home: home.sha, galeria: gal.sha } };
  S.content = JSON.parse(c.text);
  for (const s of S.staged.values()) for (const u of Object.values(s.urls)) URL.revokeObjectURL(u);
  S.staged = new Map(); S.removed = new Set();
  if (!S.content.categories.some((x) => x.id === S.cat)) S.cat = S.content.categories[0].id;
}

function enterApp() {
  $('#tabs').hidden = false; $('#pub').hidden = false;
  showTab('photos', true);
  updateDirty();
}

// ---------- photos ----------
const thumb = (p) => {
  const s = S.staged.get(p.id);
  return s ? s.urls[p.widths[0]] : `${SITE_ROOT}${photoFile(p, p.widths[0])}`;
};
const catOf = (id) => S.content.categories.find((c) => c.id === id);
const find = (id) => {
  for (const cat of S.content.categories) { const i = cat.photos.findIndex((p) => p.id === id); if (i >= 0) return { cat, i, p: cat.photos[i] }; }
  return null;
};

function newId(cat) {
  for (;;) {
    const r = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
    const id = `${cat}-${r}`;
    if (!find(id)) return id;
  }
}

/** Puts photo `id` at live position `pos` (0-based) of category `catId`. */
function place(id, catId, pos) {
  const from = find(id);
  from.cat.photos.splice(from.i, 1);
  const dest = catOf(catId);
  const others = live(dest);
  const before = others[Math.max(0, Math.min(pos, others.length))];
  const at = before ? dest.photos.indexOf(before) : dest.photos.length;
  dest.photos.splice(at, 0, from.p);
}

function renderPhotos() {
  const v = $('#view-photos');
  const cat = catOf(S.cat);
  const photos = cat.photos;
  const liveN = live(cat).length;

  const input = h('input', {
    id: 'file-in', class: 'sr-only', type: 'file', accept: 'image/*', multiple: true, tabindex: '-1', 'aria-label': 'Vybrať fotky na pridanie',
    onchange: async () => { const fs = [...input.files]; input.value = ''; await addFiles(fs); },
  });
  const drop = h('div', { class: 'drop', id: 'drop' },
    h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-add', onclick: () => input.click() }, 'Pridať fotky'),
    h('p', { class: 'hint', id: 'add-hint' }, `Vyberte fotky z počítača alebo telefónu (aj viac naraz), alebo ich sem potiahnite. Pridajú sa na koniec kategórie „${cat.name}“. Zmenšia sa a zbavia sa polohy GPS ešte tu v prehliadači.`),
    input);
  drop.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); drop.classList.add('is-over'); } });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); drop.classList.remove('is-over');
    await addFiles([...e.dataTransfer.files]);
  });

  const items = [];
  let n = 0;
  for (const p of photos) {
    const gone = S.removed.has(p.id);
    if (!gone) n++;
    items.push(card(p, gone ? 0 : n, liveN, cat));
    if (!gone && n === STRIP_SLOTS && liveN > STRIP_SLOTS) items.push(h('li', { class: 'divider', 'aria-hidden': 'true' }, 'Vyššie je úvodná strana, ďalšie fotky sa ukážu po kliknutí na „Zobraziť všetky“'));
  }

  v.replaceChildren(
    h('div', { class: 'sechead' }, h('div', {}, h('h2', { id: 'tab-photos' }, 'Fotky'),
      h('p', { class: 'lead' }, `Prvých ${STRIP_SLOTS} fotiek každej kategórie sa ukáže na úvodnej strane, ostatné pod „Zobraziť všetky“. Poradie zmeníte potiahnutím karty alebo tlačidlami so šípkami.`))),
    h('ul', { class: 'chips', 'aria-label': 'Kategórie' }, S.content.categories.map((c) => h('li', {},
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(c.id === S.cat), onclick: () => { S.cat = c.id; renderPhotos(); } }, c.name, h('small', {}, `${live(c).length}`))))),
    drop,
    photos.length ? h('ol', { class: 'cards', id: 'cards', 'aria-label': `Fotky v kategórii ${cat.name}` }, items) : h('p', { class: 'empty' }, 'V tejto kategórii zatiaľ nie sú žiadne fotky.'));
}

function card(p, pos, liveN, cat) {
  const gone = S.removed.has(p.id);
  const isNew = S.staged.has(p.id) && !S.staged.get(p.id).uploaded;
  const bad = !gone && incomplete(p);
  const el = h('li', { class: `card${gone ? ' is-removed' : ''}${bad ? ' warn' : ''}`, 'data-id': p.id, draggable: !gone },
    h('img', { src: thumb(p), alt: gone ? '' : p.alt, width: p.widths[0], height: Math.round((p.widths[0] * p.h) / p.w), loading: 'lazy', draggable: 'false' }),
    gone ? null : h('span', { class: 'card__pos' }, h('span', { class: 'sr-only' }, 'Poradie '), String(pos)),
    h('span', { class: 'card__flags' },
      pos && pos <= STRIP_SLOTS ? h('span', { class: 'flag' }, 'Úvod') : null,
      isNew ? h('span', { class: 'flag flag--new' }, 'Nová') : null,
      bad ? h('span', { class: 'flag flag--warn' }, 'Chýba popis') : null,
      gone ? h('span', { class: 'flag flag--gone' }, 'Odstráni sa') : null),
    h('p', { class: 'card__ttl' }, p.title || 'Bez názvu'),
    h('div', { class: 'card__acts' }, gone
      ? h('button', { class: 'btn btn--small btn--wide', type: 'button', onclick: () => { S.removed.delete(p.id); renderPhotos(); updateDirty(); } }, 'Vrátiť späť')
      : [
        h('button', { class: 'btn btn--small btn--icon', type: 'button', 'aria-label': `Posunúť „${p.title || 'fotku'}“ skôr`, disabled: pos <= 1, onclick: () => shift(p.id, -1) }, '←'),
        h('button', { class: 'btn btn--small btn--icon', type: 'button', 'aria-label': `Posunúť „${p.title || 'fotku'}“ neskôr`, disabled: pos >= liveN, onclick: () => shift(p.id, 1) }, '→'),
        h('button', { class: 'btn btn--small', type: 'button', onclick: () => openEdit(p.id) }, 'Upraviť'),
        h('button', { class: 'btn btn--small btn--icon btn--danger', type: 'button', 'aria-label': `Odstrániť „${p.title || 'fotku'}“`, onclick: () => removePhoto(p.id) }, '✕'),
      ]));
  if (!gone) {
    el.addEventListener('dragstart', (e) => { S.drag = p.id; el.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id); });
    el.addEventListener('dragend', () => { S.drag = null; el.classList.remove('is-dragging'); });
    el.addEventListener('dragover', (e) => { if (S.drag && S.drag !== p.id) { e.preventDefault(); el.classList.add('is-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('is-over'));
    el.addEventListener('drop', (e) => {
      if (!S.drag || S.drag === p.id) return;
      e.preventDefault();
      const target = live(cat).findIndex((x) => x.id === p.id);
      const cur = live(cat).findIndex((x) => x.id === S.drag);
      void cur;
      place(S.drag, cat.id, target); // dropping on a card puts the dragged photo at that card's place
      S.drag = null; renderPhotos(); updateDirty();
    });
  }
  return el;
}

function shift(id, d) {
  const { cat, p } = find(id);
  const i = live(cat).findIndex((x) => x.id === id);
  place(id, cat.id, i + d);
  renderPhotos(); updateDirty();
  const again = $(`.card[data-id="${CSS.escape(p.id)}"] .btn--icon[aria-label*="${d < 0 ? 'skôr' : 'neskôr'}"]`);
  (again && !again.disabled ? again : $(`.card[data-id="${CSS.escape(p.id)}"] .btn`))?.focus();
}

function removePhoto(id) {
  const s = S.staged.get(id);
  if (s && !s.uploaded) { // never published: forget it completely
    const { cat, i } = find(id);
    cat.photos.splice(i, 1);
    for (const u of Object.values(s.urls)) URL.revokeObjectURL(u);
    S.staged.delete(id);
  } else S.removed.add(id);
  renderPhotos(); updateDirty();
  toast('Fotka sa odstráni po zverejnení zmien. Môžete ju vrátiť späť.');
}

async function addFiles(files, catId = S.cat) {
  if (!files.length) return;
  const cat = catOf(catId);
  const hint = $('#add-hint');
  const added = [], bad = [];
  for (const [i, f] of files.entries()) {
    if (hint) hint.textContent = `Spracúvam fotku ${i + 1} z ${files.length}…`;
    try {
      const r = await processImage(f);
      const id = newId(cat.id);
      const urls = Object.fromEntries(Object.entries(r.blobs).map(([w, b]) => [w, URL.createObjectURL(b)]));
      S.staged.set(id, { blobs: r.blobs, urls, uploaded: false });
      const p = { id, title: '', place: '', alt: '', w: r.w, h: r.h, widths: r.widths, color: r.color };
      if (r.ext !== 'webp') p.ext = r.ext;
      cat.photos.push(p);
      added.push(id);
    } catch (e) { bad.push(e.message); }
  }
  renderPhotos(); updateDirty();
  if (bad.length) toast(bad.join(' '), true);
  else if (added.length) toast(`Pridané: ${added.length}. Doplňte ku každej názov a popis.`);
  if (added.length) openEdit(added[0]);
}

function openEdit(id, queue) {
  const loc = find(id);
  if (!loc) return;
  const { cat, p } = loc;
  const dlg = $('#dlg-edit');
  const pos = Math.max(1, live(cat).findIndex((x) => x.id === id) + 1);
  const f = {
    title: h('input', { id: 'e-title', type: 'text', value: p.title, required: true, maxlength: 80, autocomplete: 'off' }),
    place: h('input', { id: 'e-place', type: 'text', value: p.place, maxlength: 60, autocomplete: 'off' }),
    alt: h('textarea', { id: 'e-alt', value: p.alt, required: true, maxlength: 300 }),
    cat: h('select', { id: 'e-cat' }, S.content.categories.map((c) => h('option', { value: c.id, selected: c.id === cat.id }, c.name))),
    pos: h('input', { id: 'e-pos', type: 'number', min: 1, value: String(pos), max: String(Math.max(1, live(cat).length)) }),
  };
  f.cat.addEventListener('change', () => { const n = live(catOf(f.cat.value)).length + (f.cat.value === cat.id ? 0 : 1); f.pos.max = String(n); f.pos.value = String(f.cat.value === cat.id ? pos : n); });
  const others = allPhotos().filter((x) => x.id !== id && !S.removed.has(x.id) && incomplete(x));
  const save = (next) => (e) => {
    e.preventDefault();
    if (!f.title.value.trim() || !f.alt.value.trim()) { f.title.reportValidity(); return; }
    p.title = f.title.value.trim(); p.place = f.place.value.trim(); p.alt = f.alt.value.trim();
    place(id, f.cat.value, Math.max(1, Math.min(+f.pos.value || 1, +f.pos.max)) - 1);
    if (f.cat.value !== S.cat) S.cat = f.cat.value;
    dlg.close(); renderPhotos(); updateDirty();
    if (next && others[0]) openEdit(others[0].id);
  };
  dlg.replaceChildren(h('form', { class: 'dlg__in', method: 'dialog', onsubmit: save(false) },
    h('h2', { id: 'dlg-edit-h' }, 'Upraviť fotku'),
    h('img', { class: 'dlg__pic', src: thumb(p), alt: '' }),
    h('div', { class: 'field' }, h('label', { for: 'e-title' }, 'Názov (pod fotkou po otvorení)'), f.title),
    h('div', { class: 'field' }, h('label', { for: 'e-place' }, 'Miesto (nepovinné)'), f.place, h('p', { class: 'hint' }, 'Napríklad „Praha“ alebo „Festival Lumen“. Mená súkromných osôb sem nepíšte.')),
    h('div', { class: 'field' }, h('label', { for: 'e-alt' }, 'Popis fotky pre nevidiacich'), f.alt,
      h('p', { class: 'hint' }, 'Jedna-dve vety o tom, čo je na fotke vidieť (kto, kde, čo sa deje). Bez mien. Číta ho čítačka obrazovky a zobrazí sa, keď sa fotka nenačíta.')),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { for: 'e-cat' }, 'Kategória'), f.cat),
      h('div', { class: 'field' }, h('label', { for: 'e-pos' }, 'Poradie v kategórii'), f.pos)),
    h('div', { class: 'dlg__foot' },
      h('button', { class: 'btn btn--danger', type: 'button', onclick: () => { dlg.close(); removePhoto(id); } }, 'Odstrániť fotku'),
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Zavrieť'),
      others.length ? h('button', { class: 'btn', type: 'button', onclick: save(true) }, 'Uložiť a ďalšia chýbajúca') : null,
      h('button', { class: 'btn btn--primary', type: 'submit' }, 'Uložiť'))));
  if (!dlg.open) dlg.showModal();
  f.title.focus();
}

// ---------- texts ----------
const FIELDS = [
  { title: 'Stránka a menu', fields: [
    ['meta.title', 'Názov stránky (záložka prehliadača a Google)'], ['meta.description', 'Krátky popis stránky (Google)', 'area'],
    ['menu.logo', 'Názov v hlavičke'], ['menu.about', 'Menu: O mne'], ['menu.client', 'Menu: Vaša galéria'], ['menu.reviews', 'Menu: Recenzie'], ['menu.contact', 'Menu: Kontakt'],
  ] },
  { title: 'O mne', portrait: true, fields: [
    ['about.heading', 'Nadpis'], ['about.text', 'Text o vás', 'area', 'Prázdny riadok medzi odsekmi vytvorí nový odsek.'],
    ['about.portfolioButton', 'Tlačidlo: Portfólio'], ['about.contactButton', 'Tlačidlo: Kontakt'],
    ['about.portrait.alt', 'Popis vašej fotky pre nevidiacich', 'area', 'Čo je na fotke vidieť. Číta ho čítačka obrazovky.'],
  ] },
  { title: 'Kód pre klientov (úvodná strana)', fields: [
    ['client.heading', 'Nadpis'], ['client.text', 'Text pod nadpisom'], ['client.inputLabel', 'Popis políčka pre čítačku obrazovky'], ['client.placeholder', 'Text vo vnútri políčka'], ['client.button', 'Tlačidlo'],
  ] },
  { title: 'Kategórie a popisky', fields: [
    ...[0, 1, 2, 3, 4].map((i) => [`categories.${i}.name`, `Názov kategórie č. ${i + 1}`]),
    ['labels.showAll', 'Odkaz na všetky fotky', 'text', '„{n}“ sa nahradí počtom fotiek.'], ['labels.placeholderTile', 'Prázdne políčko (kým je v kategórii menej než 5 fotiek)'],
    ['labels.back', 'Odkaz späť z kategórie'], ['labels.count', 'Popis počtu fotiek v kategórii'],
  ] },
  { title: 'Recenzie', list: 'reviews', fields: [['reviews.heading', 'Nadpis (viditeľný len pre čítačky obrazovky)']] },
  { title: 'Kontakt', list: 'contact', fields: [['contact.heading', 'Nadpis'], ['contact.intro', 'Úvodný text', 'area']] },
  { title: 'Pätička', fields: [['footer.left', 'Ľavá strana'], ['footer.right', 'Pravá strana']] },
  { title: 'Stránka galérie pre klientov', fields: [
    ['gallery.title', 'Názov stránky'], ['gallery.description', 'Popis stránky', 'area'], ['gallery.lockHeading', 'Nadpis'], ['gallery.lockIntro', 'Úvodný text', 'area'],
    ['gallery.inputLabel', 'Popis políčka pre čítačku obrazovky'], ['gallery.placeholder', 'Text vo vnútri políčka'], ['gallery.submit', 'Tlačidlo na otvorenie'],
    ['gallery.note', 'Poznámka o súkromí', 'area'], ['gallery.openHeading', 'Nadpis otvorenej galérie'], ['gallery.back', 'Odkaz späť na web'],
    ['gallery.downloadAll', 'Tlačidlo na stiahnutie všetkého'], ['gallery.empty', 'Správa, keď je galéria prázdna', 'area'],
  ] },
];

function fieldEl([path, label, type = 'text', hint]) {
  const id = `f-${path.replace(/\./g, '-')}`;
  const val = getPath(S.content, path) ?? '';
  const el = type === 'area' ? h('textarea', { id, value: val }) : h('input', { id, type: 'text', value: val, autocomplete: 'off' });
  el.addEventListener('input', () => { setPath(S.content, path, el.value); updateDirty(); });
  return h('div', { class: 'field' }, h('label', { for: id }, label), el, hint ? h('p', { class: 'hint' }, hint) : null);
}

function listEditor(key, rows, blank, addLabel, describe) {
  const wrap = h('div', {});
  const draw = () => {
    const arr = getPath(S.content, key);
    wrap.replaceChildren(
      h('ul', { class: 'listed' }, arr.map((item, i) => h('li', {},
        h('p', { class: 'hint' }, describe(item, i)),
        h('div', { class: 'grid2' }, rows.map(([prop, label, type]) => {
          const id = `l-${key.replace(/\./g, '-')}-${i}-${prop}`;
          const el = type === 'area' ? h('textarea', { id, value: item[prop] ?? '' }) : h('input', { id, type: 'text', value: item[prop] ?? '', autocomplete: 'off' });
          el.addEventListener('input', () => { item[prop] = el.value; updateDirty(); });
          return h('div', { class: 'field', style: type === 'area' ? 'grid-column: 1 / -1' : null }, h('label', { for: id }, label), el);
        })),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn--small', type: 'button', disabled: i === 0, onclick: () => { arr.splice(i - 1, 0, arr.splice(i, 1)[0]); draw(); updateDirty(); } }, '↑ Vyššie'),
          h('button', { class: 'btn btn--small', type: 'button', disabled: i === arr.length - 1, onclick: () => { arr.splice(i + 1, 0, arr.splice(i, 1)[0]); draw(); updateDirty(); } }, '↓ Nižšie'),
          h('button', { class: 'btn btn--small btn--danger', type: 'button', onclick: () => { arr.splice(i, 1); draw(); updateDirty(); } }, 'Odstrániť')))
      )),
      h('button', { class: 'btn', type: 'button', onclick: () => { arr.push(clone(blank)); draw(); updateDirty(); $$last(wrap)?.focus(); } }, addLabel));
  };
  draw();
  return wrap;
}
const $$last = (root) => { const all = root.querySelectorAll('.listed > li:last-child input'); return all[0]; };

function renderTexts() {
  const v = $('#view-texts');
  const wasOpen = new Set([...v.querySelectorAll('details[open]')].map((d) => d.dataset.k));
  v.replaceChildren(
    h('div', { class: 'sechead' }, h('div', {}, h('h2', { id: 'tab-texts' }, 'Texty'), h('p', { class: 'lead' }, 'Všetky texty na webe. Zmeny sa na stránke ukážu po „Zverejniť zmeny“; pred tým si ich môžete pozrieť v „Náhľade“.'))),
    ...FIELDS.map((s, i) => {
      const body = [s.portrait ? portraitBox() : null, s.fields.map(fieldEl)];
      if (s.list === 'reviews') {
        body.push(h('h3', {}, 'Recenzie'), h('p', { class: 'hint' }, 'Zverejňujte len recenzie, s ktorými klient súhlasil. Recenzie s fotkou v kruhu si fotku ponechajú; ostatným sa v kruhu ukážu iniciálky z mena (nechajte ich prázdne). Novú fotku do kruhu zatiaľ pridáva Kiko.'),
          listEditor('reviews.items', [['name', 'Meno'], ['role', 'Kto je to / akcia (nepovinné)'], ['initials', 'Iniciálky v kruhu (nepovinné)'], ['quote', 'Text recenzie', 'area']],
            { initials: '', name: '', role: '', quote: '' }, 'Pridať recenziu',
            (r, n) => `Recenzia ${n + 1}${/^recenzia\s/i.test(r.quote) ? ' – zástupný text, nahraďte ho skutočnou recenziou' : ''}`));
      }
      if (s.list === 'contact') {
        body.push(h('h3', {}, 'Spôsoby kontaktu'), h('p', { class: 'hint' }, 'Odkaz začína https:// (web), mailto: (e-mail) alebo tel: (telefón, bez medzier).'),
          listEditor('contact.items', [['label', 'Názov (napr. Telefón)'], ['text', 'Čo sa zobrazí'], ['href', 'Odkaz']], { label: '', text: '', href: 'https://' }, 'Pridať kontakt', (c, n) => `Kontakt ${n + 1}`));
      }
      return h('details', { class: 'sec', 'data-k': String(i), open: wasOpen.has(String(i)) || (!wasOpen.size && i === 0) }, h('summary', {}, s.title), h('div', { class: 'sec__body' }, body));
    }));
}

function portraitBox() {
  const p = S.content.about.portrait;
  const s = S.staged.get(p.id);
  const input = h('input', { id: 'portrait-in', class: 'sr-only', type: 'file', accept: 'image/*', tabindex: '-1', 'aria-label': 'Vybrať novú fotku do „O mne“', onchange: async () => { const f = input.files[0]; input.value = ''; if (f) await replacePortrait(f); } });
  return h('div', { class: 'portrait' },
    h('img', { src: s ? s.urls[p.widths[0]] : `${SITE_ROOT}${photoFile(p, p.widths[0])}`, alt: '' }),
    h('div', {}, h('p', { class: 'hint' }, 'Vaša fotka vedľa textu „O mne“.'), h('button', { class: 'btn', type: 'button', id: 'btn-portrait', onclick: () => input.click() }, 'Vybrať inú fotku'), input));
}

async function replacePortrait(file) {
  try {
    const r = await processImage(file);
    const id = `portret-${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 5)}`;
    S.staged.set(id, { blobs: r.blobs, urls: Object.fromEntries(Object.entries(r.blobs).map(([w, b]) => [w, URL.createObjectURL(b)])), uploaded: false });
    const old = S.content.about.portrait;
    const p = { id, alt: old.alt, w: r.w, h: r.h, widths: r.widths, color: r.color };
    if (r.ext !== 'webp') p.ext = r.ext;
    S.content.about.portrait = p;
    renderTexts(); updateDirty();
    toast('Fotka je vymenená. Skontrolujte popis fotky pre nevidiacich.');
  } catch (e) { toast(e.message, true); }
}

// ---------- codes for client galleries ----------
const STATUS = { open: 'Otvorená', expired: 'Platnosť skončila', closed: 'Zatvorená' };
const apiUrl = () => (S.content.gallery.apiUrl || '').trim();

async function gas(action, extra) {
  const url = apiUrl();
  if (!url) throw new GasError('no_url', 'Najprv zadajte adresu Apps Scriptu v Nastaveniach.');
  if (!S.secrets.gasPassword) throw new GasError('no_pw', 'Najprv zadajte heslo správcu galérií v Nastaveniach.');
  return gasCall(safeApiUrl(url), S.secrets.gasPassword, action, extra);
}

async function loadCodes() {
  S.codes = { state: 'loading', list: [], error: '' };
  renderCodes();
  try {
    S.codes.list = (await gas('list')).galleries;
    S.codes.state = 'ready';
  } catch (e) { S.codes.state = 'error'; S.codes.error = e.message; }
  renderCodes();
  if (S.codes.state === 'ready') { // photo counts, a few at a time (each one asks Google Drive)
    const todo = S.codes.list.filter((g) => g.count === undefined);
    const worker = async () => { for (let g; (g = todo.shift());) { try { g.count = (await gas('detail', { code: g.code })).count; } catch { g.count = null; } if (S.tab === 'codes') renderCodes(); } };
    await Promise.all([worker(), worker(), worker()]);
  }
}

function clientMessage(g) {
  return `Dobrý deň,\nvaše fotky sú pripravené. Otvoríte ich tu:\n${g.link}\n\nAlebo na ${g.link.split('#')[0]} zadajte kód ${g.code}.${g.until ? `\nGaléria je dostupná do ${fmtDate(g.until)}.` : ''}`;
}

const copy = async (text, what) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} je skopírovaný.`); } catch { toast('Kopírovanie sa nepodarilo. Označte text a skopírujte ho ručne.', true); }
};

function renderCodes() {
  const v = $('#view-codes');
  const head = h('div', { class: 'sechead' }, h('div', {}, h('h2', { id: 'tab-codes' }, 'Kódy pre klientov'),
    h('p', { class: 'lead' }, 'Klient zadá kód na webe a otvorí sa mu jeho súkromná galéria s fotkami z vášho Disku Google. Kód vytvoríte tu; fotky nahráte do priečinka na Disku.')));
  if (!apiUrl() || !S.secrets.gasPassword) {
    v.replaceChildren(head, h('div', { class: 'panel' }, h('h3', {}, 'Kódy ešte nie sú zapnuté'),
      h('p', {}, !apiUrl() ? 'Najprv treba jednorazovo nastaviť Apps Script na vašom Google účte (asi 15 minút, návod NAVOD.md). Potom tu vložíte jeho adresu.' : 'Zadajte heslo správcu galérií, ktoré ste nastavili v tabuľke Google (menu Jarofotos → Nastaviť heslo správcu).'),
      h('p', { class: 'row' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => showTab('settings', true) }, 'Prejsť do Nastavení'))));
    return;
  }
  if (S.codes.state === 'idle') { loadCodes(); return; }

  const title = h('input', { id: 'n-title', type: 'text', required: true, maxlength: 120, autocomplete: 'off', placeholder: 'Svadba, 14. 6. 2026' });
  const valid = h('select', { id: 'n-valid' }, [['30', '30 dní'], ['90', '90 dní'], ['180', '180 dní'], ['365', '1 rok'], ['none', 'Bez obmedzenia'], ['date', 'Vlastný dátum…']].map(([val, t]) => h('option', { value: val, selected: val === '90' }, t)));
  const date = h('input', { id: 'n-date', type: 'date', hidden: true });
  valid.addEventListener('change', () => { date.hidden = valid.value !== 'date'; });
  const folder = h('input', { id: 'n-folder', type: 'url', placeholder: 'https://drive.google.com/drive/folders/…', hidden: true, autocomplete: 'off' });
  const mode = h('select', { id: 'n-mode' }, [['new', 'Vytvoriť nový priečinok na Disku (odporúčané)'], ['existing', 'Použiť priečinok, ktorý už mám']].map(([val, t]) => h('option', { value: val }, t)));
  mode.addEventListener('change', () => { folder.hidden = mode.value !== 'existing'; });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const form = h('form', {
    class: 'panel', id: 'new-code', onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try {
        const body = { title: title.value.trim() };
        if (valid.value === 'none') body.until = ''; else if (valid.value === 'date') body.until = date.value; else { const d = new Date(); d.setDate(d.getDate() + +valid.value); body.until = isoOf(d); }
        if (mode.value === 'existing') body.folder = folder.value.trim();
        const { gallery } = await gas('create', body);
        S.codes.list.unshift({ ...gallery, count: 0 });
        S.newCode = gallery;
        title.value = '';
        renderCodes(); openCodeDialog(gallery, true);
      } catch (x) { err.textContent = x.message; err.hidden = false; } finally { btn.disabled = false; }
    },
  },
  h('h3', {}, 'Nový kód'),
  h('div', { class: 'grid2' },
    h('div', { class: 'field' }, h('label', { for: 'n-title' }, 'Názov galérie (uvidí ho klient)'), title),
    h('div', { class: 'field' }, h('label', { for: 'n-valid' }, 'Platnosť'), valid, date)),
  h('div', { class: 'field' }, h('label', { for: 'n-mode' }, 'Priečinok s fotkami'), mode, folder,
    h('p', { class: 'hint' }, 'Nový priečinok vznikne vo vašom Disku v priečinku „Jarofotos galérie“. Fotky do neho nahráte bežne cez Disk Google.')),
  h('button', { class: 'btn btn--primary', type: 'submit' }, 'Vytvoriť kód'), err);

  let list;
  if (S.codes.state === 'loading') list = h('p', { class: 'empty', role: 'status' }, 'Načítavam galérie…');
  else if (S.codes.state === 'error') list = h('div', { class: 'notice' }, h('p', { role: 'alert' }, S.codes.error), h('p', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: loadCodes }, 'Skúsiť znova')));
  else if (!S.codes.list.length) list = h('p', { class: 'empty' }, 'Zatiaľ žiadne galérie. Vytvorte prvý kód vyššie.');
  else list = h('ul', { class: 'codes', 'aria-label': 'Galérie pre klientov' }, S.codes.list.map(codeCard));
  v.replaceChildren(head, form, h('div', { class: 'sechead' }, h('h3', {}, 'Vaše galérie'), h('button', { class: 'btn btn--small', type: 'button', onclick: loadCodes }, 'Obnoviť')), list);
}

function codeCard(g) {
  const n = g.count;
  return h('li', { class: 'code', 'data-code': g.code },
    h('div', { class: 'code__top' }, h('span', { class: 'code__title' }, g.title || '(bez názvu)'), h('span', { class: 'code__val' }, g.code), h('span', { class: `badge badge--${g.status}` }, STATUS[g.status] || g.status)),
    h('p', { class: 'code__meta' }, `${g.until ? `Platí do ${fmtDate(g.until)}` : 'Bez časového obmedzenia'} · ${n === undefined ? 'počítam fotky…' : n === null ? 'počet fotiek sa nepodarilo zistiť' : `${n} ${plural(n, 'fotka', 'fotky', 'fotiek')}`}`),
    h('div', { class: 'code__acts' },
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => openCodeDialog(g, false) }, 'Odkaz a správa pre klienta'),
      g.folderUrl ? h('a', { class: 'btn btn--small', href: g.folderUrl, target: '_blank', rel: 'noopener' }, 'Otvoriť priečinok na Disku ↗') : null,
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => extend(g) }, 'Predĺžiť o 30 dní'),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => setActive(g, !g.active) }, g.active ? 'Zatvoriť' : 'Znova otvoriť'),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => editGallery(g) }, 'Upraviť'),
      h('button', { class: 'btn btn--small btn--danger', type: 'button', onclick: () => deleteGallery(g) }, 'Vymazať')));
}

function replaceGallery(g) {
  const i = S.codes.list.findIndex((x) => x.code === g.code);
  if (i >= 0) S.codes.list[i] = { ...g, count: S.codes.list[i].count };
  renderCodes();
}

async function mutate(action, g, extra, okMsg) {
  try { const r = await gas(action, { code: g.code, ...extra }); if (r.gallery) replaceGallery(r.gallery); toast(okMsg); return r; } catch (e) { toast(e.message, true); return null; }
}
function extend(g) {
  const base = g.until && new Date(g.until + 'T12:00:00') > new Date() ? new Date(g.until + 'T12:00:00') : new Date();
  base.setDate(base.getDate() + 30);
  return mutate('update', g, { until: isoOf(base), active: true }, `Galéria platí do ${fmtDate(isoOf(base))}.`);
}
const setActive = (g, active) => mutate('update', g, { active }, active ? 'Galéria je znova otvorená.' : 'Galéria je zatvorená, klient ju už neotvorí.');

function openCodeDialog(g, created) {
  const dlg = $('#dlg-code');
  const msg = h('textarea', { id: 'm-text', readOnly: true, rows: 7 }); msg.value = clientMessage(g);
  dlg.replaceChildren(h('div', { class: 'dlg__in' },
    h('h2', { id: 'dlg-code-h' }, created ? 'Galéria je pripravená' : g.title),
    h('p', {}, 'Kód pre klienta:'), h('p', { class: 'bigcode', id: 'm-code' }, g.code),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => copy(g.code, 'Kód') }, 'Kopírovať kód'),
      h('button', { class: 'btn', type: 'button', onclick: () => copy(g.link, 'Odkaz') }, 'Kopírovať odkaz')),
    created && g.folderUrl ? h('div', { class: 'notice notice--ok', style: 'margin-top:16px' }, h('p', {}, 'Teraz nahrajte fotky do priečinka na Disku (v plnej veľkosti, JPG). Klient si ich bude môcť stiahnuť v pôvodnej kvalite.'),
      h('p', { class: 'row', style: 'margin-top:10px' }, h('a', { class: 'btn btn--primary', href: g.folderUrl, target: '_blank', rel: 'noopener' }, 'Otvoriť priečinok na Disku ↗'))) : null,
    h('div', { class: 'field', style: 'margin-top:16px' }, h('label', { for: 'm-text' }, 'Správa, ktorú môžete poslať klientovi'), msg),
    h('div', { class: 'dlg__foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => copy(msg.value, 'Text správy') }, 'Kopírovať správu'),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: () => dlg.close() }, 'Hotovo'))));
  dlg.showModal();
}

function editGallery(g) {
  const dlg = $('#dlg-code');
  const title = h('input', { id: 'x-title', type: 'text', value: g.title, required: true, maxlength: 120 });
  const date = h('input', { id: 'x-date', type: 'date', value: g.until || '' });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  dlg.replaceChildren(h('form', {
    class: 'dlg__in', method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      try { const r = await gas('update', { code: g.code, title: title.value.trim(), until: date.value }); replaceGallery(r.gallery); dlg.close(); toast('Galéria je upravená.'); } catch (x) { err.textContent = x.message; err.hidden = false; }
    },
  },
  h('h2', { id: 'dlg-code-h' }, 'Upraviť galériu'),
  h('div', { class: 'field' }, h('label', { for: 'x-title' }, 'Názov galérie'), title),
  h('div', { class: 'field' }, h('label', { for: 'x-date' }, 'Platí do'), date, h('p', { class: 'hint' }, 'Prázdne políčko znamená bez časového obmedzenia.')),
  err,
  h('div', { class: 'dlg__foot' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Zrušiť'), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Uložiť'))));
  dlg.showModal();
}

function deleteGallery(g) {
  const dlg = $('#dlg-code');
  const unshare = h('input', { id: 'd-unshare', type: 'checkbox', checked: true });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  dlg.replaceChildren(h('div', { class: 'dlg__in' },
    h('h2', { id: 'dlg-code-h' }, 'Vymazať galériu?'),
    h('p', {}, `Kód ${g.code} („${g.title}“) prestane fungovať. Fotky na vašom Disku ostanú.`),
    h('label', { class: 'check', for: 'd-unshare' }, unshare, 'Zrušiť aj zdieľanie priečinka odkazom (odporúčané)'),
    err,
    h('div', { class: 'dlg__foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Zrušiť'),
      h('button', { class: 'btn btn--danger', type: 'button', id: 'btn-delete-ok', onclick: async () => {
        try {
          const r = await gas('remove', { code: g.code, unshare: unshare.checked });
          S.codes.list = S.codes.list.filter((x) => x.code !== g.code);
          dlg.close(); renderCodes();
          toast(r.unshared ? 'Galéria je vymazaná a priečinok je znova súkromný.' : 'Galéria je vymazaná.');
        } catch (x) { err.textContent = x.message; err.hidden = false; }
      } }, 'Vymazať'))));
  dlg.showModal();
}

// ---------- settings ----------
function renderSettings() {
  const v = $('#view-settings');
  const url = h('input', { id: 's-url', type: 'url', value: S.content.gallery.apiUrl || '', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off', spellcheck: false });
  url.addEventListener('input', () => { S.content.gallery.apiUrl = url.value.trim(); S.codes = { state: 'idle', list: [], error: '' }; updateDirty(); });
  const pw = h('input', { id: 's-pw', type: 'password', value: S.secrets.gasPassword || '', autocomplete: 'off' });
  const msg = h('p', { class: 'hint', role: 'status' });
  const saveGas = async () => {
    S.secrets.gasPassword = pw.value;
    S.codes = { state: 'idle', list: [], error: '' };
    if (S.remember && S.pass) { vault.store({ v: 1, repo: S.repo, branch: S.branch, sealed: await vault.seal(S.secrets, S.pass) }); msg.textContent = 'Heslo je uložené na tomto zariadení (zašifrované).'; }
    else msg.textContent = 'Heslo platí, kým je táto stránka otvorená.';
  };
  v.replaceChildren(
    h('div', { class: 'sechead' }, h('div', {}, h('h2', { id: 'tab-settings' }, 'Nastavenia'))),
    h('div', { class: 'panel' }, h('h3', {}, 'Pripojenie k webu'),
      h('p', {}, `Repozitár: ${S.repo} (vetva ${S.branch}), prihlásený ako ${S.user}.`),
      h('p', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn', type: 'button', id: 'btn-reload', onclick: async () => { if (isDirty() && !confirm('Zahodiť nezverejnené zmeny a načítať web znova?')) return; try { await loadContent(); S.codes = { state: 'idle', list: [], error: '' }; showTab(S.tab); updateDirty(); toast('Načítané z GitHubu.'); } catch (e) { toast(e.message, true); } } }, 'Načítať web znova'),
        h('button', { class: 'btn', type: 'button', id: 'btn-forget', onclick: () => { vault.forget(); S.secrets = { token: '', gasPassword: '' }; S.gh = null; S.loaded = null; showConnect(null); toast('Toto zariadenie je odpojené.'); } }, 'Odpojiť toto zariadenie'))),
    h('div', { class: 'panel' }, h('h3', {}, 'Kódy pre klientov (Apps Script)'),
      h('p', { class: 'hint' }, 'Adresa sa uloží na web pri zverejnení zmien (aby ju poznala stránka galérie). Heslo ostáva len tu.'),
      h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { for: 's-url' }, 'Adresa webovej aplikácie (končí na /exec)'), url),
      h('div', { class: 'field' }, h('label', { for: 's-pw' }, 'Heslo správcu galérií'), pw),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-gas-save', onclick: async () => { await saveGas(); showTab('codes', true); } }, 'Uložiť a otvoriť kódy'),
        h('button', { class: 'btn', type: 'button', id: 'btn-gas-test', onclick: async () => { await saveGas(); try { const r = await gas('ping'); msg.textContent = `Spojenie funguje. Počet galérií: ${r.galerie}.`; } catch (e) { msg.textContent = e.message; } } }, 'Vyskúšať spojenie')),
      msg));
}

// ---------- preview and publish ----------
function previewHtml() {
  const c = finalContent();
  const url = (p, w) => { const s = S.staged.get(p.id); return s ? s.urls[w] : `${SITE_ROOT}${photoFile(p, w)}`; };
  const html = renderHome(S.loaded.templates.home, c, { url, R: SITE_ROOT });
  const dir = `${SITE_ROOT}5-album/`;
  return html.replace('href="style.css"', `href="${dir}style.css"`).replace('src="galeria/config.js"', `src="${dir}galeria/config.js"`)
    .replace('src="main.js"', `src="${dir}main.js"`).replace('action="galeria/"', `action="${dir}galeria/"`);
}

function openPreview() {
  const dlg = $('#dlg-preview');
  let html;
  try { html = previewHtml(); } catch (e) { toast(`Náhľad sa nepodarilo vytvoriť: ${e.message}`, true); return; }
  const frame = h('iframe', { title: 'Náhľad úvodnej strany', sandbox: 'allow-scripts allow-same-origin' });
  frame.srcdoc = html;
  dlg.replaceChildren(h('div', { class: 'dlg__in' }, h('h2', { id: 'dlg-preview-h' }, 'Náhľad úvodnej strany'),
    h('p', { class: 'hint' }, 'Takto bude stránka vyzerať po zverejnení. Nič sa tým ešte nezmenilo na živom webe.'), frame,
    h('div', { class: 'dlg__foot' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => dlg.close() }, 'Zavrieť náhľad'))));
  dlg.showModal();
}

async function openPublish() {
  const problems = validate();
  const dlg = $('#dlg-publish');
  if (problems.length) {
    dlg.replaceChildren(h('div', { class: 'dlg__in' }, h('h2', { id: 'dlg-publish-h' }, 'Najprv to treba doplniť'),
      h('ul', { class: 'list' }, problems.map(([m]) => h('li', {}, m))),
      h('div', { class: 'dlg__foot' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { dlg.close(); showTab(problems[0][1], true); } }, 'Prejsť na opravu'))));
    dlg.showModal();
    return;
  }
  const s = summary();
  const lines = [
    s.added ? `Nové fotky: ${s.added}` : null, s.removed ? `Odstránené fotky: ${s.removed}` : null, s.moved ? 'Zmenené poradie fotiek' : null,
    s.photoEdits ? `Upravené popisy fotiek: ${s.photoEdits}` : null, s.texts ? 'Upravené texty' : null,
  ].filter(Boolean);
  const bar = h('i', {}); const status = h('p', { role: 'status', id: 'pub-status' });
  const go = h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-publish-go', onclick: () => run() }, 'Zverejniť');
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Zrušiť');
  dlg.replaceChildren(h('div', { class: 'dlg__in' }, h('h2', { id: 'dlg-publish-h' }, 'Zverejniť zmeny'),
    h('ul', { class: 'list' }, lines.map((l) => h('li', {}, l))),
    h('p', { class: 'hint' }, 'Zmeny sa uložia na GitHub a web sa aktualizuje zhruba do dvoch minút. Odstránené fotky zmiznú zo stránky, v histórii repozitára ostávajú.'),
    h('div', { class: 'progress', 'aria-hidden': 'true' }, bar), status,
    h('div', { class: 'dlg__foot' }, cancel, go)));
  dlg.showModal();

  async function run() {
    go.disabled = true; cancel.disabled = true;
    try {
      const c = finalContent();
      const pages = renderAll(S.loaded.templates, c);
      const json = JSON.stringify(c, null, 1) + '\n';
      const files = [
        { path: '5-album/content.json', text: json },
        ...Object.entries(pages).map(([path, text]) => ({ path, text })),
      ];
      const used = new Set([...c.categories.flatMap((x) => x.photos), c.about.portrait].map((p) => p.id));
      for (const [id, st] of pending()) {
        if (!used.has(id)) continue;
        const p = [...c.categories.flatMap((x) => x.photos), c.about.portrait].find((x) => x.id === id);
        for (const w of p.widths) files.push({ path: photoFile(p, w), bytes: await readBytes(st.blobs[w]) });
      }
      const before = JSON.parse(S.loaded.json);
      const deletes = [];
      for (const cat of before.categories) for (const p of cat.photos) if (!used.has(p.id)) for (const w of p.widths) deletes.push(photoFile(p, w));
      status.textContent = 'Nahrávam…';
      const r = await S.gh.commit({
        message: commitMessage(s), files, deletes,
        guard: [{ path: '5-album/content.json', sha: S.loaded.sha }, { path: '5-album/admin/templates/home.html', sha: S.loaded.shas.home }, { path: '5-album/admin/templates/galeria.html', sha: S.loaded.shas.galeria }],
        onProgress: (e) => {
          if (e.stage === 'upload') { bar.style.width = `${Math.round((e.done / e.total) * 90)}%`; status.textContent = `Nahrávam súbory ${e.done} z ${e.total}…`; }
          else { bar.style.width = '95%'; status.textContent = 'Ukladám zmenu…'; }
        },
      });
      // the published state is the new baseline
      S.loaded.json = json; S.loaded.sha = r.blobs['5-album/content.json'];
      S.content = JSON.parse(json); S.removed = new Set();
      for (const st of S.staged.values()) st.uploaded = true;
      bar.style.width = '100%';
      updateDirty(); VIEWS[S.tab]();
      dlg.replaceChildren(h('div', { class: 'dlg__in' }, h('h2', { id: 'dlg-publish-h' }, 'Zverejnené'),
        h('p', { role: 'status' }, 'Zmeny sú uložené. Web sa na adrese GitHub Pages aktualizuje zhruba do dvoch minút; nové fotky sa dovtedy na stránke môžu ešte neukázať.'),
        h('div', { class: 'dlg__foot' }, h('a', { class: 'btn', href: '../', target: '_blank', rel: 'noopener' }, 'Otvoriť web ↗'), h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-publish-done', onclick: () => dlg.close() }, 'Hotovo'))));
    } catch (e) {
      status.textContent = '';
      go.disabled = false; cancel.disabled = false;
      const m = h('p', { class: 'err', role: 'alert' }, e.message || String(e));
      dlg.querySelector('.dlg__in').insertBefore(m, dlg.querySelector('.dlg__foot'));
      if (e instanceof GitHubError && e.kind === 'conflict') go.hidden = true;
    }
  }
}

// ---------- boot ----------
function init() {
  const discard = h('button', { class: 'btn', type: 'button', id: 'btn-discard', hidden: true, onclick: async () => {
    if (!confirm('Zahodiť všetky nezverejnené zmeny?')) return;
    try { await loadContent(); showTab(S.tab); updateDirty(); toast('Zmeny sú zahodené.'); } catch (e) { toast(e.message, true); }
  } }, 'Zahodiť zmeny');
  $('#pub').insertBefore(discard, $('#btn-preview'));
  $('#btn-preview').addEventListener('click', openPreview);
  $('#btn-publish').addEventListener('click', openPublish);
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab, true));
  showConnect(vault.load());
}
init();
