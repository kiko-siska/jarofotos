/* Client galleries: a code opens a private set of photos that live in a Google Drive folder.
   The code is checked only by his Google Apps Script (google-apps-script/Code.gs); this file knows no codes or folders.
   Contract (kept from his own "Verzia E" file):
     GET <apiUrl>?code=<CODE>  ->  { ok, title, until?, folder?, photos: [{ id, name, w?, h?, u?, dl? }] }
                                   or { ok: false, error: "not_found" | "busy" }
   u / dl override the Drive URLs (the demo and the tests use them). Nothing is requested from Google before a code
   is entered or a #kod= link is opened; without apiUrl the page is a demo and never contacts Google. */
(function () {
  'use strict';

  var cfg = window.JAROFOTOS_GALERIA || {};
  var API = String(cfg.apiUrl || '').trim();
  var DEMO_CODE = 'UKAZKA';
  var TIMEOUT_MS = 25000; // an Apps Script cold start can take several seconds
  var TITLE = document.title;
  var SIZES = '(min-width: 1160px) 210px, (min-width: 900px) 22vw, 50vw'; // tiles: 2 columns on phones, 4-5 from 900 px
  var DL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';

  var $ = function (id) { return document.getElementById(id); };
  var lockView = $('lock'), openView = $('open'), form = $('code-form'), input = $('code-input'), submit = $('code-submit');
  var err = $('code-err'), statusEl = $('status'), retry = $('retry'), grid = $('grid'), heading = $('h-open');
  var current = ''; // code of the open gallery
  var pending = ''; // code being loaded

  JFLightbox({ selector: '#grid a[data-lightbox]', download: true });
  if (!API) $('demo-note').hidden = false;

  // ---------- helpers ----------
  function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function codeFromUrl() {
    var m = location.hash.match(/(?:^#|&)kod=([^&]*)/);
    if (m) return decodeURIComponent(m[1]);
    return new URLSearchParams(location.search).get('kod') || '';
  }

  // the Drive URLs his file used: a sized thumbnail for viewing, uc?export=download for the original file
  function driveThumb(id, w) { return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + w; }
  function driveDownload(id) { return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id); }

  // only https or same-origin URLs from the API end up in src/href
  function safeUrl(u) {
    if (!u) return '';
    var a = document.createElement('a');
    a.href = u;
    return a.protocol === 'https:' || a.origin === location.origin ? a.href : '';
  }

  function dateLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? (+m[3]) + '. ' + (+m[2]) + '. ' + m[1] : '';
  }

  function toPhoto(p, i, n) {
    var id = p.id ? String(p.id) : '';
    var fromDrive = !p.u && id;
    return {
      src: safeUrl(p.u) || (id ? driveThumb(id, 960) : ''),
      srcset: fromDrive ? [480, 960, 1600].map(function (w) { return driveThumb(id, w) + ' ' + w + 'w'; }).join(', ') : (p.srcset || ''),
      full: safeUrl(p.full || p.u) || (id ? driveThumb(id, 2048) : ''),
      dl: safeUrl(p.dl) || (id ? driveDownload(id) : ''),
      name: String(p.name || '').replace(/\.[a-z0-9]{2,5}$/i, ''),
      alt: p.alt || ('Fotka ' + (i + 1) + ' z ' + n),
      w: +p.w || 0,
      h: +p.h || 0
    };
  }

  // ---------- data ----------
  function demoGallery() {
    var t = $('demo-photos');
    var links = t ? [].slice.call(t.content.querySelectorAll('a')) : [];
    return {
      ok: true,
      title: 'Ukážková galéria',
      photos: links.map(function (a) {
        var img = a.querySelector('img');
        return {
          u: img.getAttribute('src'), srcset: img.getAttribute('srcset'), full: a.getAttribute('href'), dl: a.getAttribute('href'),
          name: a.getAttribute('data-caption'), alt: img.getAttribute('alt'), w: img.getAttribute('width'), h: img.getAttribute('height')
        };
      })
    };
  }

  function fetchGallery(code) {
    if (!API) return Promise.resolve(code === DEMO_CODE ? demoGallery() : { ok: false, error: 'not_found' });
    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    // a plain GET without custom headers: Apps Script cannot answer a CORS preflight
    var url = API + (API.indexOf('?') < 0 ? '?' : '&') + 'code=' + encodeURIComponent(code);
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.kind = 'server'; throw e; }
        return r.json().catch(function () { var e = new Error('bad json'); e.kind = 'server'; throw e; });
      })
      .then(function (data) { clearTimeout(timer); return data; }, function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- views ----------
  function setBusy(on) {
    submit.disabled = on;
    submit.textContent = on ? 'Otváram…' : 'Otvoriť galériu';
    statusEl.classList.toggle('is-busy', on);
    statusEl.textContent = on ? 'Otváram galériu. Prvé otvorenie môže trvať pár sekúnd.' : '';
  }

  function showError(kind, code) {
    var msg = {
      not_found: 'Kód ' + code + ' sa nenašiel alebo galéria už nie je otvorená. Skontrolujte ho a skúste znova, prípadne mi napíšte na Instagram.' +
        (API ? '' : ' V tejto ukážke funguje len kód UKAZKA.'),
      busy: 'Priveľa pokusov za krátky čas. Skúste to znova o minútu.',
      network: 'Galériu sa nepodarilo načítať, spojenie s Google Diskom zlyhalo. Skontrolujte pripojenie na internet a skúste to znova.',
      server: 'Galériu sa nepodarilo načítať, Google Disk vrátil chybu. Skúste to znova o chvíľu, alebo mi napíšte na Instagram.'
    }[kind] || '';
    err.textContent = msg;
    err.hidden = false;
    retry.hidden = !(kind === 'network' || kind === 'server');
    input.setAttribute('aria-invalid', kind === 'not_found' ? 'true' : 'false');
  }

  function clearError() {
    err.hidden = true;
    retry.hidden = true;
    input.removeAttribute('aria-invalid');
  }

  function showLock(code) {
    openView.hidden = true;
    lockView.hidden = false;
    grid.textContent = '';
    current = '';
    document.title = TITLE;
    if (code !== undefined) input.value = code;
  }

  function tile(p, i) {
    var fig = document.createElement('figure');
    fig.className = 'tile';

    var a = document.createElement('a');
    a.className = 'tile__open';
    a.href = p.full;
    a.setAttribute('data-lightbox', '');
    a.setAttribute('data-caption', p.name);
    if (p.dl) a.setAttribute('data-download', p.dl);

    var img = document.createElement('img');
    img.alt = p.alt;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'is-loading';
    if (p.w && p.h) {
      img.width = p.w;
      img.height = p.h;
    }
    if (p.srcset) {
      img.srcset = p.srcset;
      img.sizes = SIZES;
    }
    img.src = p.src;
    img.addEventListener('load', function () { img.classList.remove('is-loading'); });
    img.addEventListener('error', function () {
      var note = document.createElement('span');
      note.className = 'tile__fail';
      note.textContent = 'Náhľad sa nenačítal. Fotku si môžete stiahnuť.';
      a.replaceChild(note, img);
    });
    a.appendChild(img);
    fig.appendChild(a);

    if (p.dl) {
      var d = document.createElement('a');
      d.className = 'tile__dl';
      d.href = p.dl;
      d.setAttribute('download', '');
      d.setAttribute('aria-label', 'Stiahnuť ' + (p.name ? p.name : 'fotku ' + (i + 1)));
      d.innerHTML = DL_ICON;
      fig.appendChild(d);
    }
    return fig;
  }

  function showGallery(g, code) {
    var list = g.photos || [];
    var photos = list.map(function (p, i) { return toPhoto(p || {}, i, list.length); }).filter(function (p) { return p.src; });
    var title = String(g.title || 'Vaše fotky');
    current = code;

    heading.textContent = title;
    document.title = title + ' – Jarofotos';
    var until = dateLabel(g.until);
    $('meta').textContent = 'Počet fotografií: ' + photos.length + (until ? '. Galéria je otvorená do ' + until + '.' : '');
    $('demo-banner').hidden = !!API;

    var folder = safeUrl(g.folder);
    var all = $('all');
    all.hidden = !(folder && photos.length);
    if (folder) all.href = folder;

    grid.textContent = '';
    var frag = document.createDocumentFragment();
    photos.forEach(function (p, i) { frag.appendChild(tile(p, i)); });
    grid.appendChild(frag);
    $('empty').hidden = photos.length > 0;

    lockView.hidden = true;
    openView.hidden = false;
    input.value = '';
    history.replaceState(null, '', location.pathname + '#kod=' + encodeURIComponent(code));
    window.scrollTo(0, 0);
    heading.focus();
  }

  function unlock(raw) {
    var code = norm(raw);
    clearError();
    if (!code) {
      showLock('');
      err.textContent = 'Zadajte kód zo správy, ktorú ste odo mňa dostali.';
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    if (code === current || code === pending) return;
    pending = code;
    setBusy(true);
    fetchGallery(code).then(function (g) {
      if (pending !== code) return;
      pending = '';
      setBusy(false);
      if (g && g.ok !== false && Array.isArray(g.photos)) { showGallery(g, code); return; }
      showLock(code);
      showError(g && g.error === 'busy' ? 'busy' : 'not_found', code);
      input.focus();
    }, function (e) {
      if (pending !== code) return;
      pending = '';
      setBusy(false);
      showLock(code);
      showError(e && e.kind === 'server' ? 'server' : 'network', code);
      retry.focus();
    });
  }

  // ---------- events ----------
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    unlock(input.value);
  });
  input.addEventListener('input', clearError);
  retry.addEventListener('click', function () { unlock(input.value); });
  $('relock').addEventListener('click', function () {
    showLock('');
    history.replaceState(null, '', location.pathname);
    input.focus();
  });
  window.addEventListener('hashchange', function () {
    var c = codeFromUrl();
    if (c && norm(c) !== current) unlock(c);
  });

  // a link like galeria/#kod=AB12CD34 opens the gallery straight away; ?kod= comes from the form when JS was off on the home page
  var initial = codeFromUrl();
  if (initial) unlock(initial);
})();
