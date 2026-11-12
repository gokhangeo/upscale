// Model yönetimi + işler. Worker'da (ya da gerekirse ana thread'de) çalışır.
import * as C from './core.js?v=14';
import * as F from './fx.js?v=14';

const HF = 'https://huggingface.co/OwlMaster/AllFilesRope/resolve/d783e61585b3d83a85c91ca8a3b299e8ade94d72/';
export const MODELS = {
  fast: { url: HF + 'realesr-general-x4v3.onnx', mb: 4.9, name: 'Büyütme – Hızlı (Real-ESRGAN v3)', gpu: true },
  best: { url: HF + 'RealESRGAN_x4plus.fp16.onnx', mb: 33.6, name: 'Büyütme – En iyi (Real-ESRGAN x4plus)', gpu: true },
  det: { url: HF + 'scrfd_2.5g_bnkps.onnx', mb: 3.3, name: 'Yüz algılama (SCRFD)', gpu: false },
  gpen: { url: HF + 'GPEN-BFR-256.onnx', mb: 75.7, name: 'Yüz iyileştirme – Doğal (GPEN)', gpu: true },
  codeformer: { url: HF + 'codeformer_fp16.onnx', mb: 188.6, name: 'Yüz iyileştirme – Güçlü (CodeFormer)', gpu: true },
  // ORMBG (Apache-2.0, ISNet tabanlı, insan odaklı). int8 → her zaman CPU/WASM (kuantize oplar GPU'da yavaş/eksik)
  seg: { url: 'https://huggingface.co/onnx-community/ormbg-ONNX/resolve/034e2d884afbab897e10e78fc5bb566b29533fd6/onnx/model_quantized.onnx', mb: 44.3, name: 'Arka plan ayırma (ORMBG)', gpu: false },
};
const CACHE = 'bulut-models-v1';
const IOS_DEV = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID_DEV = /Android/i.test(navigator.userAgent);
  const MEM_BUDGET_MB = IOS_DEV ? 50 : ANDROID_DEV ? 120 : (300);
export const TILE = 256;

export function makeHandler(ort, post) {
  let gpuOK = false, cancelled = false, gpuOff = new Set();
  const sessions = new Map();

  async function init(a) {
    ort.env.logLevel = 'error';
    const coi = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    ort.env.wasm.numThreads = coi ? Math.max(1, Math.min(ios ? 2 : 4, navigator.hardwareConcurrency || 2)) : 1;
    gpuOff = new Set((a && a.gpuOff) || []);
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu && !(a && a.noGpu)) {
        const ad = await navigator.gpu.requestAdapter();
        gpuOK = !!ad;
      }
    } catch { gpuOK = false; }
    return { ok: true, gpu: gpuOK, threads: ort.env.wasm.numThreads, coi };
  }

  async function cachedStatus() {
    const res = {};
    let cache = null;
    try { cache = await caches.open(CACHE); } catch {}
    for (const k of Object.keys(MODELS)) res[k] = cache ? !!(await cache.match(MODELS[k].url)) : false;
    return res;
  }

  async function fetchModel(key) {
    const m = MODELS[key];
    let cache = null;
    try { cache = await caches.open(CACHE); } catch {}
    if (cache) {
      const hit = await cache.match(m.url);
      if (hit) return await hit.arrayBuffer();
    }
    post({ type: 'stage', text: m.name + ' indiriliyor (bir kez)…', p: 0, kind: 'download' });
    const r = await fetch(m.url, { mode: 'cors' });
    if (!r.ok) throw new Error('Model indirilemedi (' + r.status + ')');
    const total = +r.headers.get('content-length') || m.mb * 1e6;
    const reader = r.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      post({ type: 'progress', p: Math.min(1, got / total), sub: (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB' });
    }
    const buf = new Uint8Array(got); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    if (cache) { try { await cache.put(m.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch {} }
    return buf.buffer;
  }

  async function freeMemory(needMb, keepKeys) {
    let used = 0; for (const [k] of sessions) used += MODELS[k].mb;
    if (used + needMb <= MEM_BUDGET_MB) return;
    const list = [...sessions.entries()].filter(([k]) => !keepKeys.includes(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k, s] of list) {
      try { await s.sess.release(); } catch {}
      sessions.delete(k); used -= MODELS[k].mb;
      if (used + needMb <= MEM_BUDGET_MB) break;
    }
  }

  async function createSession(key, ep, buf) {
    buf = buf || await fetchModel(key);
    post({ type: 'stage', text: 'Model hazırlanıyor…', p: null, kind: 'prepare' });
    // iOS Safari / bazı GPU'larda NHWC düzeni "OpKernelContext::OutputMLValue" hatası veriyor → NCHW zorunlu
    const opts = ep === 'webgpu'
      ? { executionProviders: [{ name: 'webgpu', preferredLayout: 'NCHW' }], graphOptimizationLevel: 'all', logSeverityLevel: 3 }
      : { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    return { sess: await ort.InferenceSession.create(new Uint8Array(buf), opts), buf };
  }

  async function getSession(key, keep) {
    if (sessions.has(key)) { const s = sessions.get(key); s.used = Date.now(); return s.proxy; }
    await freeMemory(MODELS[key].mb, keep || []);
    const entry = { ep: 'wasm', used: Date.now(), runs: 0, retried: false };
    let buf = null;
    if (gpuOK && MODELS[key].gpu && !gpuOff.has(key)) {
      try { const r = await createSession(key, 'webgpu'); entry.sess = r.sess; buf = r.buf; entry.ep = 'webgpu'; }
      catch (e) { post({ type: 'gpuFail', key, text: String(e && e.message || e) }); }
    }
    if (!entry.sess) entry.sess = (await createSession(key, 'wasm', buf)).sess;
    const toWasm = async (why) => {
      post({ type: 'gpuFail', key, text: why });
      post({ type: 'note', text: 'Bu cihazda GPU bu modelde çalışmadı; CPU ile devam ediliyor.' });
      try { await entry.sess.release(); } catch {}
      entry.sess = (await createSession(key, 'wasm')).sess; entry.ep = 'wasm';
      post({ type: 'ep', ep: 'wasm' });
    };
    entry.proxy = {
      get inputNames() { return entry.sess.inputNames; },
      get outputNames() { return entry.sess.outputNames; },
      get ep() { return entry.ep; },
      async run(feeds) {
        if (entry.ep !== 'webgpu') return await entry.sess.run(feeds);
        try {
          const r = await entry.sess.run(feeds);
          if (!entry.runs) {
            const d = r[entry.sess.outputNames[0]].data;
            for (let i = 0; i < d.length; i += 97) if (!Number.isFinite(d[i])) { await toWasm('geçersiz çıktı (NaN)'); return await entry.sess.run(feeds); }
          }
          entry.runs++;
          return r;
        } catch (e) {
          const msg = String(e && e.message || e);
          if (entry.runs > 0 && !entry.retried) {
            // önceden çalışıyordu: büyük ihtimalle uygulama arka plana alındı / GPU cihazı kaybedildi → GPU oturumunu yenile
            entry.retried = true;
            try { await entry.sess.release(); } catch {}
            try { entry.sess = (await createSession(key, 'webgpu')).sess; return await entry.sess.run(feeds); } catch {}
          }
          await toWasm(msg);
          return await entry.sess.run(feeds);
        }
      },
    };
    sessions.set(key, entry);
    return entry.proxy;
  }

  const isCancelled = () => cancelled;
  const img = a => ({ w: a.w, h: a.h, data: new Uint8ClampedArray(a.buffer) });
  const stage = (text, p = null, kind = 'work') => post({ type: 'stage', text, p, kind });

  // SR planı: model girişi boyutu (devam ettirmede aynı plan kullanılır)
  function srPlan(src, targetW, targetH, gpu, a) {
    if (a.plan) return a.plan;
    const budget = (gpu ? a.gpuBudget : a.cpuBudget) || (gpu ? 4.2e6 : 1.2e6);
    let iw = src.w, ih = src.h;
    const minPix = (targetW * targetH) / 16; // 4x model çıktısı hedefi karşılasın
    const want = Math.max(minPix, Math.min(src.w * src.h, budget));
    if (iw * ih > want) { const k = Math.sqrt(want / (iw * ih)); iw = Math.max(16, Math.round(src.w * k)); ih = Math.max(16, Math.round(src.h * k)); }
    return { iw, ih, tw: targetW, th: targetH };
  }

  async function runSR(src, modelKey, targetW, targetH, a, keep, share = [0, 1]) {
    const sess = await getSession(modelKey, keep);
    const gpu = sess.ep === 'webgpu';
    const plan = srPlan(src, targetW, targetH, gpu, a);
    post({ type: 'plan', plan });
    const input = plan.iw === src.w && plan.ih === src.h ? src : C.resize(src, plan.iw, plan.ih);
    const done = new Map((a.done || []).map(([i, b]) => [i, new Uint8ClampedArray(b)]));
    stage((a.label || 'Büyütülüyor') + ' (' + (gpu ? 'GPU' : 'CPU') + ')…', share[0]);
    post({ type: 'ep', ep: sess.ep });
    let out = await C.upscale(ort, sess, input, {
      tile: TILE, pad: 10,
      done,
      onTile: a.track ? (i, data) => post({ type: 'tile', i, buffer: data.buffer }, [data.buffer]) : null,
      onProgress: (p, skipped) => post({ type: 'progress', p: share[0] + (share[1] - share[0]) * p, skipped }),
      cancelled: isCancelled,
    });
    if (out.w !== targetW || out.h !== targetH) out = C.resize(out, targetW, targetH);
    return { out, ep: sess.ep };
  }

  async function faceRestore(out, faces, model, s, share, keep) {
    const fs = await getSession(model, keep);
    stage('Yüz iyileştiriliyor (' + faces.length + ')…', share[0]);
    await C.restoreFaces(ort, fs, out, faces, {
      kind: model === 'codeformer' ? 'codeformer' : 'gpen',
      size: model === 'codeformer' ? 512 : 256,
      fidelity: 1 - 0.7 * s,
      strength: model === 'codeformer' ? 0.6 + 0.4 * s : 0.55 + 0.4 * s,
      adaptive: false,
      keepDetail: 0.9 - 0.5 * s,
      maxFaces: 8,
      onProgress: p => post({ type: 'progress', p: share[0] + (share[1] - share[0]) * p }),
      cancelled: isCancelled,
    });
  }

  async function findFaces(src, keep) {
    const det = await getSession('det', keep);
    stage('Yüzler aranıyor…');
    const f = await C.detectFaces(ort, det, src, 0.5);
    return f.filter(x => (x.box[2] - x.box[0]) > Math.max(14, Math.min(src.w, src.h) * 0.02));
  }

  // Büyüt: hedef = src × scale (çıktı sınırı içinde)
  async function jobUpscale(a) {
    const src = img(a.img);
    const scale = a.scale === 4 ? 4 : 2;
    let tw = src.w * scale, th = src.h * scale;
    if (tw * th > a.maxOutPixels) { const k = Math.sqrt(a.maxOutPixels / (tw * th)); tw = Math.floor(tw * k); th = Math.floor(th * k); }
    const face = a.face;
    const keep = [a.model, 'det'].concat(face ? [face.model] : []);
    let faces = [];
    if (face) faces = await findFaces(src, keep);
    const fShare = face && faces.length ? 0.12 : 0;
    const { out, ep } = await runSR(src, a.model, tw, th, a, keep, [0, 1 - fShare]);
    if (face && faces.length) {
      const k = tw / src.w;
      const big = faces.map(f => ({ ...f, box: f.box.map(v => v * k), kps: f.kps.map(p => [p[0] * k, p[1] * k]) }));
      await faceRestore(out, big, face.model, face.s, [1 - fShare, 1], keep);
    } else if (face) post({ type: 'note', text: 'Fotoğrafta yüz bulunamadı.' });
    return { out, info: { faces: faces.length, ep } };
  }

  // Görsel İyileştirici: tek dokunuş
  async function jobAutoEnhance(a) {
    let src = img(a.img);
    const keep = ['det', 'gpen'].concat(a.detail ? ['fast'] : []);
    let out = src, ep = 'wasm';
    if (a.detail) {
      // 2× ve detay: Real-ESRGAN tam çözünürlükte (bütçe dahilinde)
      let tw = src.w * 2, th = src.h * 2;
      if (tw * th > a.maxOutPixels) { const k = Math.sqrt(a.maxOutPixels / (tw * th)); tw = Math.floor(tw * k); th = Math.floor(th * k); }
      const r = await runSR(src, 'fast', tw, th, { ...a, label: 'Detaylar netleştiriliyor' }, keep, [0, 0.8]);
      out = r.out; ep = r.ep;
    }
    stage('Gürültü temizleniyor…', a.detail ? 0.8 : 0.1);
    out = F.chromaDenoise(out, 1);
    const faces = a.face === false ? [] : await findFaces(src, keep);
    if (faces.length) {
      const k = out.w / src.w;
      const big = faces.map(f => ({ ...f, box: f.box.map(v => v * k), kps: f.kps.map(p => [p[0] * k, p[1] * k]) }));
      await faceRestore(out, big, 'gpen', a.faceS == null ? 0.4 : a.faceS, a.detail ? [0.82, 0.95] : [0.25, 0.9], keep);
    }
    stage('Işık ve renk dengeleniyor…', 0.95);
    const A = C.analyzeAuto(out); A.wb = A.wb.map(v => 1 + (v - 1) * 0.3);
    out = C.enhance(out, { auto: true, contrast: 0.06, saturation: 0.06 }, A);
    stage('Netlik ekleniyor…', 0.98);
    out = F.clarity(out, 0.3 * (a.amount ?? 1), 0.45 * (a.amount ?? 1));
    return { out, info: { faces: faces.length, ep } };
  }

  // Yüz bölgesinde kenar koruyan cilt yumuşatma (guided filter, oval maskeyle karışım)
  function smoothSkin(im, faces, amt) {
    const W = im.w, H = im.h, d = im.data;
    for (const f of faces) {
      const [bx0, by0, bx1, by1] = f.box, bw = bx1 - bx0, bh = by1 - by0;
      const x0 = Math.max(0, Math.floor(bx0 - bw * 0.1)), y0 = Math.max(0, Math.floor(by0 - bh * 0.15));
      const x1 = Math.min(W, Math.ceil(bx1 + bw * 0.1)), y1 = Math.min(H, Math.ceil(by1 + bh * 0.1));
      const w = x1 - x0, h = y1 - y0; if (w < 8 || h < 8) continue;
      const n = w * h, r = Math.max(2, Math.round(Math.min(w, h) * 0.025)), eps = 0.012 * (0.5 + amt);
      const box = (a) => { const t = new Float32Array(n), o = new Float32Array(n);
        for (let y = 0; y < h; y++) { let acc = 0; const row = y * w;
          for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
          for (let x = 0; x < w; x++) { t[row + x] = acc / (2 * r + 1); acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
        for (let x = 0; x < w; x++) { let acc = 0;
          for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
          for (let y = 0; y < h; y++) { o[y * w + x] = acc / (2 * r + 1); acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; } }
        return o; };
      const cx = (bx0 + bx1) / 2 - x0, cy = (by0 + by1) / 2 - y0, rx = bw * 0.55, ry = bh * 0.65;
      for (let c = 0; c < 3; c++) {
        const I = new Float32Array(n), II = new Float32Array(n);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = d[((y + y0) * W + x + x0) * 4 + c] / 255; I[y * w + x] = v; II[y * w + x] = v * v; }
        const mI = box(I), mII = box(II), A = new Float32Array(n), B = new Float32Array(n);
        for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], k = v / (v + eps); A[i] = k; B[i] = mI[i] - k * mI[i]; }
        const mA = box(A), mB = box(B);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x, dx = (x - cx) / rx, dy = (y - cy) / ry, e = dx * dx + dy * dy;
          const m = e >= 1 ? 0 : Math.min(1, (1 - e) * 2.5) * amt; if (!m) continue;
          const q = mA[i] * I[i] + mB[i], j = ((y + y0) * W + x + x0) * 4 + c;
          d[j] = Math.round((I[i] * (1 - m) + q * m) * 255);
        }
      }
    }
  }

  // Göz altı: kırışıklık (orta frekans) silinir, ince doku korunur, morluk yanak tonuna doğru aydınlatılır.
  function underEye(im, faces, amt = 1) {
    const W = im.w, H = im.h, d = im.data;
    const blur = (a, w, h, r) => { const t = new Float32Array(a.length), o = new Float32Array(a.length), q = 2 * r + 1;
      for (let y = 0; y < h; y++) { let acc = 0; const row = y * w;
        for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) { t[row + x] = acc / q; acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
      for (let x = 0; x < w; x++) { let acc = 0;
        for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) { o[y * w + x] = acc / q; acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; } }
      return o; };
    const gb = (a, w, h, r) => blur(blur(blur(a, w, h, r), w, h, r), w, h, r);
    for (const f of faces) {
      if (!f.kps || f.kps.length < 2) continue;
      const [L, R] = f.kps[0][0] < f.kps[1][0] ? [f.kps[0], f.kps[1]] : [f.kps[1], f.kps[0]];
      const ex = R[0] - L[0], ey = R[1] - L[1], D = Math.hypot(ex, ey); if (D < 12) continue;
      const ux = ex / D, uy = ey / D, nx = -uy, ny = ux; // nx,ny: yüzün aşağı yönü
      for (const E of [L, R]) {
        const cx = E[0] + nx * 0.30 * D, cy = E[1] + ny * 0.30 * D, rx = 0.46 * D, ry = 0.25 * D;
        const pad = Math.ceil(0.55 * D);
        const x0 = Math.max(0, Math.floor(cx - pad)), y0 = Math.max(0, Math.floor(cy - pad)), x1 = Math.min(W, Math.ceil(cx + pad)), y1 = Math.min(H, Math.ceil(cy + pad));
        const w = x1 - x0, h = y1 - y0; if (w < 8 || h < 8) continue;
        const n = w * h, M = new Float32Array(n);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const px = x + x0 - cx, py = y + y0 - cy, a = (px * ux + py * uy) / rx, b = (px * nx + py * ny) / ry, e = a * a + b * b;
          if (e >= 1) continue;
          const up = (px + x0 * 0 + cx - E[0]) * nx + (py + cy - E[1]) * ny; // gözden aşağı uzaklık
          const lid = Math.min(1, Math.max(0, (up - 0.10 * D) / (0.10 * D))); // kirpik/göz korunur
          const t = 1 - e; M[y * w + x] = Math.min(1, t * t * (3 - 2 * t) * 1.6) * lid * amt;
        }
        // yanak referansı (morluk için)
        const kx = Math.round(E[0] + nx * 0.62 * D), ky = Math.round(E[1] + ny * 0.62 * D), kr = Math.max(2, Math.round(0.08 * D));
        const rF = Math.max(1, Math.round(0.012 * D)), rM = Math.max(2, Math.round(0.07 * D));
        for (let c = 0; c < 3; c++) {
          const I = new Float32Array(n);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[y * w + x] = d[((y + y0) * W + x + x0) * 4 + c];
          const lo2 = gb(I, w, h, rF), lo = gb(I, w, h, rM);
          let cs = 0, cn = 0;
          for (let y = ky - kr; y <= ky + kr; y++) for (let x = kx - kr; x <= kx + kr; x++) if (x >= 0 && y >= 0 && x < W && y < H) { cs += d[(y * W + x) * 4 + c]; cn++; }
          const cheek = cn ? cs / cn : null;
          for (let i = 0; i < n; i++) { const m = M[i]; if (!m) continue;
            let v = I[i] - m * (lo2[i] - lo[i]) - m * 0.35 * (I[i] - lo2[i]);
            if (cheek != null && cheek > lo[i]) v += m * 0.7 * (cheek - lo[i]);
            const j = ((Math.floor(i / w) + y0) * W + (i % w) + x0) * 4 + c; d[j] = v < 0 ? 0 : v > 255 ? 255 : v; }
        }
      }
    }
  }

  // Yalnızca yüz iyileştirme (tüm fotoğrafı büyütmeden)
  async function jobFaces(a) {
    const src = img(a.img);
    const model = a.model || 'gpen';
    const keep = ['det', model];
    const faces = await findFaces(src, keep);
    if (!faces.length) throw new Error('Fotoğrafta yüz bulunamadı');
    const out = { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
    let m = model, st = a.s ?? 0.4;
    // iPhone/Android/CPU: CodeFormer (Android'de sekme çöküp sayfa baştan açılıyordu) (188 MB, fp16) çalışmıyor ve belleği taşırıyor → GPEN tam güç + cilt pürüzsüzleştirme
    if (m === 'codeformer' && (IOS_DEV || ANDROID_DEV || !gpuOK || gpuOff.has('codeformer'))) { m = 'gpen'; st = Math.max(st, 0.9); }
    try {
      await faceRestore(out, faces, m, st, [0.2, 0.9], ['det', m]);
    } catch (e) {
      if (m !== 'codeformer' || isCancelled()) throw e;
      // CodeFormer (fp16) bu cihazda açılamadı (ör. CPU'da Cast(double) çekirdeği yok) → GPEN tam güç
      post({ type: 'gpuFail', key: 'codeformer', text: String(e && e.message || e) });
      try { const s = sessions.get('codeformer'); if (s) { await s.sess?.release?.(); sessions.delete('codeformer'); } } catch {}
      gpuOff.add('codeformer');
      m = 'gpen'; st = Math.max(st, 0.9);
      out.data.set(src.data);
      await faceRestore(out, faces, m, st, [0.2, 0.9], ['det', m]);
    }
    if (model === 'codeformer') { stage('Cilt pürüzsüzleştiriliyor…', 0.92); smoothSkin(out, faces, 0.35 + 0.6 * (a.s ?? 0.4)); }
    if (a.eye) { stage('Göz altı kırışıklıkları gideriliyor…', 0.95); underEye(out, faces, 1); }
    return { out, info: { faces: faces.length, restored: true } };
  }

  async function jobDetect(a) {
    const src = img(a.img);
    const faces = await findFaces(src, ['det']);
    return { info: { faces } };
  }

  async function jobSegment(a) {
    const src = img(a.img);
    const s = await getSession('seg', ['seg']);
    stage(a.label || 'Arka plan kaldırılıyor…');
    const alpha = await F.segment(ort, s, src, t => stage(t));
    const cut = F.cutout(src, alpha);
    return { out: cut, info: { box: F.alphaBox(alpha, src.w, src.h) } };
  }

  async function jobEffect(a) {
    const src = img(a.img), alpha = new Uint8ClampedArray(a.alpha);
    stage('Efekt uygulanıyor…');
    return { out: F.applyEffect(a.id, src, alpha, a.amount ?? 0.6), info: {} };
  }

  async function jobColor(a) {
    const src = img(a.img);
    stage('Renkler ayarlanıyor…');
    return { out: C.enhance(src, a.params), info: {} };
  }

  async function prefetch(a) {
    for (const k of a.keys) { await fetchModel(k); post({ type: 'progress', p: 1 }); }
    return { info: await cachedStatus() };
  }

  async function clearCache() {
    for (const [, s] of sessions) { try { await s.sess.release(); } catch {} }
    sessions.clear();
    try { await caches.delete(CACHE); } catch {}
    return { info: await cachedStatus() };
  }

  return async function onMessage(msg) {
    const { id, cmd, args } = msg;
    if (cmd === 'cancel') { cancelled = true; return; }
    try {
      let r;
      if (cmd === 'init') r = { info: await init(args) };
      else if (cmd === 'status') r = { info: await cachedStatus() };
      else if (cmd === 'prefetch') r = await prefetch(args);
      else if (cmd === 'clear') r = await clearCache();
      else if (cmd === 'gpuReset') { gpuOff = new Set(); r = { info: {} }; }
      else {
        cancelled = false;
        const J = { upscale: jobUpscale, autoenhance: jobAutoEnhance, faces: jobFaces, detect: jobDetect, segment: jobSegment, effect: jobEffect, enhance: jobColor }[cmd];
        if (!J) throw new Error('bilinmeyen komut ' + cmd);
        r = await J(args);
      }
      if (r.out) post({ type: 'done', id, img: { w: r.out.w, h: r.out.h, buffer: r.out.data.buffer }, info: r.info }, [r.out.data.buffer]);
      else post({ type: 'done', id, info: r.info });
    } catch (e) {
      post({ type: 'error', id, text: String(e && e.message || e), cancelled: String(e && e.message) === 'İPTAL' });
    }
  };
}
