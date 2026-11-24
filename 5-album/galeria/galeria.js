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
  var SIZES = '(min-width: 1160px) 266px, (min-width: 600px) 22vw, 45vw'; // 4 columns, 2 on phones
  var small = window.matchMedia('(max-width: 600px)');

  var $ = function (id) { return document.getElementById(id); };
  var lockView = $('lock'), openView = $('open'), form = $('code-form'), input = $('code-input'), submit = $('code-submit');
  var err = $('code-err'), statusEl = $('status'), retry = $('retry'), grid = $('grid'), heading = $('h-open'), all = $('all');
  var current = ''; // code of the open gallery
  var pending = ''; // code being loaded
  var galleryPhotos = []; // photos in the open gallery, used by the "Stiahnuť galériu" button
  var allFolder = ''; // Google Drive folder URL when the API supplies one

  JFLightbox({ selector: '#grid a[data-lightbox]', download: true, downloadIcon: true, captions: false });
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

  // ---------- ZIP export (store, no compression: the photos are already compressed WebP/JPEG) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    var localParts = [], centralParts = [], offset = 0, centralSize = 0;
    var enc = new TextEncoder();
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var data = f.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);

      localParts.push(local, data);
      centralParts.push(central);
      offset += local.length + data.length;
      centralSize += central.length;
    });

    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(localParts.concat(centralParts, [end]), { type: 'application/zip' });
  }

  function zipName(p, i, url) {
    var fromUrl = '';
    try { fromUrl = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch (e) {}
    var ext = (fromUrl.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'jpg';
    var base = (p.name || fromUrl || ('fotka-' + (i + 1)))
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || ('fotka-' + (i + 1));
    return (i + 1) + '-' + base + '.' + ext.toLowerCase();
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function downloadAll() {
    if (!galleryPhotos.length) return;
    all.disabled = true;
    all.textContent = 'Pripravujem ZIP…';

    Promise.all(galleryPhotos.map(function (p, i) {
      var url = p.dl || p.full;
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        return { name: zipName(p, i, url), data: new Uint8Array(buf) };
      });
    })).then(function (files) {
      saveBlob(makeZip(files), 'jarofotos-galeria.zip');
      all.textContent = 'Stiahnuť galériu';
      all.disabled = false;
    }, function () {
      all.textContent = 'Stiahnuť galériu';
      all.disabled = false;
      if (allFolder) window.open(allFolder, '_blank', 'noopener');
      else galleryPhotos.forEach(function (p) {
        var url = p.dl || p.full;
        if (!url) return;
        var a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    });
  }

  function showLock(code) {
    openView.hidden = true;
    lockView.hidden = false;
    grid.textContent = '';
    current = '';
    document.title = TITLE;
    if (code !== undefined) input.value = code;
  }

  function tile(p) {
    var fig = document.createElement('figure');
    fig.className = 'tile';

    var a = document.createElement('a');
    a.className = 'tile__open';
    a.href = p.full;
    a.setAttribute('data-lightbox', '');
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

    return fig;
  }

  // Same balanced deal as the category gallery: one photo per column per row, tallest into the
  // shortest column, with data-order assigned by visual row so the lightbox arrows follow it.
  function renderGrid() {
    var n = small.matches ? 2 : 4;
    var figs = galleryPhotos.map(function (p) { return tile(p); });
    var cols = JFBalanceColumns(figs, n, function (fig) {
      var img = fig.querySelector('img');
      return 1 / (img.width && img.height ? img.width / img.height : 1);
    });
    var order = 0, r, c;
    for (r = 0; r * n < figs.length; r++) {
      for (c = 0; c < n; c++) if (cols[c][r]) cols[c][r].querySelector('a').setAttribute('data-order', order++);
    }
    grid.textContent = '';
    var frag = document.createDocumentFragment();
    for (c = 0; c < n; c++) {
      var col = document.createElement('div');
      col.className = 'masonry__col';
      cols[c].forEach(function (fig) { col.appendChild(fig); });
      frag.appendChild(col);
    }
    grid.appendChild(frag);
  }
  function onBreakpoint() { if (!openView.hidden && current) renderGrid(); }
  if (small.addEventListener) small.addEventListener('change', onBreakpoint);
  else if (small.addListener) small.addListener(onBreakpoint);

  function showGallery(g, code) {
    var list = g.photos || [];
    var photos = list.map(function (p, i) { return toPhoto(p || {}, i, list.length); }).filter(function (p) { return p.src; });
    var title = String(g.title || 'Vaše fotky');
    current = code;
    galleryPhotos = photos;

    heading.textContent = title;
    document.title = title + ' – Jarofotos';
    var until = dateLabel(g.until);
    $('meta').textContent = 'Počet fotografií: ' + photos.length + (until ? '. Galéria je otvorená do ' + until + '.' : '');
    $('demo-banner').hidden = !!API;

    var folder = safeUrl(g.folder);
    allFolder = folder;
    all.hidden = photos.length === 0;

    renderGrid();
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
  all.addEventListener('click', downloadAll);
  window.addEventListener('hashchange', function () {
    var c = codeFromUrl();
    if (c && norm(c) !== current) unlock(c);
  });

  // a link like galeria/#kod=AB12CD34 opens the gallery straight away; ?kod= comes from the form when JS was off on the home page
  var initial = codeFromUrl();
  if (initial) unlock(initial);
})();
