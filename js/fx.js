// Segmentasyon sonrası işleme, kompozit ve efektler. Ortamdan bağımsız.
import { newImg, resize, boxBlurF, boxBlurRGB } from './core.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- yardımcılar ----------
function resizeF(m, w, h, nw, nh) {
  if (w === nw && h === nh) return Float32Array.from(m);
  const out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
  if (nw < w && nh < h) { // alan ortalaması
    for (let y = 0; y < nh; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < nw; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
        let s = 0, c = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { s += m[yy * w + xx]; c++; }
        out[y * nw + x] = s / c;
      }
    }
    return out;
  }
  for (let y = 0; y < nh; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, h - 1), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, w - 1), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), dx = fx - x0;
      const t = m[y0 * w + x0] + (m[y0 * w + x1] - m[y0 * w + x0]) * dx;
      const b = m[y1 * w + x0] + (m[y1 * w + x1] - m[y1 * w + x0]) * dx;
      out[y * nw + x] = t + (b - t) * dy;
    }
  }
  return out;
}

function gray(img) {
  const n = img.w * img.h, g = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  return g;
}

// Bağlı bileşenler: ana öznenin dışındaki küçük lekeleri sil
function cleanBlobs(a, w, h) {
  const n = w * h, lab = new Int32Array(n), sizes = [0];
  const stack = new Int32Array(n);
  let L = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] < 0.35 || lab[i]) continue;
    L++; let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = L;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !lab[p - 1] && a[p - 1] >= 0.35) { lab[p - 1] = L; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && a[p + 1] >= 0.35) { lab[p + 1] = L; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - w] && a[p - w] >= 0.35) { lab[p - w] = L; stack[sp++] = p - w; }
      if (y < h - 1 && !lab[p + w] && a[p + w] >= 0.35) { lab[p + w] = L; stack[sp++] = p + w; }
    }
    sizes.push(cnt);
  }
  if (L <= 1) return a;
  const big = Math.max(...sizes);
  const keep = sizes.map(s => s >= big * 0.12 || s >= n * 0.02);
  // tutulan bileşenlerin yakınındaki yumuşak pikseller kalsın, uzaktakiler silinsin
  const km = new Float32Array(n);
  for (let i = 0; i < n; i++) km[i] = lab[i] && keep[lab[i]] ? 1 : 0;
  const near = boxBlurF(km, w, h, Math.max(3, Math.round(w / 90)), 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (lab[i] && !keep[lab[i]]) { out[i] = 0; continue; }
    out[i] = near[i] > 0.001 ? a[i] : 0;
  }
  return out;
}

// Guided filter (He ve ark.) – alfa kenarlarını görüntü kenarlarına oturtur
function guided(I, p, w, h, r, eps) {
  const box = arr => boxBlurF(arr, w, h, r, 1);
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = box(I), mp = box(p), mIp = box(Ip), mII = box(II);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], vr = mII[i] - mI[i] * mI[i];
    A[i] = cov / (vr + eps); B[i] = mp[i] - A[i] * mI[i];
  }
  const mA = box(A), mB = box(B), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
  return q;
}

// ---------- ana segmentasyon (ORMBG / ISNet, 1024×1024) ----------
export async function segment(ort, sess, img, onStage) {
  const S = 1024, n = S * S;
  const small = resize(img, S, S), inp = new Float32Array(3 * n), d = small.data;
  for (let i = 0; i < n; i++) { inp[i] = d[i * 4] / 255; inp[n + i] = d[i * 4 + 1] / 255; inp[2 * n + i] = d[i * 4 + 2] / 255; }
  const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) });
  let m = Float32Array.from(res[sess.outputNames[0]].data);
  let mx = 0; for (let i = 0; i < n; i++) if (m[i] > mx) mx = m[i];
  if (mx > 0 && mx < 0.98) for (let i = 0; i < n; i++) m[i] /= mx;
  onStage && onStage('Kenarlar iyileştiriliyor…');
  // 1024 karede leke temizliği (en-boy oranı bozuk ama topoloji aynı)
  m = cleanBlobs(m, S, S);
  // çalışma çözünürlüğü: uzun kenar ≤ 2048
  const k = Math.min(1, 2048 / Math.max(img.w, img.h));
  const ww = Math.max(1, Math.round(img.w * k)), wh = Math.max(1, Math.round(img.h * k));
  const work = k < 1 ? resize(img, ww, wh) : img;
  let a = resizeF(m, S, S, ww, wh);
  const I = gray(work);
  const r = Math.max(2, Math.round(Math.max(ww, wh) / 400));
  const g = guided(I, a, ww, wh, r, 2e-3);
  // yalnızca belirsiz kenar bandında guided sonucu kullan; iç ve dış kararlı kalsın
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const band = v > 0.02 && v < 0.98 ? 1 : (v <= 0.02 ? Math.max(0, 1 - (0.02 - v) * 0) : 0);
    let q = v <= 0.02 || v >= 0.98 ? v : g[i];
    q = v > 0.002 && v < 0.998 ? g[i] * 0.85 + v * 0.15 : v;
    a[i] = clamp((q - 0.03) / 0.94, 0, 1);
    void band;
  }
  if (k < 1) a = resizeF(a, ww, wh, img.w, img.h);
  const out = new Uint8ClampedArray(img.w * img.h);
  for (let i = 0; i < out.length; i++) out[i] = a[i] * 255 + 0.5;
  return out; // tam çözünürlük alfa (0..255)
}

// ---------- ön plan rengi tahmini (eski arka plan rengini kenarlardan temizle) ----------
export function cutout(img, alpha) {
  const { w, h, data } = img, n = w * h;
  const r = Math.max(3, Math.round(Math.max(w, h) * 0.012));
  const bgw = new Float32Array(n), bg = newImg(w, h);
  for (let i = 0; i < n; i++) {
    const b = 1 - alpha[i] / 255; const wb = b * b; bgw[i] = wb;
    bg.data[i * 4] = data[i * 4] * wb; bg.data[i * 4 + 1] = data[i * 4 + 1] * wb; bg.data[i * 4 + 2] = data[i * 4 + 2] * wb;
  }
  const bb = boxBlurRGB(bg, r, 2), wbb = boxBlurF(bgw, w, h, r, 2);
  const out = newImg(w, h), o = out.data;
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255, q = i * 4;
    o[q + 3] = alpha[i];
    if (a >= 0.97 || a <= 0.01 || wbb[i] < 1e-3) { o[q] = data[q]; o[q + 1] = data[q + 1]; o[q + 2] = data[q + 2]; continue; }
    for (let c = 0; c < 3; c++) {
      const B = bb.data[q + c] / wbb[i];
      const F = (data[q + c] - (1 - a) * B) / Math.max(a, 0.15);
      o[q + c] = F * 0.85 + data[q + c] * 0.15;
    }
  }
  return out;
}

// ---------- kompozit: cutout (RGBA) üzerine arka plan ----------
// bg: aynı boyutta RGB görüntü. harmonize: 0..1 (öznenin renk ortalamasını sahneye yaklaştır)
export function composite(cut, bg, opts = {}) {
  const { w, h } = cut, n = w * h, c = cut.data, b = bg.data;
  const out = newImg(w, h), o = out.data;
  let hm = [1, 1, 1], light = null;
  if (opts.harmonize) {
    let fs = [0, 0, 0], fc = 0, bs = [0, 0, 0], bc = 0;
    const st = Math.max(1, Math.floor(n / 200000));
    for (let i = 0; i < n; i += st) {
      const a = c[i * 4 + 3] / 255;
      if (a > 0.9) { fs[0] += c[i * 4]; fs[1] += c[i * 4 + 1]; fs[2] += c[i * 4 + 2]; fc++; }
      bs[0] += b[i * 4]; bs[1] += b[i * 4 + 1]; bs[2] += b[i * 4 + 2]; bc++;
    }
    if (fc > 10) {
      const fm = fs.map(v => v / fc), bm = bs.map(v => v / bc);
      const fl = (fm[0] + fm[1] + fm[2]) / 3 || 1, bl = (bm[0] + bm[1] + bm[2]) / 3 || 1;
      // yalnızca renk tonu (kromatik oran) aktarımı, parlaklık korunur
      hm = [0, 1, 2].map(k => 1 + opts.harmonize * 0.35 * ((bm[k] / bl) / (fm[k] / fl) - 1));
      hm = hm.map(v => clamp(v, 0.85, 1.15));
    }
    // ışık sarması: kenarlarda arka plan ışığı
    light = boxBlurRGB(bg, Math.max(2, Math.round(Math.max(w, h) * 0.01)), 1);
  }
  for (let i = 0; i < n; i++) {
    const q = i * 4, a = c[q + 3] / 255;
    const wrap = light ? Math.max(0, Math.min(1, (1 - a) * 2.2)) * (a > 0.02 ? 0.25 * opts.harmonize : 0) : 0;
    for (let k = 0; k < 3; k++) {
      let f = c[q + k] * hm[k];
      if (wrap) f = f * (1 - wrap) + light.data[q + k] * wrap;
      o[q + k] = f * a + b[q + k] * (1 - a);
    }
    o[q + 3] = 255;
  }
  return out;
}

// ---------- arka plan üretimi ----------
// spec: {type:'color', c:'#rrggbb'} | {type:'grad', a, b, angle} | {type:'img', img} | {type:'blur', amount} | {type:'none'}
export function hexRgb(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
export function solidBg(w, h, hex) {
  const o = newImg(w, h), [r, g, b] = hexRgb(hex);
  for (let i = 0; i < w * h; i++) { o.data[i * 4] = r; o.data[i * 4 + 1] = g; o.data[i * 4 + 2] = b; o.data[i * 4 + 3] = 255; }
  return o;
}
export function gradBg(w, h, a, b, angle = 160, radial = false) {
  const o = newImg(w, h), A = hexRgb(a), B = hexRgb(b);
  const t = angle * Math.PI / 180, cx = Math.sin(t), cy = -Math.cos(t);
  const half = Math.abs(cx) * w / 2 + Math.abs(cy) * h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let p;
    if (radial) p = clamp(Math.hypot((x - w / 2) / (w * 0.75), (y - h * 0.4) / (h * 0.75)), 0, 1);
    else p = clamp(((x - w / 2) * cx + (y - h / 2) * cy) / (2 * half) + 0.5, 0, 1);
    const q = (y * w + x) * 4;
    o.data[q] = A[0] + (B[0] - A[0]) * p; o.data[q + 1] = A[1] + (B[1] - A[1]) * p; o.data[q + 2] = A[2] + (B[2] - A[2]) * p; o.data[q + 3] = 255;
  }
  return o;
}
// görseli w×h'ye "cover" yerleştir (ox, oy: -1..1 kaydırma, zoom ≥1)
export function coverImg(src, w, h, ox = 0, oy = 0, zoom = 1) {
  const k = Math.max(w / src.w, h / src.h) * zoom;
  const cw = w / k, ch = h / k;
  const sx = (src.w - cw) / 2 * (1 + ox), sy = (src.h - ch) / 2 * (1 + oy);
  const crop = cropImg(src, Math.round(sx), Math.round(sy), Math.round(cw), Math.round(ch));
  return resize(crop, w, h);
}
export function cropImg(src, x, y, w, h, fill) {
  const o = newImg(w, h);
  for (let yy = 0; yy < h; yy++) {
    const sy = y + yy;
    for (let xx = 0; xx < w; xx++) {
      const sx = x + xx, q = (yy * w + xx) * 4;
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) {
        if (fill === 'edge') { const p = (clamp(sy, 0, src.h - 1) * src.w + clamp(sx, 0, src.w - 1)) * 4; o.data[q] = src.data[p]; o.data[q + 1] = src.data[p + 1]; o.data[q + 2] = src.data[p + 2]; o.data[q + 3] = src.data[p + 3]; }
        continue;
      }
      const p = (sy * src.w + sx) * 4;
      o.data[q] = src.data[p]; o.data[q + 1] = src.data[p + 1]; o.data[q + 2] = src.data[p + 2]; o.data[q + 3] = src.data[p + 3];
    }
  }
  return o;
}
export function cropAlpha(a, aw, ah, x, y, w, h) {
  const o = new Uint8ClampedArray(w * h);
  for (let yy = 0; yy < h; yy++) { const sy = y + yy; if (sy < 0 || sy >= ah) continue; for (let xx = 0; xx < w; xx++) { const sx = x + xx; if (sx >= 0 && sx < aw) o[yy * w + xx] = a[sy * aw + sx]; } }
  return o;
}

// arka plan yalnızca (özne çıkarılmış) bulanıklaştırma: özne rengi taşmaz
export function maskedBlur(img, alpha, r, passes = 3, horizontalOnly = false) {
  const { w, h } = img, n = w * h;
  const bg = newImg(w, h), wgt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = 1 - Math.min(1, alpha[i] / 255 * 1.4); wgt[i] = b;
    bg.data[i * 4] = img.data[i * 4] * b; bg.data[i * 4 + 1] = img.data[i * 4 + 1] * b; bg.data[i * 4 + 2] = img.data[i * 4 + 2] * b;
  }
  let bl, wb;
  if (horizontalOnly) { bl = hBlurRGB(bg, r, passes); wb = hBlurF(wgt, w, h, r, passes); }
  else { bl = boxBlurRGB(bg, r, passes); wb = boxBlurF(wgt, w, h, r, passes); }
  const out = newImg(w, h);
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    if (wb[i] > 1e-3) { out.data[q] = bl.data[q] / wb[i]; out.data[q + 1] = bl.data[q + 1] / wb[i]; out.data[q + 2] = bl.data[q + 2] / wb[i]; }
    else { out.data[q] = img.data[q]; out.data[q + 1] = img.data[q + 1]; out.data[q + 2] = img.data[q + 2]; }
    out.data[q + 3] = 255;
  }
  return out;
}
function hBlurF(arr, w, h, r, passes) {
  let a = Float32Array.from(arr), b = new Float32Array(a.length);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const base = y * w; let acc = a[base] * (r + 1);
      for (let i = 1; i <= r; i++) acc += a[base + Math.min(i, w - 1)];
      for (let x = 0; x < w; x++) { b[base + x] = acc * inv; acc += a[base + Math.min(x + r + 1, w - 1)] - a[base + Math.max(x - r, 0)]; }
    }
    [a, b] = [b, a];
  }
  return a;
}
function hBlurRGB(img, r, passes) {
  const { w, h } = img, n = w * h, out = newImg(w, h), ch = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) ch[i] = img.data[i * 4 + c];
    const bl = hBlurF(ch, w, h, r, passes);
    for (let i = 0; i < n; i++) out.data[i * 4 + c] = bl[i];
  }
  return out;
}

// ---------- klasik efektler ----------
function mapPix(img, fn) {
  const out = newImg(img.w, img.h), d = img.data, o = out.data;
  for (let i = 0; i < d.length; i += 4) { const r = fn(d[i], d[i + 1], d[i + 2]); o[i] = r[0]; o[i + 1] = r[1]; o[i + 2] = r[2]; o[i + 3] = 255; }
  return out;
}
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const curve = (v, c) => clamp((v - 128) * c + 128, 0, 255);
function mix(subj, bg, alpha) {
  const out = newImg(subj.w, subj.h), s = subj.data, b = bg.data, o = out.data;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] / 255, q = i * 4;
    o[q] = s[q] * a + b[q] * (1 - a); o[q + 1] = s[q + 1] * a + b[q + 1] * (1 - a); o[q + 2] = s[q + 2] * a + b[q + 2] * (1 - a); o[q + 3] = 255;
  }
  return out;
}
export const EFFECTS = [
  { id: 'blur', name: 'Bulanıklaştır', needsMask: true },
  { id: 'splash', name: 'Renk sıçraması', needsMask: true },
  { id: 'motion', name: 'Hareket', needsMask: true },
  { id: 'bwbg', name: 'S-B arka plan + vurgu', needsMask: true },
  { id: 'spot', name: 'Stüdyo spot', needsMask: true },
  { id: 'darkbg', name: 'Koyu arka plan', needsMask: true },
  { id: 'bwlow', name: 'Düşük kontrast S-B', needsMask: false },
  { id: 'bwhigh', name: 'Yüksek kontrast S-B', needsMask: false },
  { id: 'sepia', name: 'Sepya', needsMask: false },
  { id: 'warm', name: 'Sıcak film', needsMask: false },
];
export function applyEffect(id, img, alpha, amount = 0.6) {
  const W = Math.max(img.w, img.h);
  switch (id) {
    case 'blur': return mix(img, maskedBlur(img, alpha, Math.max(2, Math.round(W * 0.03 * amount))), alpha);
    case 'motion': return mix(img, maskedBlur(img, alpha, Math.max(3, Math.round(W * 0.06 * amount)), 3, true), alpha);
    case 'splash': return mix(img, mapPix(img, (r, g, b) => { const l = lum(r, g, b); return [l, l, l]; }), alpha);
    case 'bwbg': {
      const bg = mapPix(maskedBlur(img, alpha, Math.max(2, Math.round(W * 0.008))), (r, g, b) => { const l = curve(lum(r, g, b), 1.25); return [l, l, l]; });
      return mix(img, bg, alpha);
    }
    case 'darkbg': return mix(img, mapPix(img, (r, g, b) => [r * 0.32, g * 0.32, b * 0.36]), alpha);
    case 'spot': {
      // öznenin ağırlık merkezine radyal ışık
      let sx = 0, sy = 0, sc = 0; const w = img.w;
      for (let i = 0; i < alpha.length; i += 7) if (alpha[i] > 128) { sx += i % w; sy += (i / w) | 0; sc++; }
      const cx = sc ? sx / sc : img.w / 2, cy = sc ? sy / sc : img.h / 2;
      const bg = maskedBlur(img, alpha, Math.max(2, Math.round(W * 0.015)));
      const R = W * 0.55;
      for (let y = 0; y < img.h; y++) for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 4, f = 0.25 + 0.75 * Math.max(0, 1 - Math.hypot(x - cx, y - cy) / R) ** 1.5;
        bg.data[q] *= f; bg.data[q + 1] *= f; bg.data[q + 2] *= f;
      }
      return mix(img, bg, alpha);
    }
    case 'bwlow': return mapPix(img, (r, g, b) => { const l = curve(lum(r, g, b), 0.72) * 0.92 + 14; return [l, l, l]; });
    case 'bwhigh': return mapPix(img, (r, g, b) => { let l = lum(r, g, b) / 255; l = l * l * (3 - 2 * l); l = curve(l * 255, 1.35); return [l, l, l]; });
    case 'sepia': return mapPix(img, (r, g, b) => [r * 0.393 + g * 0.769 + b * 0.189, r * 0.349 + g * 0.686 + b * 0.168, r * 0.272 + g * 0.534 + b * 0.131].map(v => v * 0.92 + 8));
    case 'warm': return mapPix(img, (r, g, b) => [curve(r * 1.06 + 6, 1.05), curve(g * 1.0 + 3, 1.05), curve(b * 0.9, 1.05)]);
  }
  return img;
}

// ---------- netlik (yerel kontrast) ----------
export function clarity(img, amount = 0.3, sharpAmt = 0.25) {
  const { w, h } = img, n = w * h, d = img.data;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const big = boxBlurF(L, w, h, Math.max(4, Math.round(Math.max(w, h) / 90)), 2);
  const small = sharpAmt > 0 ? boxBlurF(L, w, h, Math.max(1, Math.round(Math.max(w, h) / 1600)), 1) : null;
  const out = newImg(w, h), o = out.data;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    let dl = (l - big[i]) * amount;
    // aşırıya kaçmayı engelle (hale)
    dl = dl > 18 ? 18 + (dl - 18) * 0.2 : dl < -18 ? -18 + (dl + 18) * 0.2 : dl;
    if (small) { const e = l - small[i]; if (Math.abs(e) > 1.5) dl += e * sharpAmt; }
    const k = (l + dl) / Math.max(1, l);
    const q = i * 4;
    if (l < 1) { o[q] = d[q] + dl; o[q + 1] = d[q + 1] + dl; o[q + 2] = d[q + 2] + dl; }
    else { o[q] = d[q] * k; o[q + 1] = d[q + 1] * k; o[q + 2] = d[q + 2] * k; }
    o[q + 3] = d[q + 3];
  }
  return out;
}

// alfa sınırlayıcı kutu
export function alphaBox(alpha, w, h, thr = 40) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// renk gürültüsü azaltma (YCbCr'de yalnız kroma, kenar korumalı)
export function chromaDenoise(img, strength = 1) {
  const { w, h } = img, n = w * h, d = img.data;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    Y[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255; Cb[i] = (b - Y[i] * 255) / 255; Cr[i] = (r - Y[i] * 255) / 255;
  }
  const r = Math.max(1, Math.round(Math.max(w, h) / 900 * strength));
  const cb = guided(Y, Cb, w, h, r, 4e-3), cr = guided(Y, Cr, w, h, r, 4e-3);
  const out = newImg(w, h), o = out.data;
  for (let i = 0; i < n; i++) {
    const y = Y[i] * 255, B = cb[i] * 255 + y, R = cr[i] * 255 + y, G = (y - 0.299 * R - 0.114 * B) / 0.587;
    o[i * 4] = R; o[i * 4 + 1] = G; o[i * 4 + 2] = B; o[i * 4 + 3] = d[i * 4 + 3];
  }
  return out;
}
