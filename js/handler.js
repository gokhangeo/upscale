// Model yönetimi + işler. Worker'da ya da (WebGPU worker'da yoksa) ana thread'de çalışır.
import * as C from './core.js';

const HF = 'https://huggingface.co/OwlMaster/AllFilesRope/resolve/d783e61585b3d83a85c91ca8a3b299e8ade94d72/';
export const MODELS = {
  fast: { url: HF + 'realesr-general-x4v3.onnx', mb: 4.9, name: 'Hızlı büyütme (Real-ESRGAN general v3)', gpu: true },
  best: { url: HF + 'RealESRGAN_x4plus.fp16.onnx', mb: 33.6, name: 'En iyi büyütme (Real-ESRGAN x4plus)', gpu: true },
  det: { url: HF + 'scrfd_2.5g_bnkps.onnx', mb: 3.3, name: 'Yüz algılama (SCRFD)', gpu: false },
  gpen: { url: HF + 'GPEN-BFR-256.onnx', mb: 75.7, name: 'Yüz iyileştirme – Doğal (GPEN)', gpu: true },
  codeformer: { url: HF + 'codeformer_fp16.onnx', mb: 188.6, name: 'Yüz iyileştirme – Güçlü (CodeFormer)', gpu: true },
  modnet: { url: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_fp16.onnx', mb: 13.0, name: 'Arka plan (MODNet)', gpu: true },
};
const CACHE = 'bulut-models-v1';
const MEM_BUDGET_MB = 260;

export function makeHandler(ort, post) {
  let gpuOK = false, cancelled = false;
  const sessions = new Map(); // key -> {sess, ep, used}

  async function init() {
    ort.env.logLevel = 'error';
    const coi = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    ort.env.wasm.numThreads = coi ? Math.min(4, (navigator.hardwareConcurrency || 2)) : 1;
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        const ad = await navigator.gpu.requestAdapter();
        gpuOK = !!ad;
      }
    } catch { gpuOK = false; }
    return { ok: true, gpu: gpuOK, threads: ort.env.wasm.numThreads };
  }

  async function cachedStatus() {
    const res = {};
    let cache = null;
    try { cache = await caches.open(CACHE); } catch {}
    for (const k of Object.keys(MODELS)) res[k] = cache ? !!(await cache.match(MODELS[k].url)) : false;
    return res;
  }

  async function fetchModel(key, label) {
    const m = MODELS[key];
    let cache = null;
    try { cache = await caches.open(CACHE); } catch {}
    if (cache) {
      const hit = await cache.match(m.url);
      if (hit) return await hit.arrayBuffer();
    }
    post({ type: 'stage', text: (label || m.name) + ' indiriliyor…', p: 0 });
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
    if (cache) {
      try { await cache.put(m.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { /* depolama dolu olabilir */ }
    }
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

  async function createSession(key, ep) {
    const buf = await fetchModel(key);
    post({ type: 'stage', text: 'Model hazırlanıyor…', p: null });
    const opts = ep === 'webgpu'
      ? { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 }
      : { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    return await ort.InferenceSession.create(new Uint8Array(buf), opts);
  }

  // WebGPU hatasında otomatik WASM'a düşen oturum sarmalayıcı
  async function getSession(key, keep) {
    if (sessions.has(key)) { const s = sessions.get(key); s.used = Date.now(); return s.proxy; }
    await freeMemory(MODELS[key].mb, keep || []);
    const entry = { ep: 'wasm', used: Date.now(), checked: false };
    if (gpuOK && MODELS[key].gpu) {
      try { entry.sess = await createSession(key, 'webgpu'); entry.ep = 'webgpu'; }
      catch (e) { post({ type: 'note', text: 'WebGPU bu model için açılamadı, CPU kullanılıyor.' }); }
    }
    if (!entry.sess) entry.sess = await createSession(key, 'wasm');
    const toWasm = async (why) => {
      post({ type: 'note', text: 'GPU sorunu (' + why + '), CPU moduna geçildi – daha yavaş.' });
      try { await entry.sess.release(); } catch {}
      entry.sess = await createSession(key, 'wasm'); entry.ep = 'wasm';
    };
    entry.proxy = {
      get inputNames() { return entry.sess.inputNames; },
      get outputNames() { return entry.sess.outputNames; },
      get ep() { return entry.ep; },
      async run(feeds) {
        if (entry.ep === 'webgpu') {
          try {
            const r = await entry.sess.run(feeds);
            if (!entry.checked) {
              entry.checked = true;
              const d = r[entry.sess.outputNames[0]].data;
              let bad = false;
              for (let i = 0; i < d.length; i += 97) if (!Number.isFinite(d[i])) { bad = true; break; }
              if (bad) { await toWasm('geçersiz çıktı'); return await entry.sess.run(feeds); }
            }
            return r;
          } catch (e) {
            await toWasm(String(e.message || e).slice(0, 60));
            return await entry.sess.run(feeds);
          }
        }
        return await entry.sess.run(feeds);
      },
    };
    sessions.set(key, entry);
    return entry.proxy;
  }

  const isCancelled = () => cancelled;
  const img = a => ({ w: a.w, h: a.h, data: new Uint8ClampedArray(a.buffer) });

  async function jobUpscale(a) {
    let src = img(a.img);
    const scale = a.scale === 2 ? 2 : 4;
    const maxIn = a.maxOutPixels / (scale * scale);
    if (src.w * src.h > maxIn) {
      const k = Math.sqrt(maxIn / (src.w * src.h));
      src = C.resize(src, Math.floor(src.w * k), Math.floor(src.h * k));
      post({ type: 'note', text: 'Fotoğraf ' + src.w + '×' + src.h + ' boyutuna küçültülerek işlendi (bellek sınırı).' });
    }
    const face = a.face; // null | {model, s}
    const keep = [a.model, 'det'].concat(face ? [face.model] : []);
    // yüzleri önce küçük görüntüde bul
    let faces = [];
    if (face) {
      const det = await getSession('det', keep);
      post({ type: 'stage', text: 'Yüzler aranıyor…', p: null });
      faces = await C.detectFaces(ort, det, src, 0.5);
      faces = faces.filter(f => (f.box[2] - f.box[0]) > 14);
    }
    const sess = await getSession(a.model, keep);
    const gpu = sess.ep === 'webgpu';
    const tile = gpu ? (a.model === 'best' ? 192 : 256) : 128;
    const faceShare = face && faces.length ? 0.25 : 0;
    post({ type: 'stage', text: 'Büyütülüyor (' + (gpu ? 'GPU' : 'CPU') + ')…', p: 0 });
    let out = await C.upscale(ort, sess, src, {
      scale, tile, pad: 12,
      onProgress: p => post({ type: 'progress', p: p * (1 - faceShare) }),
      cancelled: isCancelled,
    });
    if (face && faces.length) {
      const fs = await getSession(face.model, keep);
      post({ type: 'stage', text: 'Yüz iyileştiriliyor (' + faces.length + ')…', p: 1 - faceShare });
      const sc = scale;
      const big = faces.map(f => ({ ...f, box: f.box.map(v => v * sc), kps: f.kps.map(p => [p[0] * sc, p[1] * sc]) }));
      const s = face.s; // 0 doğal .. 1 pürüzsüz
      await C.restoreFaces(ort, fs, out, big, {
        kind: face.model === 'codeformer' ? 'codeformer' : 'gpen',
        size: face.model === 'codeformer' ? 512 : 256,
        fidelity: 1 - 0.7 * s,
        strength: face.model === 'codeformer' ? 1 : 0.55 + 0.45 * s,
        adaptive: true,
        maxFaces: 8,
        onProgress: p => post({ type: 'progress', p: 1 - faceShare + faceShare * p }),
        cancelled: isCancelled,
      });
    } else if (face) {
      post({ type: 'note', text: 'Fotoğrafta yüz bulunamadı.' });
    }
    return { out, info: { faces: faces.length, ep: sess.ep } };
  }

  async function jobBackground(a) {
    const src = img(a.img);
    const s = await getSession('modnet', ['modnet']);
    post({ type: 'stage', text: 'Kişi ayrıştırılıyor…', p: null });
    const m = await C.matte(ort, s, src);
    post({ type: 'stage', text: a.mode === 'remove' ? 'Arka plan siliniyor…' : 'Arka plan bulanıklaştırılıyor…', p: null });
    const out = a.mode === 'remove' ? C.applyAlpha(src, m) : C.blurBackground(src, m, a.amount);
    return { out, info: {} };
  }

  async function jobEnhance(a) {
    const src = img(a.img);
    post({ type: 'stage', text: 'Renkler ayarlanıyor…', p: null });
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
      if (cmd === 'init') r = { info: await init() };
      else if (cmd === 'status') r = { info: await cachedStatus() };
      else if (cmd === 'prefetch') r = await prefetch(args);
      else if (cmd === 'clear') r = await clearCache();
      else {
        cancelled = false;
        if (cmd === 'upscale') r = await jobUpscale(args);
        else if (cmd === 'background') r = await jobBackground(args);
        else if (cmd === 'enhance') r = await jobEnhance(args);
        else throw new Error('bilinmeyen komut ' + cmd);
      }
      if (r.out) post({ type: 'done', id, img: { w: r.out.w, h: r.out.h, buffer: r.out.data.buffer }, info: r.info }, [r.out.data.buffer]);
      else post({ type: 'done', id, info: r.info });
    } catch (e) {
      post({ type: 'error', id, text: String(e && e.message || e), cancelled: String(e && e.message) === 'İPTAL' });
    }
  };
}
