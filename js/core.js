// Görüntü işleme çekirdeği: ortamdan bağımsız (worker, ana thread veya node).
// Görüntü biçimi: { w, h, data: Uint8ClampedArray (RGBA) }

export const newImg = (w, h) => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- yeniden boyutlandırma (alan ortalamalı küçültme / bilinear büyütme) ----------
export function resize(img, nw, nh) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  if (nw === img.w && nh === img.h) return { w: nw, h: nh, data: new Uint8ClampedArray(img.data) };
  if (nw <= img.w && nh <= img.h) return areaDown(img, nw, nh);
  return bilinear(img, nw, nh);
}

function areaDown(img, nw, nh) {
  const { w, h, data } = img, out = newImg(nw, nh), o = out.data;
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    const iy0 = Math.floor(y0), iy1 = Math.min(h, Math.ceil(y1));
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      const ix0 = Math.floor(x0), ix1 = Math.min(w, Math.ceil(x1));
      let r = 0, g = 0, b = 0, a = 0, wt = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        let p = (yy * w + ix0) * 4;
        for (let xx = ix0; xx < ix1; xx++, p += 4) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const ww = wx * wy;
          r += data[p] * ww; g += data[p + 1] * ww; b += data[p + 2] * ww; a += data[p + 3] * ww; wt += ww;
        }
      }
      const q = (y * nw + x) * 4;
      o[q] = r / wt; o[q + 1] = g / wt; o[q + 2] = b / wt; o[q + 3] = a / wt;
    }
  }
  return out;
}

function bilinear(img, nw, nh) {
  const { w, h, data } = img, out = newImg(nw, nh), o = out.data;
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    let fy = (y + 0.5) * sy - 0.5; fy = clamp(fy, 0, h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < nw; x++) {
      let fx = (x + 0.5) * sx - 0.5; fx = clamp(fx, 0, w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), dx = fx - x0;
      const p00 = (y0 * w + x0) * 4, p01 = (y0 * w + x1) * 4, p10 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
      const q = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[p00 + c] + (data[p01 + c] - data[p00 + c]) * dx;
        const bot = data[p10 + c] + (data[p11 + c] - data[p10 + c]) * dx;
        o[q + c] = top + (bot - top) * dy;
      }
    }
  }
  return out;
}

// float tek kanal (alfa) bilinear büyütme
function resizeMask(m, w, h, nw, nh) {
  const out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    let fy = clamp((y + 0.5) * sy - 0.5, 0, h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < nw; x++) {
      let fx = clamp((x + 0.5) * sx - 0.5, 0, w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), dx = fx - x0;
      const t = m[y0 * w + x0] + (m[y0 * w + x1] - m[y0 * w + x0]) * dx;
      const b = m[y1 * w + x0] + (m[y1 * w + x1] - m[y1 * w + x0]) * dx;
      out[y * nw + x] = t + (b - t) * dy;
    }
  }
  return out;
}

// ---------- büyütme (karo tabanlı) ----------
// Karo ızgarası (devam ettirme için dışarıdan da kullanılır)
export function tileGrid(w, h, tile) {
  const out = [], tx = Math.ceil(w / tile), ty = Math.ceil(h / tile);
  for (let y = 0; y < ty; y++) for (let x = 0; x < tx; x++)
    out.push({ i: out.length, x0: x * tile, y0: y * tile, x1: Math.min(w, (x + 1) * tile), y1: Math.min(h, (y + 1) * tile) });
  return out;
}
// opts: { tile, pad, onProgress(p), cancelled(), done: Map(i -> Uint8ClampedArray RGBA çekirdek), onTile(i, rect, data) }
// Çıktı her zaman 4x (model ölçeği). Hedef boyuta indirme çağırana aittir.
export async function upscale(ort, session, img, opts) {
  const S = 4, tile = opts.tile || 128, pad = opts.pad == null ? 10 : opts.pad;
  const { w, h, data } = img;
  const out = newImg(w * S, h * S), o = out.data, OW = out.w;
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const grid = tileGrid(w, h, tile), total = grid.length, done = opts.done || new Map();
  let n = 0;
  for (const g of grid) {
    if (opts.cancelled && opts.cancelled()) throw new Error('İPTAL');
    const cw = (g.x1 - g.x0) * S, ch = (g.y1 - g.y0) * S;
    const prev = done.get(g.i);
    if (prev && prev.length === cw * ch * 4) {
      for (let y = 0; y < ch; y++) o.set(prev.subarray(y * cw * 4, (y + 1) * cw * 4), ((g.y0 * S + y) * OW + g.x0 * S) * 4);
      n++; opts.onProgress && opts.onProgress(n / total, true); continue;
    }
    const ix0 = Math.max(0, g.x0 - pad), iy0 = Math.max(0, g.y0 - pad);
    const ix1 = Math.min(w, g.x1 + pad), iy1 = Math.min(h, g.y1 + pad);
    const iw = ix1 - ix0, ih = iy1 - iy0, np = iw * ih;
    const inp = new Float32Array(3 * np);
    for (let y = 0; y < ih; y++) {
      let p = ((iy0 + y) * w + ix0) * 4, q = y * iw;
      for (let x = 0; x < iw; x++, p += 4, q++) {
        inp[q] = data[p] / 255; inp[np + q] = data[p + 1] / 255; inp[2 * np + q] = data[p + 2] / 255;
      }
    }
    const res = await session.run({ [inName]: new ort.Tensor('float32', inp, [1, 3, ih, iw]) });
    const t = res[outName];
    const od = t.data, ow = iw * S, on = ow * ih * S;
    const ox0 = (g.x0 - ix0) * S, oy0 = (g.y0 - iy0) * S;
    const core = opts.onTile ? new Uint8ClampedArray(cw * ch * 4) : null;
    for (let y = 0; y < ch; y++) {
      let q = ((g.y0 * S + y) * OW + g.x0 * S) * 4, s = (oy0 + y) * ow + ox0;
      for (let x = 0; x < cw; x++, q += 4, s++) {
        o[q] = od[s] * 255 + 0.5; o[q + 1] = od[on + s] * 255 + 0.5; o[q + 2] = od[2 * on + s] * 255 + 0.5; o[q + 3] = 255;
      }
      if (core) core.set(o.subarray(((g.y0 * S + y) * OW + g.x0 * S) * 4, ((g.y0 * S + y) * OW + g.x0 * S + cw) * 4), y * cw * 4);
    }
    if (t.dispose) t.dispose();
    if (core) opts.onTile(g.i, core);
    n++;
    opts.onProgress && opts.onProgress(n / total, false);
  }
  return out;
}

// ---------- SCRFD yüz algılama ----------
export async function detectFaces(ort, session, img, thr = 0.5) {
  const SZ = 640;
  const r = Math.min(SZ / img.w, SZ / img.h);
  const rw = Math.round(img.w * r), rh = Math.round(img.h * r);
  const small = resize(img, rw, rh);
  const n = SZ * SZ, inp = new Float32Array(3 * n).fill(-127.5 / 128); // dolgu: siyah piksel (insightface gibi)
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const p = (y * rw + x) * 4, q = y * SZ + x;
    inp[q] = (small.data[p] - 127.5) / 128; inp[n + q] = (small.data[p + 1] - 127.5) / 128; inp[2 * n + q] = (small.data[p + 2] - 127.5) / 128;
  }
  const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, SZ, SZ]) });
  const outs = session.outputNames.map(k => res[k]);
  const strides = [8, 16, 32], faces = [];
  for (let si = 0; si < 3; si++) {
    const st = strides[si], sc = outs[si].data, bb = outs[si + 3].data, kp = outs[si + 6].data;
    const fw = Math.ceil(SZ / st), cnt = sc.length;
    for (let i = 0; i < cnt; i++) {
      if (sc[i] < thr) continue;
      const loc = i >> 1, ax = (loc % fw) * st, ay = Math.floor(loc / fw) * st;
      const box = [ax - bb[i * 4] * st, ay - bb[i * 4 + 1] * st, ax + bb[i * 4 + 2] * st, ay + bb[i * 4 + 3] * st].map(v => v / r);
      const kps = [];
      for (let k = 0; k < 5; k++) kps.push([(ax + kp[i * 10 + 2 * k] * st) / r, (ay + kp[i * 10 + 2 * k + 1] * st) / r]);
      faces.push({ score: sc[i], box, kps });
    }
  }
  faces.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of faces) {
    if (keep.every(k => iou(k.box, f.box) < 0.4)) keep.push(f);
  }
  return keep;
}
function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
}

// ---------- hizalama ----------
const FFHQ512 = [[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]];

// src noktalarını dst'ye götüren benzerlik dönüşümü (Umeyama, yansımasız) -> [a, b, tx, c, d, ty]
export function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sxx = 0, sxy = 0, var_ = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i][0] - mx, ay = src[i][1] - my, bx = dst[i][0] - nx, by = dst[i][1] - ny;
    sxx += ax * bx + ay * by; sxy += ax * by - ay * bx; var_ += ax * ax + ay * ay;
  }
  const a = sxx / var_, b = sxy / var_; // s*cos, s*sin
  // x' = a*x - b*y + tx ; y' = b*x + a*y + ty
  return [a, -b, nx - (a * mx - b * my), b, a, ny - (b * mx + a * my)];
}
function invert(M) {
  const [a, b, c, d, e, f] = M, det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

// img'den M (src->dst) ile size x size kesit al, normalize CHW [-1,1]
function warpToTensor(img, M, size) {
  const Mi = invert(M), { w, h, data } = img, n = size * size, t = new Float32Array(3 * n);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Mi[0] * x + Mi[1] * y + Mi[2], sy = Mi[3] * x + Mi[4] * y + Mi[5];
    const fx = clamp(sx, 0, w - 1), fy = clamp(sy, 0, h - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const dx = fx - x0, dy = fy - y0, q = y * size + x;
    for (let c = 0; c < 3; c++) {
      const v00 = data[(y0 * w + x0) * 4 + c], v01 = data[(y0 * w + x1) * 4 + c], v10 = data[(y1 * w + x0) * 4 + c], v11 = data[(y1 * w + x1) * 4 + c];
      const v = (v00 + (v01 - v00) * dx) * (1 - dy) + (v10 + (v11 - v10) * dx) * dy;
      t[c * n + q] = v / 127.5 - 1;
    }
  }
  return t;
}

// opts: { kind: 'codeformer'|'gpen', size, fidelity(0..1 doğal), strength, maxFaces, onProgress, cancelled }
export async function restoreFaces(ort, faceSess, img, faces, opts) {
  const size = opts.size, k = size / 512;
  const tpl = FFHQ512.map(p => [p[0] * k, p[1] * k]);
  const list = faces.slice().sort((a, b) => (b.box[2] - b.box[0]) - (a.box[2] - a.box[0])).slice(0, opts.maxFaces || 8);
  let i = 0;
  for (const f of list) {
    if (opts.cancelled && opts.cancelled()) throw new Error('İPTAL');
    const M = similarity(f.kps, tpl);
    const inp = warpToTensor(img, M, size);
    const feeds = { [faceSess.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, size, size]) };
    if (opts.kind === 'codeformer') feeds.w = new ort.Tensor('float64', new Float64Array([clamp(opts.fidelity, 0, 1)]), []);
    const res = await faceSess.run(feeds);
    const outT = res[faceSess.outputNames[0]];
    let st = opts.strength == null ? 1 : opts.strength;
    if (opts.adaptive) {
      // yüz, model çözünürlüğünden çok büyükse (zaten detaylı) etkiyi azalt
      const ratio = 1 / Math.hypot(M[0], M[3]);
      if (ratio > 1.3) st *= clamp(1 - (ratio - 1.3) / 2.5, 0.35, 1);
    }
    pasteBack(img, outT.data, M, size, st, opts.keepDetail == null ? 0.7 : opts.keepDetail);
    i++;
    opts.onProgress && opts.onProgress(i / list.length);
  }
  return list.length;
}

function pasteBack(img, face, M, size, strength, keepDetail) {
  const { w, h, data } = img, n = size * size, Mi = invert(M);
  const cs = [[0, 0], [size, 0], [0, size], [size, size]].map(([x, y]) => [Mi[0] * x + Mi[1] * y + Mi[2], Mi[3] * x + Mi[4] * y + Mi[5]]);
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[0])))), x1 = Math.min(w, Math.ceil(Math.max(...cs.map(c => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map(c => c[1])))), y1 = Math.min(h, Math.ceil(Math.max(...cs.map(c => c[1]))));
  if (x1 <= x0 || y1 <= y0) return;
  // yüz, model çözünürlüğünden büyükse: orijinalin ince detayını (gözenek, kıl) geri ekle → plastik görünüm olmaz
  const ratio = 1 / Math.hypot(M[0], M[3]);
  const rw = x1 - x0, rh = y1 - y0;
  let hp = null;
  if (ratio > 1.2 && keepDetail > 0) {
    const r = Math.max(1, Math.round(ratio * 0.6));
    const reg = newImg(rw, rh);
    for (let y = 0; y < rh; y++) reg.data.set(data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * rw * 4);
    const bl = boxBlurRGB(reg, r, 2);
    hp = new Float32Array(rw * rh * 3);
    for (let i = 0, j = 0; i < rw * rh; i++, j += 3) {
      hp[j] = (reg.data[i * 4] - bl.data[i * 4]) * keepDetail; hp[j + 1] = (reg.data[i * 4 + 1] - bl.data[i * 4 + 1]) * keepDetail; hp[j + 2] = (reg.data[i * 4 + 2] - bl.data[i * 4 + 2]) * keepDetail;
    }
  }
  const erode = size * 0.04, feather = size * 0.12;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const u = M[0] * (x + 0.5) + M[1] * (y + 0.5) + M[2] - 0.5, v = M[3] * (x + 0.5) + M[4] * (y + 0.5) + M[5] - 0.5;
    if (u < 0 || v < 0 || u > size - 1 || v > size - 1) continue;
    const dEdge = Math.min(u, v, size - 1 - u, size - 1 - v) - erode;
    if (dEdge <= 0) continue;
    let m = Math.min(1, dEdge / feather); m = m * m * (3 - 2 * m); m *= strength;
    const ux = Math.floor(u), vy = Math.floor(v), ux1 = Math.min(size - 1, ux + 1), vy1 = Math.min(size - 1, vy + 1), dx = u - ux, dy = v - vy;
    const p = (y * w + x) * 4, hj = hp ? ((y - y0) * rw + (x - x0)) * 3 : 0;
    for (let c = 0; c < 3; c++) {
      const o = c * n;
      const f00 = face[o + vy * size + ux], f01 = face[o + vy * size + ux1], f10 = face[o + vy1 * size + ux], f11 = face[o + vy1 * size + ux1];
      let val = (f00 + (f01 - f00) * dx) * (1 - dy) + (f10 + (f11 - f10) * dx) * dy;
      val = (clamp(val, -1, 1) + 1) * 127.5;
      if (hp) val += hp[hj + c];
      data[p + c] = data[p + c] * (1 - m) + val * m;
    }
  }
}

// ---------- MODNet portre maskesi ----------
export async function matte(ort, session, img) {
  let s = Math.min(1, 512 / Math.min(img.w, img.h)); // küçük görüntüleri büyütme (MODNet bozuluyor)
  if (Math.min(img.w, img.h) * s < 256) s = 256 / Math.min(img.w, img.h);
  if (Math.max(img.w, img.h) * s > 1024) s = 1024 / Math.max(img.w, img.h); // çok uzun görüntüler için sınır
  const rw = Math.max(32, Math.round(img.w * s / 32) * 32), rh = Math.max(32, Math.round(img.h * s / 32) * 32);
  const small = resize(img, rw, rh), n = rw * rh, inp = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    inp[i] = small.data[i * 4] / 127.5 - 1; inp[n + i] = small.data[i * 4 + 1] / 127.5 - 1; inp[2 * n + i] = small.data[i * 4 + 2] / 127.5 - 1;
  }
  const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, rh, rw]) });
  const m = Float32Array.from(res[session.outputNames[0]].data);
  for (let i = 0; i < m.length; i++) m[i] = clamp((m[i] - 0.06) / 0.9, 0, 1); // zayıf yanlış pozitifleri temizle
  return resizeMask(m, rw, rh, img.w, img.h);
}

export function applyAlpha(img, mask) {
  const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
  for (let i = 0; i < mask.length; i++) out.data[i * 4 + 3] = clamp(mask[i], 0, 1) * 255;
  return out;
}

// arka planı bulanıklaştır: amount 0..1
export function blurBackground(img, mask, amount) {
  const r = Math.max(2, Math.round(Math.max(img.w, img.h) * 0.025 * amount));
  // maskeli bulanıklık: öznenin renginin arka plana taşmaması için önmultiply
  const bg = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
  const wgt = new Float32Array(img.w * img.h);
  for (let i = 0; i < wgt.length; i++) {
    const b = 1 - clamp(mask[i] * 1.3, 0, 1);
    wgt[i] = b;
    bg.data[i * 4] *= b; bg.data[i * 4 + 1] *= b; bg.data[i * 4 + 2] *= b;
  }
  const blurred = boxBlurRGB(bg, r, 3);
  const wb = boxBlurF(wgt, img.w, img.h, r, 3);
  const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }, o = out.data, d = img.data, bd = blurred.data;
  for (let i = 0; i < wgt.length; i++) {
    const a = clamp(mask[i], 0, 1), ww = wb[i] > 1e-3 ? wb[i] : 0;
    for (let c = 0; c < 3; c++) {
      const bv = ww ? bd[i * 4 + c] / ww : d[i * 4 + c];
      o[i * 4 + c] = d[i * 4 + c] * a + bv * (1 - a);
    }
  }
  return out;
}

// ---------- bulanıklık yardımcıları (kayan kutu) ----------
function boxPass(src, dst, w, h, r, stride, lineStep, lines, len) {
  // genel tek boyutlu kutu bulanıklığı (kenar tekrarı)
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let acc = src[base] * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[base + Math.min(i, len - 1) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = acc * inv;
      const add = Math.min(i + r + 1, len - 1), rem = Math.max(i - r, 0);
      acc += src[base + add * stride] - src[base + rem * stride];
    }
  }
}
export function boxBlurF(arr, w, h, r, passes = 3) {
  let a = Float32Array.from(arr), b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    boxPass(a, b, w, h, r, 1, w, h, w);
    boxPass(b, a, w, h, r, w, 1, w, h);
  }
  return a;
}
export function boxBlurRGB(img, r, passes = 3) {
  const { w, h } = img, n = w * h, out = newImg(w, h);
  const ch = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) ch[i] = img.data[i * 4 + c];
    const bl = boxBlurF(ch, w, h, r, passes);
    for (let i = 0; i < n; i++) out.data[i * 4 + c] = bl[i];
  }
  for (let i = 0; i < n; i++) out.data[i * 4 + 3] = img.data[i * 4 + 3];
  return out;
}

// ---------- renk / netlik ----------
// p: { auto(bool), brightness, contrast, saturation, warmth (-1..1), sharpen (0..1) }
export function analyzeAuto(img) {
  const hist = new Uint32Array(256), d = img.data, n = img.w * img.h;
  let rs = 0, gs = 0, bs = 0;
  const step = Math.max(1, Math.floor(n / 300000));
  let cnt = 0;
  for (let i = 0; i < n; i += step) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    hist[(0.299 * r + 0.587 * g + 0.114 * b) | 0]++; rs += r; gs += g; bs += b; cnt++;
  }
  const pct = q => { let s = 0; for (let i = 0; i < 256; i++) { s += hist[i]; if (s >= q * cnt) return i; } return 255; };
  let lo = pct(0.005), hi = pct(0.995);
  lo = Math.min(lo, 40); hi = Math.max(hi, 200); // aşırı germeyi önle
  const mid = (pct(0.5) - lo) / Math.max(1, hi - lo);
  const gamma = clamp(Math.log(0.47) / Math.log(clamp(mid, 0.05, 0.95)), 0.75, 1.35);
  // hafif beyaz dengesi (gri dünya, %40 oranında)
  const avg = (rs + gs + bs) / (3 * cnt);
  const wb = [rs, gs, bs].map(s => clamp(1 + 0.4 * (avg / (s / cnt) - 1), 0.9, 1.1));
  return { lo, hi, gamma, wb };
}

export function enhance(img, p, autoInfo) {
  const { w, h } = img, n = w * h;
  const out = { w, h, data: new Uint8ClampedArray(img.data) }, d = out.data;
  const lut = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const A = p.auto ? (autoInfo || analyzeAuto(img)) : null;
  const br = (p.brightness || 0) * 0.25, ct = 1 + (p.contrast || 0) * 0.6, wm = (p.warmth || 0) * 0.08;
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) {
    let v = i / 255;
    if (A) { v = clamp((v * A.wb[c] - A.lo / 255) / ((A.hi - A.lo) / 255), 0, 1); v = Math.pow(v, A.gamma); }
    v = v + br;
    v = (v - 0.5) * ct + 0.5;
    if (c === 0) v += wm; if (c === 2) v -= wm;
    lut[c][i] = clamp(v, 0, 1) * 255;
  }
  const sat = 1 + (p.saturation || 0) + (A ? 0.08 : 0);
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    let r = lut[0][d[q]], g = lut[1][d[q + 1]], b = lut[2][d[q + 2]];
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    }
    d[q] = r; d[q + 1] = g; d[q + 2] = b;
  }
  if (p.sharpen > 0) return sharpen(out, p.sharpen);
  return out;
}

export function sharpen(img, amount) {
  const r = Math.max(1, Math.round(Math.max(img.w, img.h) / 1500));
  const bl = boxBlurRGB(img, r, 2), d = img.data, b = bl.data, out = newImg(img.w, img.h), o = out.data;
  const k = amount * 1.2;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - b[i + c];
      o[i + c] = d[i + c] + (Math.abs(diff) > 2 ? diff * k : 0);
    }
    o[i + 3] = d[i + 3];
  }
  return out;
}
