// Dark rendering for PDF pages: text, lines and the page background are flipped
// to light-on-dark, while embedded images (photos, figures, screenshots) are
// repainted on top with their original colours.
const BG = 23, FG = 233; // darkest and lightest values on a dark page
const SCAN_COVERAGE = 0.6; // an image this large is a scanned page, so it is darkened too

// Invert lightness but keep hue: c' = c + 255 - max - min, then fit into [BG, FG].
function invertLightness(d) {
  const k = (FG - BG) / 255;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const s = 255 - mx - mn;
    d[i] = BG + (r + s) * k;
    d[i + 1] = BG + (g + s) * k;
    d[i + 2] = BG + (b + s) * k;
  }
}

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

// Walks the page's drawing operations to find where each image lands on the canvas.
async function findImages(page, viewport, OPS) {
  const ol = await page.getOperatorList();
  const out = [];
  const stack = [];
  let m = viewport.transform.slice();
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(m); break;
      case OPS.restore: m = stack.pop() || m; break;
      case OPS.transform: m = mul(m, a); break;
      case OPS.paintFormXObjectBegin: stack.push(m); if (a[0]) m = mul(m, a[0]); break;
      case OPS.paintFormXObjectEnd: m = stack.pop() || m; break;
      case OPS.beginGroup: stack.push(m); if (a[0]?.matrix) m = mul(m, a[0].matrix); break;
      case OPS.endGroup: m = stack.pop() || m; break;
      case OPS.paintImageXObject: out.push({ m, id: a[0] }); break;
      case OPS.paintInlineImageXObject: out.push({ m, img: a[0] }); break;
      case OPS.paintImageXObjectRepeat: {
        const [id, sx, sy, pos] = a;
        for (let j = 0; j < pos.length; j += 2) out.push({ m: mul(m, [sx, 0, 0, sy, pos[j], pos[j + 1]]), id });
        break;
      }
      case OPS.paintInlineImageXObjectGroup: {
        const [img, map] = a;
        for (const e of map) out.push({ m: mul(m, e.transform), img });
        break;
      }
    }
  }
  return out;
}

// Turns pdf.js image data into something drawImage accepts.
function drawable(img) {
  if (!img) return null;
  if (img.bitmap) return img.bitmap;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img;
  if (img instanceof HTMLCanvasElement) return img;
  const { width: w, height: h, kind, data } = img;
  if (!data || !w || !h) return null;
  const id = new ImageData(w, h);
  const o = id.data;
  if (kind === 3) o.set(data.subarray(0, w * h * 4));
  else if (kind === 2) for (let i = 0, j = 0; j < o.length; i += 3, j += 4) { o[j] = data[i]; o[j + 1] = data[i + 1]; o[j + 2] = data[i + 2]; o[j + 3] = 255; }
  else if (kind === 1) {
    const row = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      const j = (y * w + x) * 4;
      o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255;
    }
  } else return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

// Image data can still be arriving from the PDF worker, so wait for it briefly.
function lookup(page, id) {
  const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    try { objs.get(id, (data) => { clearTimeout(t); resolve(data); }); }
    catch { clearTimeout(t); resolve(null); }
  });
}

// `source` is the normally rendered page. Returns a new canvas with the dark version.
export async function darkenPage(page, viewport, source, OPS) {
  const W = source.width, H = source.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const px = ctx.getImageData(0, 0, W, H);
  invertLightness(px.data);
  ctx.putImageData(px, 0, 0);

  let images = [];
  try { images = await findImages(page, viewport, OPS); } catch { return out; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const { m, id, img } of images) {
    // Area of the image's unit square on the canvas.
    const area = Math.abs(m[0] * m[3] - m[1] * m[2]);
    if (area > SCAN_COVERAGE * W * H || area < 4) continue;
    const src = drawable(img || (await lookup(page, id)));
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (src) {
      // Same placement pdf.js uses: the image fills the unit square, top edge at y = 1.
      const w = src.width, h = src.height;
      ctx.scale(1 / w, -1 / h);
      ctx.drawImage(src, 0, -h, w, h);
    } else {
      // Image data not available: restore that area from the original render.
      ctx.beginPath();
      ctx.rect(0, 0, 1, 1);
      ctx.clip();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(source, 0, 0);
    }
    ctx.restore();
  }
  return out;
}
