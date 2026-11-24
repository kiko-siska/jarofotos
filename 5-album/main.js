/* Direction 5 (his "Verzia E"): lightbox, the menu marking the section in view, his fade-up reveal, his category view
   (#kat-<id>) and the client code form.
   Without this script the page is still complete: every photo shows, photos open as image files, the code form submits
   to galeria/?kod=... and the contact links (phone, e-mail, Instagram, Facebook) are plain links. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var home = $('home'), view = $('kat-view'), menu = $('menu');
  var TITLE = document.title;
  var lastCat = null; // category whose view is open, to return to it on Back

  JFLightbox({ selector: 'a[data-lightbox]', download: true, downloadIcon: true, captions: false });

  // ---------- menu: mark the section in view, keep the marked link visible in the scrolling row ----------
  var links = [].slice.call(menu.querySelectorAll('a[href^="#"]'));
  var sections = links.map(function (a) { return $(a.getAttribute('href').slice(1)); });
  function mark(i) {
    links.forEach(function (a, k) {
      if (k === i) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    if (menu.scrollWidth > menu.clientWidth) {
      var a = links[i];
      var left = a ? a.offsetLeft - (menu.clientWidth - a.offsetWidth) / 2 : 0;
      if (Math.abs(menu.scrollLeft - left) > 8) menu.scrollLeft = left;
    }
  }
  function spy() {
    if (!view.hidden) return;
    var y = window.scrollY + window.innerHeight * 0.3;
    var current = 0;
    sections.forEach(function (s, i) { if (s && s.getBoundingClientRect().top + window.scrollY <= y) current = i; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections.length - 1;
    mark(current);
  }
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; spy(); });
  }, { passive: true });

  // ---------- his reveal: fade up once, strip tiles one after another (the head script adds .rv-on only when it can finish) ----------
  if (document.documentElement.classList.contains('rv-on')) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.rev').forEach(function (el) {
      var p = el.parentNode;
      if (p.classList.contains('strip')) el.style.transitionDelay = ([].indexOf.call(p.children, el) * 70) + 'ms';
      io.observe(el);
    });
  }

  // ---------- his category view: #kat-<section id> shows every photo of that category ----------
  // Only this full-category gallery gets the new treatment. Photos are dealt into columns
  // round-robin: the first row reads left-to-right in camera order, while each column still
  // packs by the photos' own ratios. data-order keeps the lightbox in that same row order.
  var small = window.matchMedia('(max-width: 600px)');
  var SIZES = '(min-width: 1160px) 266px, (min-width: 600px) 22vw, 45vw';
  function renderGrid(sec) {
    var grid = $('kat-grid');
    var photos = [].slice.call(sec.querySelectorAll('.strip a.t'));
    var n = small.matches ? 2 : 4;
    grid.textContent = '';
    var cols = [], i;
    for (i = 0; i < n; i++) {
      var col = document.createElement('div');
      col.className = 'masonry__col';
      cols.push(col);
      grid.appendChild(col);
    }
    photos.forEach(function (t, idx) {
      var a = document.createElement('a');
      a.href = t.getAttribute('href');
      a.setAttribute('data-lightbox', '');
      a.setAttribute('data-order', idx);
      var img = t.querySelector('img').cloneNode(true);
      img.sizes = SIZES;
      a.appendChild(img);
      cols[idx % n].appendChild(a);
    });
    return photos.length;
  }
  function onBreakpoint() { if (!view.hidden && lastCat) renderGrid(lastCat); }
  if (small.addEventListener) small.addEventListener('change', onBreakpoint);
  else if (small.addListener) small.addListener(onBreakpoint);

  function showCategory(sec) {
    var count = renderGrid(sec);
    var name = sec.querySelector('h2').textContent;
    $('kat-title').textContent = name;
    $('kat-count').textContent = 'Počet fotografií: ' + count;
    $('kat-back').href = '#' + sec.id;
    lastCat = sec;
    home.hidden = true;
    view.hidden = false;
    document.title = name + ' – Jarofotos';
    mark(sections.indexOf(sec));
    window.scrollTo(0, 0);
    $('kat-title').focus();
  }
  function route() {
    var h = decodeURIComponent(location.hash.slice(1));
    var sec = h.indexOf('kat-') === 0 ? $(h.slice(4)) : null;
    if (sec && sec.classList.contains('cat')) { showCategory(sec); return; }
    if (!view.hidden) {
      view.hidden = true;
      home.hidden = false;
      $('kat-grid').textContent = '';
      document.title = TITLE;
      // browser Back gives an empty hash: return to the category the view came from, not to the top
      var target = (h && $(h)) || lastCat;
      if (target) target.scrollIntoView({ behavior: 'instant' });
      else window.scrollTo(0, 0);
      // focus was inside the hidden view; hand it to the link that opened it
      var opener = lastCat && lastCat.querySelector('.cat-all');
      if (opener && (!h || target === lastCat)) opener.focus({ preventScroll: true });
      lastCat = null;
    }
    spy();
  }
  window.addEventListener('hashchange', route);
  route();

  // ---------- client code: open the gallery page with the code in the hash (a hash never reaches a server log) ----------
  var form = $('code-form'), input = $('code-input'), err = $('code-err');
  var cfg = window.JAROFOTOS_GALERIA;
  if (cfg && !String(cfg.apiUrl || '').trim()) $('code-demo').hidden = false;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) {
      err.textContent = 'Zadajte kód zo správy, ktorú ste dostali po focení.';
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    location.href = form.getAttribute('action') + '#kod=' + encodeURIComponent(code);
  });
  input.addEventListener('input', function () {
    err.hidden = true;
    input.removeAttribute('aria-invalid');
  });
})();
