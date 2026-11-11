// Worker ya da ana thread üzerinde çalışan motor köprüsü
import { ORT_URL, ORT_BASE } from './config.js';

async function mainHasGpu() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}

export async function createEngine(initArgs = {}) {
  let seq = 0;
  const pending = new Map();
  let listener = () => {};
  let postIn = null, info = null, mode = 'worker';

  const onOut = (m) => {
    if (m.type === 'done' || m.type === 'error') {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.type === 'done') p.res(m); else { const er = new Error(m.text); er.cancelled = m.cancelled; p.rej(er); }
    } else listener(m);
  };

  const call = (cmd, args, transfer) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    postIn({ id, cmd, args }, transfer);
  });

  // 1) worker dene
  const gpuMain = await mainHasGpu();
  let worker = null;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const ready = await new Promise((res) => {
      const t = setTimeout(() => res(false), 20000);
      worker.onmessage = e => {
        if (e.data.type === 'ready') { clearTimeout(t); res(true); }
        else if (e.data.type === 'fatal') { clearTimeout(t); res(false); }
      };
      worker.onerror = () => { clearTimeout(t); res(false); };
    });
    if (ready) {
      worker.onmessage = e => onOut(e.data);
      postIn = (m, t) => worker.postMessage(m, t || []);
      info = (await call('init', initArgs)).info;
      if (!info.gpu && gpuMain) { worker.terminate(); worker = null; postIn = null; } // WebGPU worker'da yok: ana thread
    } else { worker.terminate(); worker = null; }
  } catch { worker = null; }

  // 2) ana thread
  if (!worker) {
    mode = 'main';
    const ort = await import(ORT_URL);
    ort.env.wasm.wasmPaths = ORT_BASE;
    const { makeHandler } = await import('./handler.js');
    const h = makeHandler(ort, (m) => setTimeout(() => onOut(m), 0));
    postIn = (m) => h(m);
    info = (await call('init', initArgs)).info;
  }

  return {
    info: { ...info, mode },
    on(fn) { listener = fn; },
    run: call,
    cancel() { postIn({ cmd: 'cancel' }); },
  };
}
