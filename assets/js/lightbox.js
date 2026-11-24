/* Shared lightbox for all three directions. Classic script (works from file:// too), no dependencies.
   Links that carry the selector open their href (the large WebP) in a native <dialog>: Esc closes,
   focus is trapped and restored by the browser, arrow keys and swipe move between photos.
   Without JS the links simply open the image file. */
(function () {
  'use strict';

  var ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>'
  };

  function init(options) {
    var o = options || {};
    var selector = o.selector || 'a[data-lightbox]';
    if (typeof HTMLDialogElement === 'undefined') return { open: function () {} };

    var dlg, img, cap, count, dl;
    var items = [];
    var idx = 0;
    var showCaptions = o.captions !== false;

    // built on first use, so the page carries no empty dialog or image until someone opens a photo
    function build() {
      if (dlg) return;
      dlg = document.createElement('dialog');
      dlg.className = o.className || 'lb';
      dlg.setAttribute('aria-label', 'Fotografia vo veľkom');
      dlg.innerHTML =
        '<div class="lb__stage"><img class="lb__img" alt=""></div>' +
        '<div class="lb__bar">' + (showCaptions ? '<p class="lb__cap" aria-live="polite"></p>' : '') + '<p class="lb__count"></p></div>' +
        '<button class="lb__btn lb__close" type="button" aria-label="Zavrieť">' + ICON.close + '</button>' +
        '<button class="lb__btn lb__prev" type="button" aria-label="Predchádzajúca fotka">' + ICON.prev + '</button>' +
        '<button class="lb__btn lb__next" type="button" aria-label="Ďalšia fotka">' + ICON.next + '</button>';
      document.body.appendChild(dlg);
      img = dlg.querySelector('.lb__img');
      cap = dlg.querySelector('.lb__cap');
      count = dlg.querySelector('.lb__count');
      // opt-in (direction 5's client galleries): a download link for photos whose link carries data-download
      if (o.download) {
        dl = document.createElement('a');
        dl.className = 'lb__dl' + (o.downloadIcon ? ' lb__dl--icon' : '');
        if (o.downloadIcon) {
          dl.innerHTML = ICON.download;
          dl.setAttribute('aria-label', o.downloadLabel || 'Stiahnuť fotku');
        } else {
          dl.textContent = o.downloadLabel || 'Stiahnuť fotku';
        }
        dl.setAttribute('download', '');
        dl.hidden = true;
        dlg.querySelector('.lb__bar').appendChild(dl);
      }

      dlg.querySelector('.lb__close').addEventListener('click', function () { dlg.close(); });
      dlg.querySelector('.lb__prev').addEventListener('click', function () { show(idx - 1); });
      dlg.querySelector('.lb__next').addEventListener('click', function () { show(idx + 1); });
      dlg.addEventListener('close', function () { document.documentElement.classList.remove('lb-open'); });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg || e.target.classList.contains('lb__stage')) dlg.close();
      });
      dlg.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
      });

      // swipe
      var x0 = null;
      var stage = dlg.querySelector('.lb__stage');
      stage.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
      stage.addEventListener('pointerup', function (e) {
        if (x0 === null) return;
        var dx = e.clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50) show(idx + (dx < 0 ? 1 : -1));
      });
      stage.addEventListener('pointercancel', function () { x0 = null; });
    }

    function collect() {
      items = Array.prototype.filter.call(document.querySelectorAll(selector), function (a) {
        return !a.closest('[hidden]');
      });
      // Some grids (direction 5's category view) are dealt into columns for layout, so DOM order
      // is column-major. When links carry data-order, navigate in that source order instead.
      if (items.length && items[0].hasAttribute('data-order')) {
        items.sort(function (a, b) {
          return (+a.getAttribute('data-order')) - (+b.getAttribute('data-order'));
        });
      }
    }

    function show(i) {
      idx = (i + items.length) % items.length;
      var a = items[idx];
      var thumb = a.querySelector('img');
      img.src = a.getAttribute('href');
      img.alt = thumb ? thumb.alt : '';
      if (cap) cap.textContent = a.getAttribute('data-caption') || '';
      count.textContent = (idx + 1) + ' / ' + items.length;
      if (dl) {
        var href = a.getAttribute('data-download') || a.getAttribute('href');
        dl.hidden = !href;
        if (href) dl.href = href;
      }
      // warm the cache for the neighbours
      [1, -1].forEach(function (d) {
        var n = items[(idx + d + items.length) % items.length];
        if (n) new Image().src = n.getAttribute('href');
      });
    }

    function open(a) {
      build();
      collect();
      var i = items.indexOf(a);
      if (i < 0) return;
      show(i);
      if (!dlg.open) dlg.showModal();
      document.documentElement.classList.add('lb-open');
    }

    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest(selector);
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (o.intercept) o.intercept(a, function () { open(a); });
      else open(a);
    });

    return { open: open };
  }

  window.JFLightbox = init;

  // Deal items into n columns: one item per column per row, with the tallest item in each row
  // going to the currently shortest column. Counts stay within one item, but the column bottoms
  // line up far better than with a plain round-robin deal. Returns columns of items.
  window.JFBalanceColumns = function (items, n, heightOf) {
    var cols = [], heights = [], r, i, c;
    for (i = 0; i < n; i++) { cols.push([]); heights.push(0); }
    for (r = 0; r * n < items.length; r++) {
      var row = [];
      for (i = r * n; i < Math.min((r + 1) * n, items.length); i++) row.push({ item: items[i], h: heightOf(items[i]) });
      row.sort(function (a, b) { return b.h - a.h; });
      // shortest columns first, one photo per column in this row (ties keep column order)
      var targets = [];
      for (c = 0; c < n; c++) targets.push(c);
      targets.sort(function (a, b) { return (heights[a] - heights[b]) || (a - b); });
      for (i = 0; i < row.length; i++) {
        cols[targets[i]].push(row[i].item);
        heights[targets[i]] += row[i].h;
      }
    }
    return cols;
  };
})();
