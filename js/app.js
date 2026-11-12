import { createEngine } from './engine.js';
import { MODELS } from './handler.js';
import * as C from './core.js';
import * as F from './fx.js';
import * as DB from './db.js';
import { Composer, SIZES, ratioLabel } from './composer.js';
import * as AI from './ai.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
// iPhone/iPad (özellikle ana ekran uygulaması) bellek aşınca sayfayı baştan yükler → sınırları düşük tut.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_OUT = IOS ? 8e6 : 16e6;
const MAX_LOAD = IOS ? 3.2e6 : 16e6;
const GPU_TILE = IOS ? 0.25e6 : 4.2e6;
const CPU_TILE_MAX = IOS ? 0.25e6 : Infinity;
const DISP = 1400;             // önizleme uzun kenarı

// ---------------- ayarlar ----------------
const S = Object.assign({
  enhSize: 'same', enhFace: true, enhAmt: 70, model: 'fast', scale: '2', faceOn: false, faceModel: 'gpen',
  bMode: 'enhance', bScale: '2', theme: 'koyu', cpuBudget: '0.6', pfShape: 'circle', rzFit: 'fit', rzBg: 'blur',
  rzSize: 'igpost', recent: [], aiQual: '1K', aiRatio: 'orig', v: 3, colT: 'grid', colBg: '#f3efe7',
}, JSON.parse(localStorage.getItem('netlik-ayar') || '{}'));
const saveS = () => localStorage.setItem('netlik-ayar', JSON.stringify(S));
const rates = JSON.parse(localStorage.getItem('netlik-hiz') || '{}'); // piksel/sn (SR)
const saveRates = () => localStorage.setItem('netlik-hiz', JSON.stringify(rates));
const gpuOffList = () => JSON.parse(localStorage.getItem('netlik-gpu-off') || '[]');

// ---------------- mikro etkileşimler ----------------
function haptic() { try { if (navigator.vibrate) { navigator.vibrate(8); return; } $('#hapticLbl').click(); } catch {} }
let toastT;
function toast(t, ms = 2800) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms); }
function applyTheme() { const d = S.theme === 'koyu' || (S.theme === 'sistem' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = d ? 'dark' : 'light'; localStorage.setItem('netlik-tema', S.theme); }
function setupSeg(seg, value, onChange) {
  const btns = [...seg.querySelectorAll('button')], pill = seg.querySelector('.seg-pill');
  const place = (anim) => {
    const b = btns.find(x => x.classList.contains('on')) || btns[0];
    if (!b.offsetWidth) return;
    if (!anim) pill.style.transition = 'none';
    pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!anim) { pill.offsetWidth; pill.style.transition = ''; }
  };
  const set = (v, anim) => { btns.forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); place(anim); };
  btns.forEach(b => b.addEventListener('click', () => { haptic(); set(b.dataset.v, true); onChange && onChange(b.dataset.v); }));
  set(value, false);
  new ResizeObserver(() => place(false)).observe(seg);
  return { set };
}
function rangeFill(r) { r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%'); }
const fmtSec = s => s < 60 ? Math.max(1, Math.ceil(s)) + ' sn' : Math.floor(s / 60) + ' dk ' + (Math.ceil(s % 60)) + ' sn';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));

// ---------------- sekmeler ----------------
const TABS = ['home', 'ai', 'batch', 'history'];
let curTab = 'home';
function placeTabPill() { const b = $(`.tabbar button[data-tab="${curTab}"]`), p = $('#tabPill'); if (!b.offsetWidth) return; p.style.width = b.offsetWidth + 'px'; p.style.transform = `translateX(${b.offsetLeft}px)`; }
function go(tab) {
  if (tab === curTab) return;
  const from = TABS.indexOf(curTab), to = TABS.indexOf(tab);
  const old = $('#v-' + curTab), nu = $('#v-' + tab);
  nu.classList.remove('left'); nu.style.transition = 'none';
  nu.style.transform = `translateX(${to > from ? 24 : -24}px) scale(.985)`;
  nu.offsetWidth; nu.style.transition = ''; nu.style.transform = '';
  old.classList.remove('active'); old.classList.toggle('left', to > from);
  nu.classList.add('active');
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  curTab = tab; placeTabPill();
  $('#fab').classList.toggle('hide', tab === 'batch' || tab === 'history');
  window.scrollTo({ top: 0 });
  if (tab === 'history') renderHistory();
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => { haptic(); go(b.dataset.tab); }));
addEventListener('resize', () => { placeTabPill(); layoutStage(); });

// ---------------- ekranlar ----------------
const screens = [];
function openScreen(id) { const el = $('#' + id); el.classList.add('on'); el.setAttribute('aria-hidden', 'false'); if (!screens.includes(id)) screens.push(id); document.body.classList.add('locked'); }
function closeScreen(id) { const el = $('#' + id); el.classList.remove('on'); el.setAttribute('aria-hidden', 'true'); const i = screens.indexOf(id); if (i >= 0) screens.splice(i, 1); if (!screens.length) document.body.classList.remove('locked'); }

// ---------------- motor ----------------
let engine = null, engineP = null, lastEp = '–';
function ensureEngine() {
  if (!engineP) engineP = createEngine({ gpuOff: gpuOffList() }).then(e => {
    engine = e;
    const chip = $('#engineChip');
    chip.classList.add(e.info.gpu ? 'gpu' : 'cpu');
    $('#engineTxt').textContent = e.info.gpu ? 'GPU' : 'CPU' + (e.info.threads > 1 ? ' ×' + e.info.threads : '');
    $('#sEngine').textContent = e.info.gpu ? 'WebGPU + WASM' : 'WASM / CPU';
    $('#sThreads').textContent = e.info.threads + (e.info.coi ? '' : ' (çok çekirdek kapalı)');
    $('#sEngineHint').textContent = e.info.gpu
      ? 'Ekran kartı (WebGPU) destekleniyor. Bir model GPU\'da hata verirse otomatik CPU\'ya geçilir ve hatırlanır.'
      : 'Bu tarayıcıda WebGPU yok; işlemler CPU ile yapılır. iOS 26+ Safari ve güncel Chrome WebGPU destekler.';
    e.on(onEngineMsg);
    renderGpuDiag(); updateHints();
    return e;
  }).catch(err => { $('#engineTxt').textContent = 'Hata'; engineP = null; toast('Yapay zekâ motoru yüklenemedi: ' + err.message, 5000); throw err; });
  return engineP;
}
$('#engineChip').addEventListener('click', () => { haptic(); openSettings(); });
function renderGpuDiag() {
  const off = gpuOffList(), err = localStorage.getItem('netlik-gpu-err');
  $('#sGpuErr').hidden = !err; $('#sGpuErr').textContent = err ? 'Son GPU hatası: ' + err : '';
  $('#gpuRetry').hidden = !off.length;
  $('#sLastEp').textContent = lastEp + (off.length ? ' · GPU kapalı: ' + off.join(', ') : '');
}
$('#gpuRetry').addEventListener('click', async () => {
  localStorage.removeItem('netlik-gpu-off'); localStorage.removeItem('netlik-gpu-err');
  try { await (await ensureEngine()).run('gpuReset'); } catch {}
  renderGpuDiag(); toast('GPU yeniden denenecek');
});

// ---------------- işleniyor ekranı ----------------
const prog = { on: false, t0: 0, p0: 0, lastP: 0, batchItem: null, job: null, fake: 0 };
function showProc(title, img, on = true) {
  const el = $('#proc');
  if (!on) { el.classList.remove('on'); prog.on = false; clearInterval(prog.fake); return; }
  $('#procTitle').textContent = title;
  $('#procStage').textContent = 'Hazırlanıyor…'; $('#procPct').textContent = '0%'; $('#procEta').textContent = 'Bu biraz sürebilir…'; $('#procBar').style.width = '0%';
  const c = $('#procCanvas');
  if (img) {
    const src = img instanceof HTMLCanvasElement || img instanceof HTMLImageElement ? img : imgCanvas(img);
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, k = Math.min(1, 900 / Math.max(w, h));
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  }
  el.classList.add('on'); prog.on = true; prog.t0 = performance.now(); prog.p0 = 0;
}
function procProgress(p, sub) {
  if (p == null) return;
  $('#procPct').textContent = Math.round(p * 100) + '%'; $('#procBar').style.width = (p * 100) + '%';
  if (sub) { $('#procEta').textContent = sub; return; }
  const el = (performance.now() - prog.t0) / 1000, dp = p - prog.p0;
  if (dp > 0.03 && el > 2) $('#procEta').textContent = 'Kalan ~' + fmtSec(el * (1 - p) / dp);
}
function onEngineMsg(m) {
  if (m.type === 'note') { toast(m.text, 4500); return; }
  if (m.type === 'gpuFail') {
    const off = new Set(gpuOffList()); off.add(m.key); localStorage.setItem('netlik-gpu-off', JSON.stringify([...off]));
    localStorage.setItem('netlik-gpu-err', (m.key + ': ' + m.text).slice(0, 400)); renderGpuDiag(); return;
  }
  if (m.type === 'ep') { lastEp = m.ep === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'; renderGpuDiag(); return; }
  if (m.type === 'plan') { if (prog.job) { prog.job.plan = m.plan; DB.jobPut(prog.job).catch(() => {}); } return; }
  if (m.type === 'tile') { if (prog.job) { prog.job.tiles.set(m.i, m.buffer); DB.tilePut(prog.job.id, m.i, m.buffer).catch(() => {}); } return; }
  if (m.type === 'stage') {
    prog.t0 = performance.now(); prog.p0 = m.p || 0;
    if (prog.batchItem) prog.batchItem.qs.textContent = m.text;
    if (!prog.on) return;
    $('#procStage').textContent = m.text;
    $('#procEta').textContent = m.kind === 'download' ? 'İlk kullanım: model indiriliyor' : m.kind === 'prepare' ? 'Bir kez hazırlanır' : 'Bu biraz sürebilir…';
    if (m.p != null) procProgress(m.p); else { $('#procPct').textContent = '…'; $('#procBar').style.width = '0%'; }
  }
  if (m.type === 'progress') {
    if (m.skipped) prog.p0 = m.p; // devam ettirilen karolar hız hesabına girmesin
    if (prog.batchItem) prog.batchItem.bar.style.width = (m.p * 100) + '%';
    if (prog.on) procProgress(m.p, m.sub);
  }
}
$('#procStop').addEventListener('click', stopJob);
$('#procX').addEventListener('click', stopJob);
let aiAbort = null;
function stopJob() { haptic(); if (aiAbort) aiAbort.abort(); engine && engine.cancel(); $('#procStage').textContent = 'Durduruluyor…'; }

// ekran açık kalsın + arka plan uyarısı
let wakeLock = null, busy = false, wasHidden = false;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (busy) wasHidden = true; return; }
  if (busy) { keepAwake(true); if (wasHidden) toast('İşlem kaldığı yerden devam ediyor. Ekranı açık tut.', 4000); }
  wasHidden = false;
});

// ---------------- görüntü yardımcıları ----------------
async function decodeFile(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Fotoğraf açılamadı')); i.src = URL.createObjectURL(file); }); }
  let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, note = '';
  if (w * h > MAX_LOAD) { const k = Math.sqrt(MAX_LOAD / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); note = 'Çok büyük fotoğraf ' + w + '×' + h + ' boyutuna küçültüldü.'; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h);
  src.close && src.close(); c.width = c.height = 0;
  return { img: { w, h, data: d.data }, note };
}
function imgCanvas(img) { const c = document.createElement('canvas'); c.width = img.w; c.height = img.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.w * img.h * 4), img.w, img.h), 0, 0); return c; }
function canvasImg(c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: d.data }; }
function hasAlpha(img) { const d = img.data; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true; return false; }
async function canvasBlob(c, png, q = 0.93) { return await new Promise(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', q)); }
async function thumbOf(c, png) {
  const t = document.createElement('canvas'), k = Math.min(1, 320 / Math.max(c.width, c.height));
  t.width = Math.round(c.width * k); t.height = Math.round(c.height * k);
  const tx = t.getContext('2d'); tx.imageSmoothingQuality = 'high';
  if (png) { for (let y = 0; y < t.height; y += 10) for (let x = 0; x < t.width; x += 10) { tx.fillStyle = ((x + y) / 10) % 2 ? '#d9d9d9' : '#fff'; tx.fillRect(x, y, 10, 10); } }
  tx.drawImage(c, 0, 0, t.width, t.height);
  return await canvasBlob(t, false, 0.8);
}
async function encode(img) { const c = imgCanvas(img), png = hasAlpha(img); const blob = await canvasBlob(c, png); const thumb = await thumbOf(c, png); c.width = c.height = 0; return { blob, thumb }; }
function drawDisplay(canvas, img, maxSide = DISP) {
  const src = img instanceof HTMLCanvasElement ? img : imgCanvas(img);
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  canvas.width = Math.round(src.width * k); canvas.height = Math.round(src.height * k);
  const x = canvas.getContext('2d'); x.clearRect(0, 0, canvas.width, canvas.height); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (!(img instanceof HTMLCanvasElement)) src.width = src.height = 0;
}
const fname = (blob, tag) => 'netlik-' + tag + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + (blob.type === 'image/png' ? '.png' : '.jpg');
async function shareBlobs(items) {
  const files = items.map(i => new File([i.blob], i.name, { type: i.blob.type }));
  try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return true; } }
  catch (e) { if (e.name === 'AbortError') return true; if (e.name === 'NotAllowedError') return false; }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000); }
  toast('İndirildi'); return true;
}
const smallImg = (img, m = DISP) => { const k = Math.min(1, m / Math.max(img.w, img.h)); return k < 1 ? C.resize(img, img.w * k, img.h * k) : img; };
const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Görsel yüklenemedi')); i.src = src; });

// ---------------- foto seçici ----------------
let pickCb = null;
function openPicker(cb, allowLast = true) {
  pickCb = cb;
  const last = allowLast && st.base;
  $('#pickLast').hidden = !last;
  if (last) { const c = document.createElement('canvas'); drawDisplay(c, st.base, 120); $('#pickLastImg').src = c.toDataURL('image/jpeg', 0.7); }
  $('#pickScrim').classList.add('on'); $('#pickSheet').classList.add('on');
}
function closePicker() { $('#pickScrim').classList.remove('on'); $('#pickSheet').classList.remove('on'); }
$('#pickScrim').addEventListener('click', () => { closePicker(); pickCb = null; });
$$('#pickSheet [data-src]').forEach(b => b.addEventListener('click', async () => {
  haptic(); const s = b.dataset.src;
  if (s === 'gallery') $('#fileIn').click();
  else if (s === 'camera') $('#camIn').click();
  else if (s === 'files') $('#docIn').click();
  else if (s === 'last') { closePicker(); const cb = pickCb; pickCb = null; cb && cb(st.base, null, true); }
  else if (s === 'paste') {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) { const t = it.types.find(x => x.startsWith('image/')); if (t) { const blob = await it.getType(t); return gotFile(blob); } }
      toast('Panoda görsel yok');
    } catch { toast('Pano okunamadı (izin gerekli)'); }
  }
}));
async function gotFile(f) {
  closePicker(); const cb = pickCb; pickCb = null;
  try { const { img, note } = await decodeFile(f); cb && cb(img, note, false); } catch (err) { toast(err.message); }
}
['#fileIn', '#camIn', '#docIn'].forEach(id => $(id).addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) gotFile(f); }));
document.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f && pickCb) gotFile(f); });

// ---------------- durum ----------------
const st = { base: null, baseId: 0, tool: null, result: null, cut: null, cutCanvas: null, cutFor: -1, cutBox: null, faces: null, facesFor: -1, mode: 'compare', comp: null, faceRaw: null, fx: null, undo: [] };
function setBase(img) {
  st.base = img; st.baseId++; st.result = null; st.faceRaw = null; st.undo = [];
  ensureEngine().catch(() => {});
}

// ---------------- araçlar ----------------
const TOOLS = {
  enhance: { t: 'Görsel İyileştirici', run: 'İyileştir', p: 'enhance' },
  upscale: { t: 'YZ büyütme', run: 'Büyüt', p: 'upscale' },
  faces: { t: 'Yüz iyileştir', run: 'Yüzleri iyileştir', p: 'faces' },
  editor: { t: 'Arka planı kaldır', run: 'Kaydet', p: 'editor', comp: true },
  bgscene: { t: 'Arka plan değiştir', run: 'Kaydet', p: 'editor', comp: true },
  profile: { t: 'Profil resmi', run: 'Kaydet (1080×1080)', p: 'profile', comp: true },
  resize: { t: 'Tekrar boyutlandır', run: 'Kaydet', p: 'resize', comp: true },
  effects: { t: 'Klasik efektler', run: 'Kaydet', p: 'effects' },
  color: { t: 'Renk', run: 'Uygula', p: 'color' },
  collage: { t: 'Kolaj', run: 'Kaydet', p: 'collage' },
};
function startTool(tool, opt = {}) {
  haptic();
  if (tool === 'ai') return openAI();
  if (tool === 'collage') return pickCollage();
  openPicker((img, note, same) => { if (!same) setBase(img); if (note) toast(note, 4000); openTool(tool, opt); });
}
$$('[data-tool]').forEach(b => b.addEventListener('click', () => startTool(b.dataset.tool)));
$('#fab').addEventListener('click', () => startTool('editor'));
$('#setBtn').addEventListener('click', () => { haptic(); openSettings(); });

async function openTool(tool, opt = {}) {
  const T = TOOLS[tool]; st.tool = tool; st.result = null; st.mode = T.comp ? 'comp' : 'compare';
  $('#toolTitle').textContent = T.t; $('#runTxt').textContent = T.run;
  $$('.panel').forEach(p => p.classList.toggle('on', p.dataset.p === T.p));
  $('#resultBar').hidden = true; $('#runBtn').hidden = false;
  $('#undoBtn').hidden = !T.comp; $('#cwrap').classList.remove('circle', 'peek');
  $('#eyeBtn').classList.remove('on');
  openScreen('toolScreen');
  await raf();
  $$('#toolPanel .seg').forEach(s => s._ctl && s._ctl.set(S[s.dataset.opt], false));
  showSingle(st.base); setDims(st.base.w + '×' + st.base.h);
  updateHints();
  try {
    if (tool === 'editor' || tool === 'bgscene') await initEditor(tool);
    else if (tool === 'profile') await initProfile();
    else if (tool === 'resize') initResize(opt);
    else if (tool === 'effects') initEffects(opt.fx);
    else if (tool === 'color') colorPreview();
  } catch (err) { if (!err.cancelled) toast('Hata: ' + err.message, 5000); if (err.cancelled || (T.comp && !st.comp)) closeTool(); }
}
function closeTool() { closeScreen('toolScreen'); st.tool = null; st.comp = null; }
$('#toolBack').addEventListener('click', () => { haptic(); closeTool(); });

// ---------------- sahne (karşılaştırma / tuval) ----------------
function setDims(t) { $('#dims').textContent = t || ''; }
function layoutStage() {
  const stage = $('#stage'), wrap = $('#cwrap'), c = $('#cAfter');
  if (!c.width || !stage.clientWidth) return;
  const W = stage.clientWidth - 20, H = stage.clientHeight - 20, k = Math.min(W / c.width, H / c.height);
  wrap.style.width = Math.round(c.width * k) + 'px'; wrap.style.height = Math.round(c.height * k) + 'px';
  resetZoom();
}
function showSingle(img) {
  drawDisplay($('#cAfter'), img); $('#cBefore').width = 1; $('#cwrap').classList.add('single');
  $('#cwrap').classList.toggle('checker', !(img instanceof HTMLCanvasElement) && hasAlpha(img));
  layoutStage();
}
function showCompare(before, after, animate) {
  drawDisplay($('#cBefore'), before); drawDisplay($('#cAfter'), after);
  $('#cwrap').classList.remove('single'); $('#cwrap').classList.toggle('checker', !(after instanceof HTMLCanvasElement) && hasAlpha(after));
  layoutStage();
  if (animate) {
    let t0 = null;
    const step = t => { t0 = t0 || t; const p = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - p, 3); setSplit(100 - 50 * e); if (p < 1) requestAnimationFrame(step); };
    setSplit(100); requestAnimationFrame(step);
    $('#stage').classList.remove('reveal'); $('#stage').offsetWidth; $('#stage').classList.add('reveal');
  } else setSplit(50);
}
function setSplit(pct) { $('#cAfter').style.clipPath = `inset(0 0 0 ${pct}%)`; $('#divider').style.left = pct + '%'; }
const Z = { s: 1, x: 0, y: 0 };
function applyZoom() { $('#zoomer').style.transform = `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`; }
function resetZoom() { Z.s = 1; Z.x = 0; Z.y = 0; applyZoom(); }
function clampPan() { const w = $('#cwrap').clientWidth, h = $('#cwrap').clientHeight; Z.x = Math.min(0, Math.max(w - w * Z.s, Z.x)); Z.y = Math.min(0, Math.max(h - h * Z.s, Z.y)); }
function zoomAt(px, py) { if (Z.s > 1) { resetZoom(); return; } Z.s = 3; Z.x = px - px * Z.s; Z.y = py - py * Z.s; clampPan(); applyZoom(); }
(() => {
  const wrap = $('#cwrap'); let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, lastTap = 0;
  const pts = new Map(); let pinch0 = null;
  wrap.addEventListener('pointerdown', e => {
    const r = wrap.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    wrap.setPointerCapture(e.pointerId);
    if (st.mode === 'comp' && st.comp) { // tuval: metin ya da özne taşı / sıkıştır
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cp = st.comp, kx = cp.W / r.width;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), s: cp.t.s }; mode = 'pinch'; return; }
      const ti = cp.hitText(px * kx, py * kx);
      pushUndo();
      if (ti >= 0) { cp.sel = ti; mode = 'text'; $('#txtIn').value = cp.texts[ti].t; }
      else { cp.sel = -1; mode = 'move'; }
      sx = e.clientX; sy = e.clientY; ox = ti >= 0 ? cp.texts[ti].x : cp.t.x; oy = ti >= 0 ? cp.texts[ti].y : cp.t.y;
      renderComp(); return;
    }
    const now = Date.now();
    if (now - lastTap < 300) { haptic(); zoomAt(px, py); lastTap = 0; return; }
    lastTap = now;
    const divX = parseFloat($('#divider').style.left || '50') / 100 * r.width;
    if (!wrap.classList.contains('single') && (Z.s === 1 || Math.abs(px - divX) < 30)) { mode = 'slide'; wrap.classList.add('sliding'); setSplit(Math.max(0, Math.min(100, px / r.width * 100))); }
    else if (Z.s > 1) { mode = 'pan'; sx = e.clientX; sy = e.clientY; ox = Z.x; oy = Z.y; $('#zoomer').classList.add('dragging'); }
  });
  wrap.addEventListener('pointermove', e => {
    if (!mode) return;
    const r = wrap.getBoundingClientRect();
    if (st.mode === 'comp' && st.comp) {
      const cp = st.comp; if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size === 2) { const [a, b] = [...pts.values()]; cp.t.s = Math.max(0.05, pinch0.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d); }
      else if (mode === 'text') { const t = cp.texts[cp.sel]; t.x = Math.max(0, Math.min(1, ox + (e.clientX - sx) / r.width)); t.y = Math.max(0, Math.min(1, oy + (e.clientY - sy) / r.height)); }
      else if (mode === 'move') { const k = cp.W / r.width; cp.t.x = ox + (e.clientX - sx) * k; cp.t.y = oy + (e.clientY - sy) * k; }
      renderCompSoon(); return;
    }
    if (mode === 'slide') setSplit(Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)));
    else { Z.x = ox + e.clientX - sx; Z.y = oy + e.clientY - sy; clampPan(); applyZoom(); }
  });
  const end = e => { pts.delete(e.pointerId); if (pts.size < 2 && mode === 'pinch') mode = null; if (!pts.size) mode = null; if (st.mode !== 'comp') mode = null; wrap.classList.remove('sliding'); $('#zoomer').classList.remove('dragging'); };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
})();
// göz: orijinali göster (basılı tut / dokun)
$('#eyeBtn').addEventListener('click', () => {
  haptic(); const on = !$('#eyeBtn').classList.contains('on'); $('#eyeBtn').classList.toggle('on', on);
  if (st.mode === 'comp' && st.comp) { st.comp.showOriginal = on; renderComp(); }
  else if (st.result || st.tool === 'color' || st.tool === 'effects' || st.tool === 'faces') setSplit(on ? 100 : 50);
});

// ---------------- iş çalıştırma ----------------
let lastInfo = {};
const pack = img => ({ w: img.w, h: img.h, buffer: img.data.slice().buffer });
async function runJob(cmd, args, transfer) {
  const e = await ensureEngine();
  const r = await e.run(cmd, args, transfer || (args.img ? [args.img.buffer] : []));
  lastInfo = r.info || {};
  return r.img ? { w: r.img.w, h: r.img.h, data: new Uint8ClampedArray(r.img.buffer) } : null;
}
async function withProc(title, img, fn) {
  busy = true; keepAwake(true); showProc(title, img);
  const t0 = performance.now();
  try { return await fn(); }
  finally { busy = false; keepAwake(false); showProc(null, null, false); lastInfo.ms = performance.now() - t0; }
}
function srArgs(base, extra) {
  return { maxOutPixels: MAX_OUT, cpuBudget: Math.min(CPU_TILE_MAX, +S.cpuBudget * 1e6), gpuBudget: GPU_TILE, ...extra };
}
// SR işleri: karo karo kaydedilir, hata/yeniden yüklemede kaldığı yerden devam eder
async function runTracked(cmd, base, args, resume) {
  const id = resume ? resume.id : 'j' + Date.now();
  const job = resume || { id, cmd, tool: st.tool, args: { ...args }, w: base.w, h: base.h, created: Date.now(), plan: null, tiles: new Map() };
  if (!resume) { job.input = base.data.slice().buffer; await DB.jobPut({ ...job, tiles: undefined }).catch(() => {}); }
  prog.job = job;
  let tries = 0;
  for (;;) {
    try {
      const a = { ...args, img: pack(base), track: true, plan: job.plan, done: [...job.tiles.entries()].map(([i, b]) => [i, b.slice(0)]) };
      const transfer = [a.img.buffer, ...a.done.map(d => d[1])];
      const t0 = performance.now(), before = job.tiles.size;
      const out = await runJob(cmd, a, transfer);
      if (job.plan && job.tiles.size > before) {
        const ep = lastEp.startsWith('GPU') ? 'gpu' : 'cpu', px = job.plan.iw * job.plan.ih * (job.tiles.size - before) / Math.max(1, job.tiles.size);
        rates[ep] = Math.round(px / ((performance.now() - t0) / 1000)); saveRates();
      }
      DB.jobDel(id).catch(() => {}); prog.job = null;
      return out;
    } catch (err) {
      if (err.cancelled || tries++ >= 1 || !job.tiles.size) { if (err.cancelled) DB.jobDel(id).catch(() => {}); prog.job = null; throw err; }
      toast('Bir sorun oldu, kaldığı yerden devam ediliyor…', 3500);
      await sleep(600);
    }
  }
}

function estimate(kind) {
  if (!st.base) return '';
  const gpu = engine && engine.info.gpu && !gpuOffList().includes('fast');
  const rate = rates[gpu ? 'gpu' : 'cpu'] || (gpu ? 200000 : (engine && engine.info.threads > 1 ? 16000 : 10000));
  let pix;
  const b = st.base, sc = kind === 'enh' ? 2 : +S.scale;
  let tw = b.w * sc, th = b.h * sc; if (tw * th > MAX_OUT) { const k = Math.sqrt(MAX_OUT / (tw * th)); tw *= k; th *= k; }
  const budget = gpu ? GPU_TILE : Math.min(CPU_TILE_MAX, +S.cpuBudget * 1e6);
  pix = Math.max(tw * th / 16, Math.min(b.w * b.h, budget));
  let sec = pix / rate * (S.model === 'best' && kind !== 'enh' ? 6 : 1);
  return { sec, tw: Math.round(tw), th: Math.round(th), gpu };
}
function updateHints() {
  if (!st.base) return;
  const e = estimate('up');
  if (e) $('#upHint').textContent = 'Çıktı: ' + e.tw + '×' + e.th + ' px · tahmini ' + fmtSec(e.sec) + (e.gpu ? ' (GPU)' : ' (CPU)') + '. ' + (!e.gpu ? 'CPU modunda hız için giriş küçültülür (Ayarlar > CPU\'da büyütme).' : '') + (MODELS[S.model] ? ' İlk kullanımda ~' + Math.round(MODELS[S.model].mb + (S.faceOn ? 79 : 0)) + ' MB model indirilir.' : '');
  const e2 = estimate('enh');
  $('#enhHint').textContent = S.enhSize === '2x'
    ? '2× detaylı: Real-ESRGAN ile çözünürlük artar (' + e2.tw + '×' + e2.th + '), tahmini ' + fmtSec(e2.sec + 3) + '.'
    : 'Işık, beyaz dengesi, gürültü, yüz ve netlik tek seferde düzeltilir. Birkaç saniye sürer.';
}

$('#runBtn').addEventListener('click', async () => {
  if (busy || !st.base) return;
  haptic();
  const tool = st.tool, T = TOOLS[tool];
  if (T.comp) return exportComp();
  if (tool === 'collage') return exportCollage();
  if (tool === 'effects') return saveCurrent(st.result || st.base, 'efekt');
  const base = st.base;
  try {
    let out, tag;
    await withProc(T.t, base, async () => {
      if (tool === 'enhance') {
        const a = srArgs(base, { detail: S.enhSize === '2x', face: S.enhFace, faceS: 0.25 + 0.35 * (S.enhAmt / 100), amount: 0.5 + 0.7 * (S.enhAmt / 100) });
        out = a.detail ? await runTracked('autoenhance', base, a) : await runJob('autoenhance', { ...a, img: pack(base) });
        tag = 'iyilestirilmis';
      } else if (tool === 'upscale') {
        out = await runTracked('upscale', base, srArgs(base, { model: S.model, scale: +S.scale, face: S.faceOn ? { model: 'gpen', s: 0.4 } : null }));
        tag = S.scale + 'x';
      } else if (tool === 'faces') {
        out = await runJob('faces', { img: pack(base), model: S.faceModel, s: 0.5 });
        st.faceRaw = out; tag = 'yuz';
      } else if (tool === 'color') {
        out = await runJob('enhance', { img: pack(base), params: colorParams() }); tag = 'renk';
      }
    });
    st.result = out; st.resultTag = tag;
    if (tool === 'faces') { faceBlendPreview(true); }
    else showCompare(base, out, true);
    setDims(base.w + '×' + base.h + ' → ' + out.w + '×' + out.h);
    $('#runBtn').hidden = true; $('#resultBar').hidden = false; haptic();
    toast('Bitti · ' + fmtSec(lastInfo.ms / 1000) + (lastInfo.faces ? ' · ' + lastInfo.faces + ' yüz' : ''));
  } catch (err) {
    toast(err.cancelled ? 'Durduruldu' : 'Hata: ' + err.message, 5000);
  }
});
function optionChanged() { if (st.result && !TOOLS[st.tool]?.comp && st.tool !== 'effects') { $('#runBtn').hidden = false; $('#resultBar').hidden = true; } updateHints(); }
$('#continueBtn').addEventListener('click', () => {
  haptic(); if (!st.result) return;
  const r = st.tool === 'faces' ? faceBlendFull() : st.result;
  setBase(r); closeTool(); toast('Sonuç üzerinde devam: bir araç seç');
});
$('#saveBtn').addEventListener('click', () => { haptic(); const r = st.tool === 'faces' ? faceBlendFull() : st.result; if (r) saveCurrent(r, st.resultTag || 'netlik'); });
$('#shareTop').addEventListener('click', () => { haptic(); if (TOOLS[st.tool]?.comp) return exportComp(); saveCurrent(st.tool === 'faces' && st.result ? faceBlendFull() : (st.result || st.base), st.resultTag || 'netlik'); });

let pendingShare = null;
async function saveCurrent(img, tag) {
  if (pendingShare && pendingShare.img === img) { await shareBlobs([pendingShare]); return; }
  const { blob, thumb } = await encode(img);
  const item = { blob, name: fname(blob, tag), img };
  DB.addItem({ blob, thumb, w: img.w, h: img.h, label: tag }).catch(() => {});
  pendingShare = item;
  const ok = await shareBlobs([item]);
  if (!ok) toast('İçerik\'e kaydedildi. Paylaşmak için tekrar dokun.', 3500);
}

// ---------------- yüz: güç kaydırıcısı (anlık karışım) ----------------
let fbCache = null;
function faceBlendPreview(animate) {
  if (!st.faceRaw) return;
  if (!fbCache || fbCache.raw !== st.faceRaw) fbCache = { raw: st.faceRaw, a: smallImg(st.base), b: smallImg(st.faceRaw) };
  const k = +$('#faceBlend').value / 100, a = fbCache.a, b = fbCache.b, o = { w: a.w, h: a.h, data: new Uint8ClampedArray(a.data.length) };
  for (let i = 0; i < o.data.length; i++) o.data[i] = a.data[i] + (b.data[i] - a.data[i]) * k;
  if (animate) showCompare(a, o, true); else { drawDisplay($('#cAfter'), o); }
}
function faceBlendFull() {
  const k = +$('#faceBlend').value / 100, a = st.base, b = st.faceRaw, o = { w: a.w, h: a.h, data: new Uint8ClampedArray(a.data.length) };
  for (let i = 0; i < o.data.length; i++) o.data[i] = a.data[i] + (b.data[i] - a.data[i]) * k;
  return o;
}
const faceBlend = $('#faceBlend'); rangeFill(faceBlend);
faceBlend.addEventListener('input', () => { rangeFill(faceBlend); $('#o_faceBlend').textContent = faceBlend.value; if (st.faceRaw) faceBlendPreview(false); });

// ---------------- seçenek bağlama ----------------
$$('[data-opt]').forEach(seg => {
  const k = seg.dataset.opt;
  seg._ctl = setupSeg(seg, S[k], v => {
    S[k] = v; saveS();
    if (k === 'theme') applyTheme();
    if (k === 'bMode') $('#bScaleRow').hidden = v !== 'upscale';
    if (k === 'pfShape') $('#cwrap').classList.toggle('circle', v === 'circle');
    if (k === 'rzFit' || k === 'rzBg') applyResizeOpts();
    if (k === 'faceModel') { st.faceRaw = null; }
    if (k === 'colT') renderCollage();
    optionChanged();
  });
});
$('#bScaleRow').hidden = S.bMode !== 'upscale';
const bindSwitch = (id, key) => { const el = $(id); el.checked = !!S[key]; el.addEventListener('change', () => { haptic(); S[key] = el.checked; saveS(); optionChanged(); }); };
bindSwitch('#enhFace', 'enhFace'); bindSwitch('#faceOn', 'faceOn');
const enhAmt = $('#enhAmt'); enhAmt.value = S.enhAmt; rangeFill(enhAmt); $('#o_enhAmt').textContent = S.enhAmt;
enhAmt.addEventListener('input', () => { S.enhAmt = +enhAmt.value; rangeFill(enhAmt); $('#o_enhAmt').textContent = enhAmt.value; saveS(); optionChanged(); });

// ---------------- renk ----------------
const cAuto = $('#cAuto'), colorRanges = $$('[data-c]');
const COLOR_DEF = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sharpen: 30 };
function colorParams() { const p = { auto: cAuto.checked }; colorRanges.forEach(r => { p[r.dataset.c] = +r.value / 100; }); return p; }
let prevRaf = 0, autoInfo = null, prevSmall = null;
function colorPreview() {
  if (!st.base || st.tool !== 'color') return;
  cancelAnimationFrame(prevRaf);
  prevRaf = requestAnimationFrame(() => {
    if (!prevSmall || prevSmall.src !== st.base) { prevSmall = { src: st.base, img: smallImg(st.base, 1024) }; autoInfo = C.analyzeAuto(prevSmall.img); }
    const out = C.enhance(prevSmall.img, colorParams(), autoInfo);
    drawDisplay($('#cBefore'), prevSmall.img); drawDisplay($('#cAfter'), out);
    $('#cwrap').classList.remove('single', 'checker'); layoutStage();
    if (parseFloat($('#divider').style.left || '50') > 99) setSplit(50);
  });
}
colorRanges.forEach(r => { rangeFill(r); r.addEventListener('input', () => { rangeFill(r); $('#o_' + r.dataset.c).textContent = r.value; colorPreview(); optionChanged(); }); });
cAuto.addEventListener('change', () => { haptic(); colorPreview(); });
$('#colorReset').addEventListener('click', () => { haptic(); colorRanges.forEach(r => { r.value = COLOR_DEF[r.dataset.c]; $('#o_' + r.dataset.c).textContent = r.value; rangeFill(r); }); cAuto.checked = true; colorPreview(); });

// ---------------- özne ayırma (önbellekli) ----------------
async function ensureCut(title = 'Arka plan kaldırılıyor') {
  if (st.cut && st.cutFor === st.baseId) return st.cut;
  const base = st.base;
  const cut = await withProc(title, base, () => runJob('segment', { img: pack(base) }));
  st.cut = cut; st.cutFor = st.baseId; st.cutBox = lastInfo.box;
  st.cutCanvas = imgCanvas(cut);
  st.alpha = new Uint8ClampedArray(cut.w * cut.h); for (let i = 0; i < st.alpha.length; i++) st.alpha[i] = cut.data[i * 4 + 3];
  if (!st.cutBox) toast('Fotoğrafta belirgin bir özne bulunamadı', 4000);
  return cut;
}
async function ensureFaces() {
  if (st.faces && st.facesFor === st.baseId) return st.faces;
  const r = await runJob('detect', { img: pack(st.base) });
  st.faces = lastInfo.faces || []; st.facesFor = st.baseId;
  return st.faces;
}

// ---------------- arka plan listesi ----------------
const COLORS = ['#ffffff', '#f2f2f2', '#1f2937', '#000000', '#e8dcc8', '#c7d2fe', '#bfdbfe', '#bbf7d0', '#fecaca', '#fde68a', '#0b3d91', '#7c3aed'];
const GRADS = [['#667eea', '#764ba2'], ['#2b5876', '#4e4376'], ['#ee9ca7', '#ffdde1'], ['#43cea2', '#185a9d'], ['#f7971e', '#ffd200'], ['#e0e0e0', '#9e9e9e', true], ['#3a3f4b', '#14161b', true], ['#fdfbfb', '#d9dde3', true]];
const SCENES = [['studio', 'Stüdyo'], ['office', 'Ofis'], ['library', 'Kütüphane'], ['city', 'Şehir'], ['park', 'Park'], ['mountain', 'Dağ gölü'], ['beach', 'Sahil'], ['bosphorus', 'Boğaz']];
const sceneCache = new Map();
async function sceneImg(id) { if (!sceneCache.has(id)) sceneCache.set(id, await loadImage('bg/' + id + '.jpg')); return sceneCache.get(id); }
let userBg = null;
function buildBgList(el, onPick, opts = {}) {
  el.innerHTML = '';
  const add = (cls, style, label, spec) => {
    const b = document.createElement('button'); b.className = 'sw press ' + cls; if (style) b.style.cssText = style; b.textContent = label || '';
    b.addEventListener('click', async () => { haptic(); el.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); await onPick(typeof spec === 'function' ? await spec() : spec); });
    el.appendChild(b); return b;
  };
  if (opts.none !== false) add('none', '', 'Şeffaf', { type: 'none' });
  add('blurbg', 'background:linear-gradient(135deg,#475569,#94a3b8)', 'Bulanık', { type: 'blur' });
  SCENES.forEach(([id, n]) => add('', `background-image:url(bg/${id}_t.jpg)`, n, async () => ({ type: 'img', img: await sceneImg(id), id })));
  add('add', '', '+', async () => new Promise(res => { const inp = $('#bgFileIn'); inp.onchange = async () => { const f = inp.files[0]; inp.value = ''; if (!f) return res(null); const i = await loadImage(URL.createObjectURL(f)); userBg = i; res({ type: 'img', img: i, id: 'user' }); }; inp.click(); }));
  GRADS.forEach(([a, b2, rad]) => add('', `background:${rad ? `radial-gradient(circle at 50% 40%,${a},${b2})` : `linear-gradient(160deg,${a},${b2})`}`, '', { type: 'grad', a, b: b2, angle: 160, radial: !!rad }));
  COLORS.forEach(c => add('', `background:${c}`, '', { type: 'color', c }));
  return el;
}
function selectSw(el, idx) { const s = el.querySelectorAll('.sw'); s.forEach(x => x.classList.remove('on')); s[idx] && s[idx].classList.add('on'); }

// renk uyumu: arka planın ortalama tonunu özneye hafifçe yansıt
function bgMean(spec) {
  if (spec.type === 'color') return F.hexRgb(spec.c);
  if (spec.type === 'grad') { const a = F.hexRgb(spec.a), b = F.hexRgb(spec.b); return [0, 1, 2].map(i => (a[i] + b[i]) / 2); }
  if ((spec.type === 'img' || spec.type === 'blur') && spec.img) { const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d'); x.drawImage(spec.img, 0, 0, 8, 8); const d = x.getImageData(0, 0, 8, 8).data; const m = [0, 0, 0]; for (let i = 0; i < 256; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; } return m.map(v => v / 64); }
  return null;
}
function harmonized(cutCanvas, spec, strength) {
  const bm = bgMean(spec); if (!bm || !strength) return null;
  const x = cutCanvas.getContext('2d'), d = x.getImageData(0, 0, cutCanvas.width, cutCanvas.height), p = d.data;
  let fs = [0, 0, 0], fc = 0; const step = Math.max(4, Math.floor(p.length / 4 / 60000) * 4);
  for (let i = 0; i < p.length; i += step) if (p[i + 3] > 230) { fs[0] += p[i]; fs[1] += p[i + 1]; fs[2] += p[i + 2]; fc++; }
  if (fc < 20) return null;
  const fm = fs.map(v => v / fc), fl = (fm[0] + fm[1] + fm[2]) / 3 || 1, bl = (bm[0] + bm[1] + bm[2]) / 3 || 1;
  const hm = [0, 1, 2].map(k => Math.max(0.9, Math.min(1.1, 1 + strength * 0.3 * ((bm[k] / bl) / (fm[k] / fl) - 1))));
  const lum = Math.max(0.92, Math.min(1.06, 1 + strength * 0.12 * (bl / fl - 1)));
  for (let i = 0; i < p.length; i += 4) { p[i] *= hm[0] * lum; p[i + 1] *= hm[1] * lum; p[i + 2] *= hm[2] * lum; }
  const c = document.createElement('canvas'); c.width = cutCanvas.width; c.height = cutCanvas.height; c.getContext('2d').putImageData(d, 0, 0);
  return c;
}

// ---------------- tuval (editör / profil / boyut) ----------------
let compRaf = 0;
function renderComp() {
  const cp = st.comp; if (!cp) return;
  const k = Math.min(1, DISP / Math.max(cp.W, cp.H));
  cp.render($('#cAfter'), k, { ui: true });
  $('#cBefore').width = 1; $('#cwrap').classList.add('single');
  $('#cwrap').classList.toggle('checker', cp.bg.type === 'none');
}
function renderCompSoon() { cancelAnimationFrame(compRaf); compRaf = requestAnimationFrame(renderComp); }
function relayoutComp() { renderComp(); layoutStage(); setDims(st.comp.W + '×' + st.comp.H); }
function pushUndo() { const cp = st.comp; if (!cp) return; st.undo.push({ W: cp.W, H: cp.H, t: { ...cp.t }, bg: cp.bg, shadow: { ...cp.shadow }, texts: cp.texts.map(t => ({ ...t })), fgDraw: cp.fgDraw }); if (st.undo.length > 30) st.undo.shift(); }
$('#undoBtn').addEventListener('click', () => { haptic(); const u = st.undo.pop(), cp = st.comp; if (!u || !cp) return; Object.assign(cp, { W: u.W, H: u.H, t: u.t, bg: u.bg, shadow: u.shadow, texts: u.texts, fgDraw: u.fgDraw }); relayoutComp(); });
let blurCache = null;
function blurredFor(alphaAware) {
  const key = st.baseId + ':' + alphaAware;
  if (blurCache && blurCache.key === key) return blurCache.c;
  const sm = smallImg(st.base, 640), r = Math.max(3, Math.round(Math.max(sm.w, sm.h) * 0.03 * (+$('#bgBlur').value / 60)));
  let bl;
  if (alphaAware && st.alpha) { const a = smallAlpha(sm.w, sm.h); bl = F.maskedBlur(sm, a, r); }
  else bl = C.boxBlurRGB(sm, r, 3);
  blurCache = { key, c: imgCanvas(bl) }; return blurCache.c;
}
function smallAlpha(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(st.cutCanvas, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data, a = new Uint8ClampedArray(w * h); for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]; return a; }
async function setCompBg(spec) {
  const cp = st.comp; if (!cp || !spec) return;
  pushUndo();
  if (spec.type === 'blur') { spec = { type: 'blur', img: blurredFor(st.tool !== 'resize'), aligned: st.tool !== 'resize' }; }
  cp.bg = spec;
  cp.fgDraw = $('#harmOn').checked && st.tool !== 'resize' && spec.type !== 'none' && spec.type !== 'blur' ? harmonized(cp.fg, spec, 0.8) : null;
  $('#bgBlurRow').hidden = spec.type !== 'blur';
  renderComp();
}
$('#harmOn').addEventListener('change', () => { haptic(); if (st.comp) setCompBg(st.comp.bg.type === 'blur' ? { type: 'blur' } : st.comp.bg); });
const bgBlur = $('#bgBlur'); rangeFill(bgBlur);
bgBlur.addEventListener('change', () => { blurCache = null; if (st.comp && st.comp.bg.type === 'blur') setCompBg({ type: 'blur' }); });
bgBlur.addEventListener('input', () => rangeFill(bgBlur));

async function initEditor(tool) {
  await ensureCut();
  const cp = st.comp = new Composer();
  const k = Math.min(1, 4096 / Math.max(st.base.w, st.base.h));
  cp.W = Math.round(st.base.w * k); cp.H = Math.round(st.base.h * k);
  cp.fg = st.cutCanvas; cp.fgBox = st.cutBox; cp.original = imgCanvas(st.base);
  cp.fitContain(1);
  st.mode = 'comp';
  buildBgList($('#bgList'), setCompBg);
  if (tool === 'bgscene') { const s = await sceneImg('office'); await setCompBg({ type: 'img', img: s, id: 'office' }); selectSw($('#bgList'), 3); }
  else { cp.bg = { type: 'none' }; selectSw($('#bgList'), 0); }
  st.undo = [];
  edTab('bg');
  relayoutComp();
}
function edTab(e) { $$('#edTabs button').forEach(b => b.classList.toggle('on', b.dataset.e === e)); $$('.ed-pane').forEach(p => p.classList.toggle('on', p.dataset.e === e)); }
$$('#edTabs button').forEach(b => b.addEventListener('click', () => {
  haptic(); const e = b.dataset.e;
  if (e === 'fx') { buildFxRow($('#edFx'), id => { closeTool(); setTimeout(() => openTool('effects', { fx: id }), 380); }); }
  edTab(e);
}));
// metin
const TXT_COLORS = ['#ffffff', '#111111', '#facc15', '#f87171', '#60a5fa', '#a78bfa', '#34d399'];
let txtColor = '#ffffff';
(() => {
  const el = $('#txtColors');
  TXT_COLORS.forEach((c, i) => { const b = document.createElement('button'); b.className = 'sw press' + (i ? '' : ' on'); b.style.background = c; b.onclick = () => { haptic(); el.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); txtColor = c; const cp = st.comp; if (cp && cp.sel >= 0) { pushUndo(); cp.texts[cp.sel].color = c; renderComp(); } }; el.appendChild(b); });
})();
$('#txtAdd').addEventListener('click', () => {
  haptic(); const cp = st.comp; if (!cp) return; const v = $('#txtIn').value.trim();
  pushUndo();
  if (cp.sel >= 0) { if (!v) cp.texts.splice(cp.sel, 1); else cp.texts[cp.sel].t = v; cp.sel = -1; }
  else if (v) { cp.texts.push({ t: v, x: 0.5, y: 0.12 + 0.08 * (cp.texts.length % 5), size: +$('#txtSize').value / 100, color: txtColor }); cp.sel = cp.texts.length - 1; }
  $('#txtIn').value = ''; renderComp();
});
const txtSize = $('#txtSize'); rangeFill(txtSize);
txtSize.addEventListener('input', () => { rangeFill(txtSize); const cp = st.comp; if (cp && cp.sel >= 0) { cp.texts[cp.sel].size = +txtSize.value / 100; renderCompSoon(); } });
// gölge
const shOn = $('#shOn'), shSoft = $('#shSoft'), shDark = $('#shDark'); [shSoft, shDark].forEach(rangeFill);
const shUpd = () => { const cp = st.comp; if (!cp) return; cp.shadow = { on: shOn.checked, soft: +shSoft.value / 100, dark: +shDark.value / 100 }; renderCompSoon(); };
shOn.addEventListener('change', () => { haptic(); pushUndo(); shUpd(); });
[shSoft, shDark].forEach(r => r.addEventListener('input', () => { rangeFill(r); if (!shOn.checked) { shOn.checked = true; } shUpd(); }));
$('#edResize').addEventListener('click', () => { haptic(); openSizes(applySizeToEditor); });
function applySizeToEditor(sz) {
  const cp = st.comp; if (!cp) return; pushUndo();
  if (sz.id === 'subject') return cropToSubject();
  cp.W = sz.w; cp.H = sz.h; cp.fitContain(0.92); relayoutComp();
}
function cropToSubject() {
  const cp = st.comp, b = st.cutBox; if (!b) return toast('Önce özne bulunmalı');
  const m = Math.round(Math.max(b.w, b.h) * 0.04);
  const kk = cp.fg.width / st.base.w;
  cp.W = Math.round((b.w + 2 * m) * kk); cp.H = Math.round((b.h + 2 * m) * kk);
  cp.t = { s: 1, x: cp.W / 2 - (b.x + b.w / 2 - st.base.w / 2) * kk, y: cp.H / 2 - (b.y + b.h / 2 - st.base.h / 2) * kk };
  relayoutComp();
}

// profil
async function initProfile() {
  await ensureCut();
  const faces = await ensureFaces();
  const cp = st.comp = new Composer();
  cp.W = cp.H = 1080; cp.fg = st.cutCanvas; cp.fgBox = st.cutBox; cp.original = imgCanvas(st.base);
  st.pfFace = faces.length ? faces.slice().sort((a, b) => (b.box[2] - b.box[0]) - (a.box[2] - a.box[0]))[0] : null;
  if (!st.pfFace) toast('Yüz bulunamadı; özneye göre kırpıldı', 4000);
  st.mode = 'comp';
  buildBgList($('#pfBgList'), setCompBg, { none: true });
  await setCompBg({ type: 'grad', a: '#e0e0e0', b: '#9e9e9e', radial: true });
  selectSw($('#pfBgList'), 1 + 1 + SCENES.length + 1 + 5);
  $('#cwrap').classList.toggle('circle', S.pfShape === 'circle');
  $('#pfFace').checked = false;
  profileFit(); st.undo = []; relayoutComp();
}
function profileFit() {
  const cp = st.comp, z = +$('#pfZoom').value / 100;
  if (st.pfFace) {
    const [x0, y0, x1, y1] = st.pfFace.box, fw = x1 - x0, fcx = (x0 + x1) / 2, fcy = (y0 + y1) / 2;
    const s = 1080 * 0.34 / fw * z;
    cp.t = { s, x: 540 - (fcx - st.base.w / 2) * s, y: 1080 * 0.43 - (fcy - st.base.h / 2) * s };
  } else if (st.cutBox) {
    const b = st.cutBox, s = 1080 * 0.9 / Math.max(b.w, b.h) * z;
    cp.t = { s, x: 540 - (b.x + b.w / 2 - st.base.w / 2) * s, y: 540 - (b.y + b.h / 2 - st.base.h / 2) * s };
  } else cp.fitCover();
}
const pfZoom = $('#pfZoom'); rangeFill(pfZoom);
pfZoom.addEventListener('input', () => { rangeFill(pfZoom); if (st.tool === 'profile' && st.comp) { profileFit(); renderCompSoon(); } });
$('#pfFace').addEventListener('change', async () => {
  haptic(); const cp = st.comp; if (!cp) return;
  if ($('#pfFace').checked) {
    try {
      if (!st.pfRest || st.pfRestFor !== st.baseId) {
        const r = await withProc('Yüz iyileştiriliyor', st.base, () => runJob('faces', { img: pack(st.base), model: 'gpen', s: 0.35 }));
        const d = new Uint8ClampedArray(r.data); for (let i = 0; i < st.alpha.length; i++) d[i * 4 + 3] = st.alpha[i];
        st.pfRest = imgCanvas({ w: r.w, h: r.h, data: d }); st.pfRestFor = st.baseId;
      }
      cp.fg = st.pfRest;
    } catch (err) { $('#pfFace').checked = false; toast(err.cancelled ? 'Durduruldu' : err.message); return; }
  } else cp.fg = st.cutCanvas;
  setCompBg(cp.bg.type === 'blur' ? { type: 'blur' } : cp.bg);
});

// boyutlandır
function initResize(opt) {
  const cp = st.comp = new Composer();
  cp.fg = imgCanvas(st.base); cp.original = cp.fg;
  st.mode = 'comp';
  const sz = SIZES.find(s => s.id === S.rzSize) || SIZES.find(s => s.id === 'igpost');
  setResizeSize(sz);
  buildColorSw($('#rzColors'), c => { pushUndo(); cp.bg = { type: 'color', c }; renderComp(); });
  st.undo = [];
  if (!opt.keepSize) setTimeout(() => openSizes(sz => setResizeSize(sz)), 250);
}
function buildColorSw(el, cb) { el.innerHTML = ''; COLORS.forEach((c, i) => { const b = document.createElement('button'); b.className = 'sw press' + (i ? '' : ' on'); b.style.background = c; b.onclick = () => { haptic(); el.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); cb(c); }; el.appendChild(b); }); }
function setResizeSize(sz) {
  const cp = st.comp; if (!cp) return;
  if (sz.id === 'subject') { if (!st.cut || st.cutFor !== st.baseId) return toast('Önce Arka plan aracında özneyi ayır'); const b = st.cutBox; cp.W = b.w; cp.H = b.h; cp.t = { s: 1, x: cp.W / 2 - (b.x + b.w / 2 - st.base.w / 2), y: cp.H / 2 - (b.y + b.h / 2 - st.base.h / 2) }; }
  else { cp.W = sz.w; cp.H = sz.h; applyResizeOpts(true); }
  S.rzSize = sz.id; S.recent = [sz.id, ...S.recent.filter(x => x !== sz.id)].slice(0, 4); saveS();
  $('#rzName').textContent = sz.n; $('#rzSub').textContent = cp.W + '×' + cp.H + ' · ' + ratioLabel(cp.W, cp.H);
  relayoutComp();
}
function applyResizeOpts(noRender) {
  const cp = st.comp; if (!cp || st.tool !== 'resize') return;
  if (S.rzFit === 'fill') cp.fitCover(); else cp.fitContain(1);
  $('#rzColors').hidden = S.rzBg !== 'color';
  if (S.rzBg === 'blur') cp.bg = { type: 'blur', img: blurredFor(false) };
  else if (S.rzBg === 'extend') { const sm = smallImg(st.base, 24); cp.bg = { type: 'extend', img: imgCanvas(sm) }; }
  else cp.bg = { type: 'color', c: cp.bg.c || '#ffffff' };
  if (!noRender) relayoutComp();
}
$('#rzPick').addEventListener('click', () => { haptic(); openSizes(sz => setResizeSize(sz)); });

// boyut listesi ekranı
let sizeCb = null;
function openSizes(cb) {
  sizeCb = cb; $('#sizeQ').value = ''; renderSizes(''); openScreen('sizeScreen');
}
function renderSizes(q) {
  const el = $('#sizeList'); el.innerHTML = '';
  q = q.toLocaleLowerCase('tr');
  const match = s => !q || (s.n + ' ' + s.g + ' ' + s.w + 'x' + s.h).toLocaleLowerCase('tr').includes(q);
  const groups = [['Son', S.recent.map(id => SIZES.find(s => s.id === id)).filter(Boolean)]];
  ['Standart', 'Sosyal medya', 'Belge'].forEach(g => groups.push([g, SIZES.filter(s => s.g === g)]));
  for (const [g, list] of groups) {
    const L = list.filter(match); if (!L.length) continue;
    const h = document.createElement('h4'); h.textContent = g; el.appendChild(h);
    for (const s of L) {
      const b = document.createElement('button'); b.className = 'size-item';
      const r = s.w ? s.w / s.h : 1, iw = r >= 1 ? 24 : 24 * r, ih = r >= 1 ? 24 / r : 24;
      const sub = s.id === 'custom' ? 'Genişlik × yükseklik gir' : s.id === 'subject' ? (st.cut && st.cutFor === st.baseId ? 'Özneye sıkıca kırp' : 'Önce özneyi ayır (Arka plan aracı)') : s.w + '×' + s.h + ', ' + ratioLabel(s.w, s.h) + (s.sub ? ' · ' + s.sub : '');
      b.innerHTML = `<span class="si-ic"><i style="width:${Math.max(6, iw)}px;height:${Math.max(6, ih)}px"></i></span><span><b></b><small></small></span>`;
      b.querySelector('b').textContent = s.n; b.querySelector('small').textContent = sub;
      if (s.id === 'subject' && !(st.cut && st.cutFor === st.baseId)) b.disabled = true;
      b.onclick = () => {
        haptic();
        let sz = s;
        if (s.id === 'custom') { const v = prompt('Boyut (ör. 1200x800):', '1200x800'); if (!v) return; const m = v.match(/(\d+)\s*[x×*]\s*(\d+)/i); if (!m) return toast('Geçersiz boyut'); sz = { ...s, w: Math.min(8000, +m[1]), h: Math.min(8000, +m[2]), n: 'Özel ' + m[1] + '×' + m[2] }; }
        closeScreen('sizeScreen'); sizeCb && sizeCb(sz);
      };
      el.appendChild(b);
    }
  }
}
$('#sizeQ').addEventListener('input', e => renderSizes(e.target.value));
$('#sizeX').addEventListener('click', () => { haptic(); closeScreen('sizeScreen'); });

async function exportComp() {
  const cp = st.comp; if (!cp || busy) return;
  const tag = st.tool === 'profile' ? 'profil' : st.tool === 'resize' ? 'boyut' : 'duzenleme';
  cp.sel = -1; cp.showOriginal = false; $('#eyeBtn').classList.remove('on');
  const c = document.createElement('canvas');
  let k = 1; if (cp.W * cp.H > MAX_OUT) k = Math.sqrt(MAX_OUT / (cp.W * cp.H));
  cp.render(c, k);
  const png = cp.bg.type === 'none';
  const blob = await canvasBlob(c, png, 0.94), thumb = await thumbOf(c, png);
  DB.addItem({ blob, thumb, w: c.width, h: c.height, label: tag }).catch(() => {});
  const ok = await shareBlobs([{ blob, name: fname(blob, tag) }]);
  if (!ok) { pendingShare = { blob, name: fname(blob, tag) }; toast('İçerik\'e kaydedildi. Paylaşmak için Paylaş\'a dokun.', 3500); }
  else toast('Kaydedildi');
  renderComp();
}

// ---------------- klasik efektler ----------------
function fxThumb(id) { return `img/fx_${id}.jpg`; }
function buildFxRow(el, onPick, selId) {
  el.innerHTML = '';
  F.EFFECTS.forEach(e => {
    const b = document.createElement('button'); b.className = 'ccard press' + (e.id === selId ? ' on' : '');
    b.innerHTML = `<div class="cc-img" style="background-image:url(${fxThumb(e.id)})"></div><b></b>`;
    b.querySelector('b').textContent = e.name;
    b.onclick = () => { haptic(); el.querySelectorAll('.ccard').forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(e.id); };
    el.appendChild(b);
  });
}
function initEffects(fx) {
  buildFxRow($('#fxRow'), id => applyFx(id), fx);
  $('#runBtn').hidden = false; $('#runTxt').textContent = 'Kaydet';
  if (fx) applyFx(fx);
}
let fxBusy = false;
async function applyFx(id) {
  if (fxBusy) return; fxBusy = true;
  try {
    const e = F.EFFECTS.find(x => x.id === id); st.fx = id;
    $('#fxAmtRow').hidden = !['blur', 'motion'].includes(id);
    if (e.needsMask) await ensureCut('Özne ayrılıyor');
    const alpha = e.needsMask ? st.alpha.slice().buffer : new ArrayBuffer(st.base.w * st.base.h);
    const out = await runJob('effect', { img: pack(st.base), alpha, id, amount: +$('#fxAmt').value / 100 }, null);
    st.result = out; st.resultTag = 'efekt-' + id;
    showCompare(st.base, out, true);
  } catch (err) { if (!err.cancelled) toast('Hata: ' + err.message); }
  finally { fxBusy = false; }
}
const fxAmt = $('#fxAmt'); rangeFill(fxAmt);
fxAmt.addEventListener('input', () => rangeFill(fxAmt));
fxAmt.addEventListener('change', () => { if (st.fx) applyFx(st.fx); });

// ana sayfa & YZ sayfası efekt kartları
(() => {
  const car = $('#fxCarousel'), grid = $('#fxGrid');
  F.EFFECTS.forEach(e => {
    for (const el of [car, grid]) {
      const b = document.createElement('button'); b.className = 'ccard press';
      b.innerHTML = `<div class="cc-img" style="background-image:url(${fxThumb(e.id)})"></div><b></b>`;
      b.querySelector('b').textContent = e.name;
      b.onclick = () => startTool('effects', { fx: e.id });
      el.appendChild(b);
    }
  });
  $('#fxAll').addEventListener('click', () => { haptic(); go('ai'); setTimeout(() => $('#fxGrid').scrollIntoView({ behavior: 'smooth' }), 400); });
  const items = [['enhance', 'Görsel İyileştirici', 'Tek dokunuşla ışık, renk, yüz ve netlik', 'img/enh_after.jpg'], ['ai', 'AI Stüdyo', 'Kıyafet, sahne, ürün fotoğrafı (Gemini)', 'img/t_ai.jpg'], ['upscale', 'YZ büyütme', '2× / 4× çözünürlük', 'img/t_up.jpg'], ['faces', 'Yüz iyileştir', 'Yalnızca yüzler, saniyeler içinde', 'img/t_face.jpg'], ['editor', 'Arka planı kaldır', 'Kesip yeni arka plan, metin, gölge', 'img/t_cut.jpg'], ['profile', 'Profil resmi', 'Baş-omuz kırpma, 1080×1080', 'img/t_profile.jpg']];
  const L = $('#aiList');
  items.forEach(([t, n, d, im], i) => { const b = document.createElement('button'); b.className = 'ai-item press'; b.style.animationDelay = i * 0.04 + 's'; b.innerHTML = `<span class="ai-ic" style="background-image:url(${im})"></span><span><b></b><small></small></span>`; b.querySelector('b').textContent = n; b.querySelector('small').textContent = d; b.onclick = () => startTool(t); L.appendChild(b); });
})();

// arama + kategori
let cat = 'all';
function filterHome() {
  const q = $('#homeSearch').value.trim().toLocaleLowerCase('tr');
  $$('#v-home [data-cat]').forEach(el => {
    const okC = cat === 'all' || el.dataset.cat.includes(cat);
    const okQ = !q || (el.dataset.k + ' ' + el.textContent).toLocaleLowerCase('tr').includes(q);
    el.hidden = !(okC && okQ);
  });
}
$('#homeSearch').addEventListener('input', filterHome);
$$('#cats button').forEach(b => b.addEventListener('click', () => { haptic(); $$('#cats button').forEach(x => x.classList.toggle('on', x === b)); cat = b.dataset.c; filterHome(); }));

// ---------------- AI Stüdyo ----------------
const ai = { preset: AI.PRESETS[0], img: null, blob: null, out: null, showBefore: false };
function openAI() {
  openScreen('aiScreen');
  if (!ai.img && st.base) setAiImg(st.base);
  renderAiPresets(); renderAiPreset();
}
function renderAiPresets() {
  const el = $('#aiPresets'); el.innerHTML = '';
  AI.PRESETS.forEach(p => { const b = document.createElement('button'); b.className = 'press' + (p === ai.preset ? ' on' : ''); b.textContent = p.n; b.onclick = () => { haptic(); ai.preset = p; renderAiPresets(); renderAiPreset(); }; el.appendChild(b); });
}
function renderAiPreset() {
  const p = ai.preset;
  $('#aiPresetTitle').textContent = p.n; $('#aiPresetSub').textContent = p.sub;
  $('#aiExamples').innerHTML = `<img src="${p.ex[0]}" alt=""><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><img src="${p.ex[1]}" alt="">`;
  $('#aiExamples').hidden = !!ai.out; $('#aiPrompt').placeholder = p.id === 'free' ? 'Her şeyi tanımla (ör. "üzerine lacivert takım elbise giydir")' : 'İsteğe bağlı ek açıklama…';
  $('#aiQual').textContent = { '1K': '1K Standart', '2K': '2K Yüksek', '4K': '4K Ultra' }[S.aiQual];
  $('#aiRatio').textContent = 'Oran: ' + (S.aiRatio === 'orig' ? 'Orijinal' : S.aiRatio);
}
function setAiImg(img) {
  ai.img = img; ai.out = null; $('#aiResult').hidden = true;
  const c = document.createElement('canvas'); drawDisplay(c, img, 1536);
  $('#aiThumbImg').src = c.toDataURL('image/jpeg', 0.8); $('#aiThumbImg').hidden = false;
  c.toBlob(b => { ai.blob = b; }, 'image/jpeg', 0.9);
  renderAiPreset();
}
$('#aiThumb').addEventListener('click', () => { haptic(); openPicker((img, note, same) => { if (!same) setBase(img); setAiImg(img); }); });
$('#aiBack').addEventListener('click', () => { haptic(); closeScreen('aiScreen'); });
$('#aiKeyBtn').addEventListener('click', () => { haptic(); openSettings(true); });
$('#aiQual').addEventListener('click', () => { haptic(); S.aiQual = { '1K': '2K', '2K': '4K', '4K': '1K' }[S.aiQual]; saveS(); renderAiPreset(); });
$('#aiRatio').addEventListener('click', () => { haptic(); openMenu('En-boy oranı', [['orig', 'Orijinal'], ...AI.RATIOS.map(r => [r, r + ({ '1:1': ' Kare', '3:2': ' Yatay', '2:3': ' Dikey', '9:16': ' Hikâye', '16:9': ' Geniş', '4:5': ' Portre', '3:4': ' Portre', '4:3': ' Yatay' }[r] || '')])], S.aiRatio, v => { S.aiRatio = v; saveS(); renderAiPreset(); }); });
$('#aiSend').addEventListener('click', async () => {
  haptic();
  const key = localStorage.getItem(AI.KEY_LS);
  if (!key) { toast('Önce Gemini API anahtarını ekle', 3500); openSettings(true); return; }
  if (!ai.img || !ai.blob) { toast('Önce bir fotoğraf seç'); $('#aiThumb').click(); return; }
  const text = $('#aiPrompt').value;
  if (ai.preset.id === 'free' && !text.trim()) { toast('Ne yapılacağını yaz'); $('#aiPrompt').focus(); return; }
  const prompt = AI.buildPrompt(ai.preset, text);
  const aspect = S.aiRatio === 'orig' ? AI.nearestRatio(ai.img.w, ai.img.h) : S.aiRatio;
  const model = localStorage.getItem(AI.MODEL_LS) || AI.DEFAULT_MODEL;
  aiAbort = new AbortController();
  busy = true; keepAwake(true); showProc('AI Stüdyo', ai.img);
  $('#procStage').textContent = 'Gemini oluşturuyor…'; $('#procEta').textContent = 'Genellikle 10–40 sn';
  let p = 0; prog.fake = setInterval(() => { p = Math.min(0.92, p + (0.95 - p) * 0.04); procProgress(p, 'Genellikle 10–40 sn'); }, 400);
  try {
    const blob = await AI.geminiEdit({ key, model, prompt, blob: ai.blob, aspect, size: S.aiQual, signal: aiAbort.signal });
    ai.out = blob; ai.outUrl && URL.revokeObjectURL(ai.outUrl); ai.outUrl = URL.createObjectURL(blob);
    $('#aiOut').src = ai.outUrl; $('#aiResult').hidden = false; $('#aiExamples').hidden = true; ai.showBefore = false;
    const t = await thumbOf(await loadImage(ai.outUrl).then(i => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c; }), false);
    DB.addItem({ blob, thumb: t, w: 0, h: 0, label: 'ai-' + ai.preset.id }).catch(() => {});
    haptic(); toast('Hazır! İçerik\'e de kaydedildi.');
  } catch (err) { toast(err.name === 'AbortError' ? 'Durduruldu' : 'AI hatası: ' + err.message, 6000); }
  finally { clearInterval(prog.fake); busy = false; keepAwake(false); showProc(null, null, false); aiAbort = null; }
});
$('#aiCompare').addEventListener('click', () => { haptic(); ai.showBefore = !ai.showBefore; $('#aiOut').src = ai.showBefore ? $('#aiThumbImg').src : ai.outUrl; $('#aiCompare').textContent = ai.showBefore ? 'Sonucu göster' : 'Önce / Sonra'; });
$('#aiAgain').addEventListener('click', () => $('#aiSend').click());
$('#aiSave').addEventListener('click', () => { haptic(); if (ai.out) shareBlobs([{ blob: ai.out, name: fname(ai.out, 'ai') }]); });

// seçim menüsü
function openMenu(title, items, cur, cb) {
  $('#menuTitle').textContent = title; const L = $('#menuList'); L.innerHTML = '';
  items.forEach(([v, n]) => { const b = document.createElement('button'); b.className = 'press' + (v === cur ? ' on' : ''); b.textContent = n; b.onclick = () => { haptic(); closeMenu(); cb(v); }; L.appendChild(b); });
  $('#menuScrim').classList.add('on'); $('#menuSheet').classList.add('on');
}
function closeMenu() { $('#menuScrim').classList.remove('on'); $('#menuSheet').classList.remove('on'); }
$('#menuScrim').addEventListener('click', closeMenu);

// ---------------- ayarlar ----------------
function openSettings(focusKey) {
  openScreen('setScreen'); renderModels(); renderGpuDiag();
  $$('#setScreen .seg').forEach(s => s._ctl && s._ctl.set(S[s.dataset.opt], false));
  const k = localStorage.getItem(AI.KEY_LS); $('#gemKey').value = k ? '••••••••' + k.slice(-4) : '';
  $('#gemModel').value = localStorage.getItem(AI.MODEL_LS) || AI.DEFAULT_MODEL;
  if (focusKey) setTimeout(() => { $('#gemKey').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 400);
}
$('#setX').addEventListener('click', () => { haptic(); closeScreen('setScreen'); });
$('#gemSave').addEventListener('click', () => {
  haptic(); const v = $('#gemKey').value.trim();
  if (!v || v.startsWith('••')) return toast('Anahtarı yapıştır');
  if (!/^[A-Za-z0-9_\-]{20,}$/.test(v)) return toast('Anahtar biçimi hatalı görünüyor');
  localStorage.setItem(AI.KEY_LS, v); $('#gemKey').value = '••••••••' + v.slice(-4); toast('Anahtar bu cihaza kaydedildi');
});
$('#gemKey').addEventListener('focus', e => { if (e.target.value.startsWith('••')) e.target.value = ''; });
$('#gemDel').addEventListener('click', () => { haptic(); localStorage.removeItem(AI.KEY_LS); $('#gemKey').value = ''; toast('Anahtar silindi'); });
$('#gemModel').addEventListener('change', e => localStorage.setItem(AI.MODEL_LS, e.target.value));
async function renderModels() {
  const ul = $('#mList'); let status = {};
  try { const e = await ensureEngine(); status = (await e.run('status')).info; } catch {}
  ul.innerHTML = '';
  for (const k of Object.keys(MODELS)) {
    const li = document.createElement('li'); li.className = status[k] ? 'ok' : '';
    li.innerHTML = '<i class="st"></i><span class="nm"></span><span class="mb"></span>';
    li.querySelector('.nm').textContent = MODELS[k].name; li.querySelector('.mb').textContent = MODELS[k].mb + ' MB';
    if (!status[k]) {
      const b = document.createElement('button'); b.textContent = 'İndir';
      b.onclick = async () => { haptic(); b.textContent = '…'; b.disabled = true; try { await withProc('Model indiriliyor', null, () => engine.run('prefetch', { keys: [k] })); toast('İndirildi'); } catch (err) { toast('İndirilemedi: ' + err.message); } renderModels(); };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}
$('#mClear').addEventListener('click', async () => { haptic(); if (!confirm('İndirilmiş modeller silinsin mi? (Gerekince tekrar indirilir)')) return; try { await (await ensureEngine()).run('clear'); toast('Önbellek temizlendi'); } catch {} renderModels(); });

// ---------------- toplu ----------------
let bItems = [], bRunning = false;
$$('[data-batch]').forEach(b => b.addEventListener('click', () => { haptic(); S.bMode = b.dataset.batch; saveS(); go('batch'); requestAnimationFrame(() => { $$('#v-batch .seg').forEach(s => s._ctl && s._ctl.set(S[s.dataset.opt], false)); $('#bScaleRow').hidden = S.bMode !== 'upscale'; }); }));
$('#bPick').addEventListener('click', () => { haptic(); if (!bRunning) $('#bFileIn').click(); });
$('#bFileIn').addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  bItems = files.map(f => ({ file: f, status: 'wait' }));
  const q = $('#queue'); q.innerHTML = '';
  bItems.forEach((it, i) => {
    const li = document.createElement('li'); li.style.animationDelay = (i * 0.04) + 's';
    li.innerHTML = `<img alt=""><div class="qi"><div class="qn"></div><div class="qs">Sırada</div><div class="bar"><i></i></div></div>`;
    li.querySelector('img').src = URL.createObjectURL(it.file); li.querySelector('.qn').textContent = it.file.name || ('Foto ' + (i + 1));
    it.li = li; it.qs = li.querySelector('.qs'); it.bar = li.querySelector('.bar i'); q.appendChild(li);
  });
  $('#bStart').disabled = false; $('#bShare').hidden = true; $('#bEmpty').hidden = true;
});
$('#bStart').addEventListener('click', async () => {
  if (bRunning) { engine && engine.cancel(); bRunning = 'stop'; $('#bStart').textContent = 'Durduruluyor…'; return; }
  haptic(); bRunning = true; busy = true; $('#bStart').textContent = 'Durdur'; $('#bPick').disabled = true; keepAwake(true);
  let ok = 0;
  for (const it of bItems) {
    if (bRunning === 'stop') break; if (it.status === 'done') continue;
    prog.batchItem = it; it.li.classList.remove('err');
    try {
      it.qs.textContent = 'Açılıyor…';
      const { img } = await decodeFile(it.file);
      let out, tag;
      if (S.bMode === 'upscale') { out = await runJob('upscale', { ...srArgs(img, { model: 'fast', scale: +S.bScale, face: null }), img: pack(img) }); tag = 'toplu-' + S.bScale + 'x'; }
      else if (S.bMode === 'cut') { out = await runJob('segment', { img: pack(img) }); tag = 'toplu-kesik'; }
      else { out = await runJob('autoenhance', { ...srArgs(img, {}), img: pack(img), detail: false, face: true, faceS: 0.45, amount: 1 }); tag = 'toplu-iyi'; }
      it.qs.textContent = 'Kaydediliyor…';
      const { blob, thumb } = await encode(out);
      it.blob = blob; it.name = fname(blob, tag);
      await DB.addItem({ blob, thumb, w: out.w, h: out.h, label: tag }).catch(() => {});
      it.status = 'done'; it.li.classList.add('done'); it.bar.style.width = '100%'; it.qs.textContent = '✓ ' + out.w + '×' + out.h; ok++;
      const btn = document.createElement('button'); btn.textContent = 'Paylaş'; btn.className = 'press'; btn.onclick = () => { haptic(); shareBlobs([{ blob: it.blob, name: it.name }]); }; it.li.appendChild(btn); haptic();
    } catch (err) { it.li.classList.add('err'); it.qs.textContent = err.cancelled ? 'Durduruldu' : 'Hata: ' + err.message; }
  }
  prog.batchItem = null; bRunning = false; busy = false; keepAwake(false);
  $('#bStart').textContent = 'Başlat'; $('#bPick').disabled = false;
  $('#bShare').hidden = bItems.filter(i => i.status === 'done').length < 1;
  toast(ok + ' fotoğraf tamamlandı');
});
$('#bShare').addEventListener('click', () => { haptic(); shareBlobs(bItems.filter(i => i.blob).map(i => ({ blob: i.blob, name: i.name }))); });

// ---------------- içerik (geçmiş) ----------------
let hItems = [], hCur = null;
async function renderHistory() {
  try { hItems = await DB.listItems(); } catch { hItems = []; }
  const g = $('#hGrid'); g.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src)); g.innerHTML = '';
  hItems.forEach((it, i) => {
    const b = document.createElement('button'); b.className = 'press'; b.style.animationDelay = Math.min(i, 15) * 0.03 + 's';
    b.innerHTML = '<img alt=""><span></span>'; b.querySelector('img').src = URL.createObjectURL(it.thumb); b.querySelector('span').textContent = it.label || '';
    b.onclick = () => { haptic(); openHV(it); }; g.appendChild(b);
  });
  $('#hEmpty').hidden = hItems.length > 0; $('#hClear').hidden = hItems.length === 0;
}
function openHV(it) {
  hCur = it; const img = $('#hvImg'); if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(it.blob);
  img.onload = () => { $('#hvMeta').textContent = img.naturalWidth + '×' + img.naturalHeight + ' · ' + (it.blob.size / 1e6).toFixed(1) + ' MB · ' + new Date(it.ts).toLocaleString('tr-TR'); };
  $('#hvScrim').classList.add('on'); $('#hvSheet').classList.add('on');
}
function closeHV() { $('#hvScrim').classList.remove('on'); $('#hvSheet').classList.remove('on'); }
$('#hvScrim').addEventListener('click', closeHV);
$('#hvShare').addEventListener('click', () => { haptic(); hCur && shareBlobs([{ blob: hCur.blob, name: fname(hCur.blob, 'icerik') }]); });
$('#hvDel').addEventListener('click', async () => { haptic(); if (!hCur) return; await DB.delItem(hCur.id); closeHV(); renderHistory(); toast('Silindi'); });
$('#hvEdit').addEventListener('click', async () => { haptic(); if (!hCur) return; closeHV(); const { img } = await decodeFile(hCur.blob); setBase(img); go('home'); toast('Fotoğraf yüklendi: bir araç seç'); });
$('#hClear').addEventListener('click', async () => { if (confirm('Tüm içerik silinsin mi?')) { await DB.clearAll(); renderHistory(); } });
(() => {
  const sh = $('#hvSheet'); let y0 = null;
  sh.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', e => { const dy = e.changedTouches[0].clientY - y0; sh.style.transition = ''; sh.style.transform = ''; y0 = null; if (dy > 90) closeHV(); });
})();

// ---------------- kolaj ----------------
const col = { items: [] };
function pickCollage() { $('#colIn').click(); }
$('#colIn').addEventListener('change', async e => {
  const files = [...e.target.files].slice(0, 6); e.target.value = ''; if (!files.length) return;
  const items = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const { img } = await decodeFile(files[i]);
      const sm = smallImg(img, 1600);
      const cut = await withProc('Kolaj hazırlanıyor (' + (i + 1) + '/' + files.length + ')', sm, () => runJob('segment', { img: pack(sm) }));
      const b = lastInfo.box || { x: 0, y: 0, w: sm.w, h: sm.h };
      const c = imgCanvas(cut), cc = document.createElement('canvas'); cc.width = b.w; cc.height = b.h;
      cc.getContext('2d').drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h); items.push(cc);
      if (!i) setBase(sm);
    }
  } catch (err) { toast(err.cancelled ? 'Durduruldu' : 'Hata: ' + err.message, 5000); if (!items.length) return; }
  col.items = items;
  if (st.tool !== 'collage') {
    st.tool = 'collage'; st.mode = 'collage';
    $('#toolTitle').textContent = 'Kolaj'; $('#runTxt').textContent = 'Kaydet';
    $$('.panel').forEach(p => p.classList.toggle('on', p.dataset.p === 'collage'));
    $('#resultBar').hidden = true; $('#runBtn').hidden = false; $('#undoBtn').hidden = true; $('#cwrap').classList.remove('circle');
    openScreen('toolScreen'); await raf();
    $$('#toolPanel .seg').forEach(s => s._ctl && s._ctl.set(S[s.dataset.opt], false));
  }
  renderCollage();
});
$('#colAdd').addEventListener('click', () => { haptic(); pickCollage(); });
$('#colTitle').addEventListener('input', () => renderCollage());
buildColorSw($('#colColors'), c => { S.colBg = c; saveS(); renderCollage(); });
function fitIn(ctx, c, x, y, w, h, pad = 0.08, rot = 0) {
  const k = Math.min(w * (1 - pad * 2) / c.width, h * (1 - pad * 2) / c.height), dw = c.width * k, dh = c.height * k;
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(rot); ctx.drawImage(c, -dw / 2, -dh / 2, dw, dh); ctx.restore();
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawCollage(cv) {
  const W = 1080, H = 1350; cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), it = col.items, bg = S.colBg || '#f3efe7';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const [r, g, b] = F.hexRgb(bg), dark = (r * 0.299 + g * 0.587 + b * 0.114) < 120;
  const ink = dark ? '#ffffff' : '#141414', title = $('#colTitle').value || '';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const font = (sz, w = 850) => `${w} ${sz}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
  if (S.colT === 'sticker') {
    ctx.font = font(96, 900); ctx.fillStyle = ink; ctx.save(); ctx.translate(W / 2, 130); ctx.rotate(-0.03); ctx.fillText(title, 0, 0); ctx.restore();
    const slots = [[60, 230, 520, 520, -0.08], [520, 260, 500, 500, 0.07], [80, 720, 480, 520, 0.05], [540, 760, 480, 480, -0.06], [300, 500, 480, 480, 0.02], [320, 980, 440, 340, -0.04]];
    it.forEach((c, i) => {
      const s = slots[i % slots.length];
      // beyaz kenarlı etiket: gölgeyle kontur taklidi
      ctx.save(); ctx.shadowColor = '#fff'; ctx.shadowBlur = 0;
      for (const [dx, dy] of [[-7, 0], [7, 0], [0, -7], [0, 7], [-5, -5], [5, 5], [-5, 5], [5, -5]]) { ctx.shadowOffsetX = dx; ctx.shadowOffsetY = dy; fitIn(ctx, c, s[0], s[1], s[2], s[3], 0.06, s[4]); }
      ctx.restore();
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 10; fitIn(ctx, c, s[0], s[1], s[2], s[3], 0.06, s[4]); ctx.restore();
    });
    return cv;
  }
  ctx.font = font(78); ctx.fillStyle = ink; ctx.fillText(title, W / 2, 105);
  ctx.fillStyle = ink; ctx.globalAlpha = 0.25; ctx.fillRect(W / 2 - 60, 160, 120, 4); ctx.globalAlpha = 1;
  const cells = S.colT === 'hero'
    ? [[60, 210, 960, 640], [60, 880, 465, 420], [555, 880, 465, 420]]
    : [[60, 210, 465, 525], [555, 210, 465, 525], [60, 765, 465, 525], [555, 765, 465, 525]];
  cells.forEach((cl, i) => {
    const c = it[i % it.length]; if (!c) return;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.12)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    rrect(ctx, cl[0], cl[1], cl[2], cl[3], 28); ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : '#ffffff'; ctx.fill(); ctx.restore();
    ctx.save(); rrect(ctx, cl[0], cl[1], cl[2], cl[3], 28); ctx.clip(); fitIn(ctx, c, cl[0], cl[1], cl[2], cl[3], 0.07); ctx.restore();
  });
  return cv;
}
function renderCollage() {
  if (st.tool !== 'collage' || !col.items.length) return;
  drawCollage($('#cAfter')); $('#cBefore').width = 1; $('#cwrap').classList.add('single'); $('#cwrap').classList.remove('checker');
  layoutStage(); setDims('1080×1350');
}
async function exportCollage() {
  if (!col.items.length) return pickCollage();
  const c = drawCollage(document.createElement('canvas'));
  const blob = await canvasBlob(c, false, 0.94), thumb = await thumbOf(c, false);
  DB.addItem({ blob, thumb, w: c.width, h: c.height, label: 'kolaj' }).catch(() => {});
  const ok = await shareBlobs([{ blob, name: fname(blob, 'kolaj') }]);
  toast(ok ? 'Kaydedildi' : 'İçerik\'e kaydedildi');
}

// ---------------- yarım kalan işler ----------------
let resumeJob = null;
async function checkResume() {
  try {
    const list = (await DB.jobGet()) || [];
    const j = list.sort((a, b) => b.created - a.created)[0];
    for (const o of list.slice(1)) DB.jobDel(o.id).catch(() => {});
    if (!j || !j.input) return;
    if (Date.now() - j.created > 3 * 864e5) { DB.jobDel(j.id); return; }
    resumeJob = j;
    const tiles = await DB.tilesGet(j.id);
    j.tiles = new Map(tiles);
    $('#resumeTxt').textContent = (TOOLS[j.tool]?.t || 'İşlem') + ' · ' + j.w + '×' + j.h + (j.plan ? ' · %' + Math.round(100 * tiles.length / Math.max(1, Math.ceil(j.plan.iw / 256) * Math.ceil(j.plan.ih / 256))) + ' tamam' : '');
    $('#resumeBox').hidden = false;
  } catch {}
}
$('#resumeDel').addEventListener('click', () => { haptic(); if (resumeJob) DB.jobDel(resumeJob.id); resumeJob = null; $('#resumeBox').hidden = true; });
$('#resumeBtn').addEventListener('click', async () => {
  haptic(); const j = resumeJob; if (!j) return; $('#resumeBox').hidden = true;
  const img = { w: j.w, h: j.h, data: new Uint8ClampedArray(j.input) };
  setBase(img); st.tool = j.tool;
  await openTool(j.tool);
  try {
    let out;
    await withProc(TOOLS[j.tool].t, img, async () => { out = await runTracked(j.cmd, img, j.args, j); });
    st.result = out; st.resultTag = j.tool; showCompare(img, out, true); setDims(img.w + '×' + img.h + ' → ' + out.w + '×' + out.h);
    $('#runBtn').hidden = true; $('#resultBar').hidden = false; toast('Tamamlandı');
  } catch (err) { toast(err.cancelled ? 'Durduruldu' : 'Hata: ' + err.message, 5000); }
  resumeJob = null;
});

// ---------------- açılış ----------------
applyTheme();
requestAnimationFrame(placeTabPill);
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
setTimeout(() => $('#splash').classList.add('out'), 700);
setTimeout(() => $('#splash').remove(), 1400);
setTimeout(() => ensureEngine().catch(() => {}), 900);
checkResume();
window.__netlik = { st, S, openTool, startTool, setBase, runJob, ensureEngine, AI };
