// Model çalıştırma worker'ı (arayüz akıcı kalsın diye)
import { ORT_URL, ORT_BASE } from './config.js';
import { makeHandler } from './handler.js';
let handler = null;
const queue = [];
const post = (m, t) => self.postMessage(m, t || []);
self.onmessage = e => { if (handler) handler(e.data); else queue.push(e.data); };
(async () => {
  try {
    const ort = await import(ORT_URL);
    ort.env.wasm.wasmPaths = ORT_BASE;
    handler = makeHandler(ort, post);
    post({ type: 'ready' });
    while (queue.length) handler(queue.shift());
  } catch (e) {
    post({ type: 'fatal', text: String(e && e.message || e) });
  }
})();
