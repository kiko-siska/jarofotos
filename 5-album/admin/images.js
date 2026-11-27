/* Turns a photo chosen in the admin (any size, straight from the camera or phone) into what the site serves: 480 / 960 / up to
   1600 px wide WebP (JPEG where the browser cannot encode WebP, e.g. Safari), upright, without EXIF (GPS, camera, dates).
   Runs in the browser, so nothing is uploaded anywhere until the owner presses "Zverejniť". */

const MAX = 1600;
const hex = (n) => n.toString(16).padStart(2, '0');

async function decode(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  } catch {
    // very large files or formats createImageBitmap refuses: let an <img> decode it (it also applies the EXIF orientation)
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => {} };
    } catch {
      throw new Error('Súbor sa nepodarilo načítať ako obrázok. Skúste JPG alebo PNG.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const canvasOf = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};
const toBlob = (c, type, q) => (c.convertToBlob ? c.convertToBlob({ type, quality: q }) : new Promise((res) => c.toBlob(res, type, q)));

/** Scales in steps of at most 2x: one big jump from 6000 to 480 px would alias in some browsers. */
function scaleTo(src, sw, sh, w) {
  let cur = src, cw = sw, ch = sh;
  while (cw > w) {
    const nw = Math.max(w, Math.ceil(cw / 2));
    const nh = Math.round((sh * nw) / sw);
    const c = canvasOf(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  if (cur === src) { const c = canvasOf(cw, ch); c.getContext('2d').drawImage(src, 0, 0); cur = c; }
  return cur;
}

/** { w, h, widths, color, ext, blobs: { [width]: Blob } }  (ext is "webp" or "jpg") */
export async function processImage(file) {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error(`„${file.name}“ nie je obrázok.`);
  const d = await decode(file);
  try {
    const w0 = Math.min(MAX, d.w);
    const h0 = Math.round((d.h * w0) / d.w);
    const widths = [480, 960].filter((w) => w < w0).concat([w0]);
    const blobs = {};
    let ext = null;
    // biggest first; every smaller size is scaled from the previous canvas
    let prev = null;
    for (const w of [...widths].reverse()) {
      const c = prev ? scaleTo(prev.c, prev.w, prev.h, w) : scaleTo(d.src, d.w, d.h, w);
      prev = { c, w: c.width, h: c.height };
      let b = ext === 'jpg' ? null : await toBlob(c, 'image/webp', 0.78);
      if (b && b.type === 'image/webp') ext = 'webp';
      else { b = await toBlob(c, 'image/jpeg', 0.82); ext = 'jpg'; }
      blobs[w] = b;
    }
    // a webp/jpg mix across sizes is impossible: if a later size fell back to jpg, redo the earlier ones as jpg
    if (ext === 'jpg') {
      for (const w of widths) {
        if (blobs[w].type === 'image/jpeg') continue;
        const c = scaleTo(d.src, d.w, d.h, w);
        blobs[w] = await toBlob(c, 'image/jpeg', 0.82);
      }
    }
    // dominant colour: the average of a 16 px thumbnail (shown behind the photo while it loads)
    const t = canvasOf(16, Math.max(1, Math.round((16 * h0) / w0)));
    const tc = t.getContext('2d');
    tc.drawImage(prev.c, 0, 0, t.width, t.height);
    const px = tc.getImageData(0, 0, t.width, t.height).data;
    let r = 0, g = 0, b2 = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b2 += px[i + 2]; }
    const n = px.length / 4;
    const color = `#${hex(Math.round(r / n))}${hex(Math.round(g / n))}${hex(Math.round(b2 / n))}`;
    return { w: w0, h: h0, widths, color, ext, blobs };
  } finally {
    d.done();
  }
}

export const readBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
