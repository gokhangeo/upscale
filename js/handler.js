// Model yönetimi + işler. Worker'da (ya da gerekirse ana thread'de) çalışır.
import * as C from './core.js';
import * as F from './fx.js';

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
const MEM_BUDGET_MB = 300;
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

  // Yalnızca yüz iyileştirme (tüm fotoğrafı büyütmeden)
  async function jobFaces(a) {
    const src = img(a.img);
    const model = a.model || 'gpen';
    const keep = ['det', model];
    const faces = await findFaces(src, keep);
    if (!faces.length) throw new Error('Fotoğrafta yüz bulunamadı');
    const out = { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
    await faceRestore(out, faces, model, a.s ?? 0.4, [0.2, 1], keep);
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
