import { createEngine } from './engine.js';
import { MODELS } from './handler.js';
import * as C from './core.js';
import * as DB from './db.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const MAX_OUT = 16e6;          // iOS tuval sınırı ~16.7 MP
const MAX_LOAD = 16e6;         // yüklenen foto üst sınırı

// ---------------- ayarlar ----------------
const S = Object.assign({
  model: 'fast', scale: '2', faceOn: false, faceModel: 'gpen', faceS: 40,
  bgMode: 'blur', bgAmount: 60, bModel: 'fast', bScale: '2', bFace: false, bColor: false, theme: 'sistem',
}, JSON.parse(localStorage.getItem('netlik-ayar') || '{}'));
const saveS = () => localStorage.setItem('netlik-ayar', JSON.stringify(S));

// ---------------- mikro etkileşimler ----------------
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    $('#hapticLbl').click(); // iOS 18+: switch tıklaması dokunsal geri bildirim verir
  } catch {}
}
let toastT;
function toast(t, ms = 2800) {
  const el = $('#toast'); el.textContent = t; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms);
}
function applyTheme() {
  const d = S.theme === 'koyu' || (S.theme === 'sistem' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = d ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// segment kontrolleri
function setupSeg(seg, value, onChange) {
  const btns = [...seg.querySelectorAll('button')], pill = seg.querySelector('.seg-pill');
  const place = (anim) => {
    const b = btns.find(x => x.classList.contains('on')) || btns[0];
    if (!anim) pill.style.transition = 'none';
    pill.style.width = b.offsetWidth + 'px';
    pill.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!anim) { pill.offsetWidth; pill.style.transition = ''; }
  };
  const set = (v, anim) => { btns.forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); place(anim); };
  btns.forEach(b => b.addEventListener('click', () => { haptic(); set(b.dataset.v, true); onChange && onChange(b.dataset.v); }));
  set(value, false);
  new ResizeObserver(() => place(false)).observe(seg);
  return { set };
}
function rangeFill(r) {
  const p = (r.value - r.min) / (r.max - r.min) * 100;
  r.style.setProperty('--p', p + '%');
}

// ---------------- sekmeler ----------------
const TABS = ['studio', 'batch', 'history', 'settings'];
const TITLES = { studio: 'Stüdyo', batch: 'Toplu', history: 'Geçmiş', settings: 'Ayarlar' };
let curTab = 'studio';
function placeTabPill() {
  const b = $(`.tabbar button[data-tab="${curTab}"]`), pill = $('#tabPill');
  pill.style.width = b.offsetWidth + 'px';
  pill.style.transform = `translateX(${b.offsetLeft}px)`;
}
function go(tab) {
  if (tab === curTab) return;
  const from = TABS.indexOf(curTab), to = TABS.indexOf(tab);
  const old = $('#v-' + curTab), nu = $('#v-' + tab);
  nu.classList.remove('left'); nu.style.transition = 'none';
  nu.style.transform = `translateX(${to > from ? 24 : -24}px) scale(.985)`;
  nu.offsetWidth; nu.style.transition = ''; nu.style.transform = '';
  old.classList.remove('active'); if (to > from) old.classList.add('left'); else old.classList.remove('left');
  nu.classList.add('active');
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  curTab = tab; placeTabPill();
  $('#title').textContent = TITLES[tab];
  window.scrollTo({ top: 0 });
  if (tab === 'history') renderHistory();
  if (tab === 'settings') renderModels();
  if (tab === 'studio') requestAnimationFrame(layoutStage);
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => { haptic(); go(b.dataset.tab); }));
addEventListener('resize', () => { placeTabPill(); layoutStage(); });

// ---------------- motor ----------------
let engine = null, engineP = null;
function ensureEngine() {
  if (!engineP) engineP = createEngine().then(e => {
    engine = e;
    const chip = $('#engineChip');
    chip.classList.add(e.info.gpu ? 'gpu' : 'cpu');
    $('#engineTxt').textContent = e.info.gpu ? 'GPU' : 'CPU';
    $('#sEngine').textContent = e.info.gpu ? 'WebGPU (hızlı)' : 'WASM / CPU' + (e.info.threads > 1 ? ' ×' + e.info.threads : '');
    $('#sEngineHint').textContent = e.info.gpu
      ? 'Ekran kartı hızlandırması etkin.' + (e.info.mode === 'main' ? ' (ana iş parçacığında)' : '')
      : 'Bu tarayıcıda WebGPU yok; işlemler CPU ile yapılır ve daha yavaştır. iOS 26+ Safari ve güncel Chrome WebGPU destekler.';
    e.on(onEngineMsg);
    updateUpHint();
    return e;
  }).catch(err => {
    $('#engineTxt').textContent = 'Hata'; engineP = null;
    toast('Yapay zekâ motoru yüklenemedi: ' + err.message, 5000);
    throw err;
  });
  return engineP;
}
$('#engineChip').addEventListener('click', () => { haptic(); go('settings'); });

// ---------------- ilerleme sayfası ----------------
const prog = { t0: 0, p0: 0, active: false, stageText: '', batchItem: null };
function showProg(on) {
  $('#progScrim').classList.toggle('on', on); $('#progSheet').classList.toggle('on', on);
  prog.active = on;
  if (on) { setRing(null); $('#progStage').textContent = 'Hazırlanıyor…'; $('#progSub').innerHTML = '&nbsp;'; }
}
function setRing(p) {
  const w = $('.ring-wrap');
  if (p == null) { w.classList.add('indet'); $('#ringTxt').textContent = '…'; return; }
  w.classList.remove('indet');
  $('#ringFg').style.strokeDashoffset = String(326.7 * (1 - p));
  $('#ringTxt').textContent = Math.round(p * 100) + '%';
}
const fmtSec = s => s < 60 ? Math.ceil(s) + ' sn' : Math.floor(s / 60) + ' dk ' + (Math.ceil(s % 60)) + ' sn';
function onEngineMsg(m) {
  if (m.type === 'note') { toast(m.text, 4000); return; }
  if (m.type === 'stage') {
    prog.stageText = m.text; prog.t0 = performance.now(); prog.p0 = m.p || 0;
    if (prog.batchItem) prog.batchItem.qs.textContent = m.text;
    if (!prog.active) return;
    $('#progStage').textContent = m.text; $('#progSub').innerHTML = '&nbsp;';
    setRing(m.p == null ? null : m.p);
  }
  if (m.type === 'progress') {
    if (prog.batchItem) prog.batchItem.bar.style.width = (m.p * 100) + '%';
    if (!prog.active) return;
    setRing(m.p);
    if (m.sub) $('#progSub').textContent = m.sub;
    else {
      const el = (performance.now() - prog.t0) / 1000, dp = m.p - prog.p0;
      if (dp > 0.02 && el > 1.5) $('#progSub').textContent = 'Kalan ~' + fmtSec(el * (1 - m.p) / dp);
    }
  }
}
$('#cancelBtn').addEventListener('click', () => { haptic(); engine && engine.cancel(); $('#progStage').textContent = 'İptal ediliyor…'; });

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

// ---------------- görüntü yardımcıları ----------------
async function decodeFile(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Fotoğraf açılamadı')); i.src = URL.createObjectURL(file); });
  }
  let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, note = '';
  if (w * h > MAX_LOAD) { const k = Math.sqrt(MAX_LOAD / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); note = 'Çok büyük fotoğraf ' + w + '×' + h + ' boyutuna küçültüldü.'; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h);
  src.close && src.close(); c.width = c.height = 0;
  return { img: { w, h, data: d.data }, note };
}
function imgCanvas(img) {
  const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
  c.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return c;
}
function hasAlpha(img) { const d = img.data; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true; return false; }
async function encode(img) {
  const c = imgCanvas(img), png = hasAlpha(img);
  const blob = await new Promise(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.93));
  const t = document.createElement('canvas'), k = Math.min(1, 320 / Math.max(img.w, img.h));
  t.width = Math.round(img.w * k); t.height = Math.round(img.h * k);
  const tx = t.getContext('2d'); tx.imageSmoothingQuality = 'high';
  if (png) { for (let y = 0; y < t.height; y += 10) for (let x = 0; x < t.width; x += 10) { tx.fillStyle = ((x + y) / 10) % 2 ? '#d9d9d9' : '#ffffff'; tx.fillRect(x, y, 10, 10); } }
  tx.drawImage(c, 0, 0, t.width, t.height);
  const thumb = await new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
  c.width = c.height = 0;
  return { blob, thumb };
}
function drawDisplay(canvas, img, maxSide = 2048) {
  const k = Math.min(1, maxSide / Math.max(img.w, img.h));
  const src = imgCanvas(img);
  canvas.width = Math.round(img.w * k); canvas.height = Math.round(img.h * k);
  const x = canvas.getContext('2d'); x.clearRect(0, 0, canvas.width, canvas.height);
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.width = src.height = 0;
}
const fname = (blob, tag) => 'netlik-' + tag + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + (blob.type === 'image/png' ? '.png' : '.jpg');
async function shareBlobs(items) {
  const files = items.map(i => new File([i.blob], i.name, { type: i.blob.type }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }
  toast('İndirildi');
}

// ---------------- stüdyo ----------------
const st = { base: null, before: null, result: null, resultBlob: null, resultName: '', tool: 'up', previewImg: null };

function setDims() {
  const b = st.base; if (!b) return;
  if (st.result) $('#dims').textContent = st.before.w + '×' + st.before.h + '  →  ' + st.result.w + '×' + st.result.h;
  else $('#dims').textContent = b.w + '×' + b.h + ' px';
}
function layoutStage() {
  const stage = $('#stage'), wrap = $('#cwrap'), c = $('#cAfter');
  if (!c.width || !stage.offsetWidth) return;
  const W = stage.clientWidth - 16, H = stage.clientHeight - 16, k = Math.min(W / c.width, H / c.height);
  wrap.style.width = Math.round(c.width * k) + 'px'; wrap.style.height = Math.round(c.height * k) + 'px';
  resetZoom();
}
function showSingle(img) {
  drawDisplay($('#cAfter'), img); $('#cBefore').width = 1; $('#cwrap').classList.add('single');
  $('#cwrap').classList.toggle('checker', hasAlpha(img));
  layoutStage();
}
function showCompare(before, after, animate) {
  drawDisplay($('#cBefore'), before); drawDisplay($('#cAfter'), after);
  // önceki görüntü farklı çözünürlükte olabilir; CSS ile aynı kutuya sığar
  $('#cwrap').classList.remove('single'); $('#cwrap').classList.toggle('checker', hasAlpha(after));
  layoutStage();
  if (animate) {
    let t0 = null;
    const step = (t) => { t0 = t0 || t; const p = Math.min(1, (t - t0) / 900); const e = 1 - Math.pow(1 - p, 3); setSplit(100 - 50 * e); if (p < 1) requestAnimationFrame(step); };
    setSplit(100); requestAnimationFrame(step);
    $('#stage').classList.remove('reveal'); $('#stage').offsetWidth; $('#stage').classList.add('reveal');
  } else setSplit(50);
}
function setSplit(pct) {
  $('#cAfter').style.clipPath = `inset(0 0 0 ${pct}%)`;
  $('#divider').style.left = pct + '%';
}

async function loadBase(img, note) {
  st.base = img; st.before = null; st.result = null; st.resultBlob = null;
  $('#empty').hidden = true; $('#work').hidden = false;
  $('#resultBar').hidden = true;
  requestAnimationFrame(() => { showSingle(img); setDims(); toolSegCtl.set(st.tool, false); refreshSegs(); if (st.tool === 'color') colorPreview(); });
  updateUpHint();
  if (note) toast(note, 4000);
  ensureEngine().catch(() => {});
}
$('#pickBtn').addEventListener('click', () => { haptic(); $('#fileIn').click(); });
$('#newBtn').addEventListener('click', () => { haptic(); $('#fileIn').click(); });
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const { img, note } = await decodeFile(f); loadBase(img, note); }
  catch (err) { toast(err.message); }
});

// karşılaştırma kaydırıcısı + yakınlaştırma
const Z = { s: 1, x: 0, y: 0 };
function applyZoom() { $('#zoomer').style.transform = `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`; $('#zoomBtn').classList.toggle('on', Z.s > 1); }
function resetZoom() { Z.s = 1; Z.x = 0; Z.y = 0; applyZoom(); }
function clampPan() {
  const w = $('#cwrap').clientWidth, h = $('#cwrap').clientHeight;
  Z.x = Math.min(0, Math.max(w - w * Z.s, Z.x)); Z.y = Math.min(0, Math.max(h - h * Z.s, Z.y));
}
function zoomAt(px, py) {
  if (Z.s > 1) { resetZoom(); return; }
  Z.s = 3; Z.x = px - px * Z.s; Z.y = py - py * Z.s; clampPan(); applyZoom();
}
$('#zoomBtn').addEventListener('click', () => { haptic(); const w = $('#cwrap'); zoomAt(w.clientWidth / 2, w.clientHeight / 2); });
(() => {
  const wrap = $('#cwrap'); let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, lastTap = 0;
  wrap.addEventListener('pointerdown', e => {
    const r = wrap.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const now = Date.now();
    if (now - lastTap < 300) { haptic(); zoomAt(px, py); lastTap = 0; return; }
    lastTap = now;
    wrap.setPointerCapture(e.pointerId);
    const divX = parseFloat($('#divider').style.left || '50') / 100 * r.width;
    const single = wrap.classList.contains('single');
    if (!single && (Z.s === 1 || Math.abs(px - divX) < 30)) { mode = 'slide'; wrap.classList.add('sliding'); setSplit(Math.max(0, Math.min(100, px / r.width * 100))); }
    else if (Z.s > 1) { mode = 'pan'; sx = e.clientX; sy = e.clientY; ox = Z.x; oy = Z.y; $('#zoomer').classList.add('dragging'); }
  });
  wrap.addEventListener('pointermove', e => {
    if (!mode) return;
    const r = wrap.getBoundingClientRect();
    if (mode === 'slide') setSplit(Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)));
    else { Z.x = ox + e.clientX - sx; Z.y = oy + e.clientY - sy; clampPan(); applyZoom(); }
  });
  const end = () => { mode = null; wrap.classList.remove('sliding'); $('#zoomer').classList.remove('dragging'); };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
})();
// not: zoom sırasında kaydırıcı çizgisi yakınlaştırılmış içerikle birlikte değil, çerçeveye göre çalışır.

// araç seçimi
const RUN_TXT = { up: 'Büyüt', bg: 'Arka planı düzenle', color: 'Renkleri uygula' };
const toolSegCtl = setupSeg($('#toolSeg'), st.tool, v => {
  st.tool = v;
  $$('.panel').forEach(p => p.classList.toggle('on', p.dataset.tool === v));
  $('#runTxt').textContent = RUN_TXT[v];
  refreshSegs();
  if (v === 'color') colorPreview(); else if (st.base && !st.result) showSingle(st.base);
  else if (st.result) showCompare(st.before, st.result, false);
});
function refreshSegs() { $$('.panel.on .seg').forEach(s => s._ctl && s._ctl.set(S[s.dataset.opt], false)); }
$$('[data-opt]').forEach(seg => {
  const k = seg.dataset.opt;
  seg._ctl = setupSeg(seg, S[k], v => {
    S[k] = v; saveS();
    if (k === 'theme') applyTheme();
    if (k === 'bgMode') $('#bgAmountRow').style.display = v === 'blur' ? '' : 'none';
    updateUpHint();
  });
});
$('#bgAmountRow').style.display = S.bgMode === 'blur' ? '' : 'none';

const faceOn = $('#faceOn'), faceOpts = $('#faceOpts');
faceOn.checked = S.faceOn; faceOpts.classList.toggle('open', S.faceOn);
faceOn.addEventListener('change', () => { haptic(); S.faceOn = faceOn.checked; saveS(); faceOpts.classList.toggle('open', S.faceOn); if (S.faceOn) requestAnimationFrame(() => faceOpts.querySelector('.seg')._ctl.set(S.faceModel, false)); updateUpHint(); });
const faceS = $('#faceS'); faceS.value = S.faceS; rangeFill(faceS);
faceS.addEventListener('input', () => { S.faceS = +faceS.value; rangeFill(faceS); saveS(); });
const bgAmount = $('#bgAmount'); bgAmount.value = S.bgAmount; rangeFill(bgAmount);
bgAmount.addEventListener('input', () => { S.bgAmount = +bgAmount.value; rangeFill(bgAmount); saveS(); });

function updateUpHint() {
  const el = $('#upHint'); if (!el) return;
  const parts = []; let warn = false;
  const need = [S.model].concat(S.faceOn ? ['det', S.faceModel] : []);
  const mb = need.reduce((a, k) => a + MODELS[k].mb, 0);
  parts.push('İlk kullanımda ~' + Math.round(mb) + ' MB model indirilir (sonra çevrimdışı).');
  if (st.base) {
    const sc = +S.scale, maxIn = MAX_OUT / (sc * sc);
    let w = st.base.w, h = st.base.h;
    if (w * h > maxIn) { const k = Math.sqrt(maxIn / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); parts.push('Bellek sınırı nedeniyle önce ' + w + '×' + h + ' boyutuna küçültülecek.'); warn = true; }
    parts.unshift('Çıktı: ' + w * sc + '×' + h * sc + ' px.');
    if (engine && !engine.info.gpu && S.model === 'best') { parts.push('GPU yok: "En iyi" kalite CPU\'da çok yavaş olabilir; "Hızlı" önerilir.'); warn = true; }
  }
  if (S.faceOn && S.faceModel === 'codeformer') parts.push('CodeFormer güçlüdür ama yüzü biraz değiştirebilir; "Doğal" tarafında tut.');
  el.textContent = parts.join(' '); el.classList.toggle('warn', warn);
}

// renk önizleme
const cAuto = $('#cAuto');
const colorRanges = $$('[data-c]');
const COLOR_DEF = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sharpen: 30 };
function colorParams() {
  const p = { auto: cAuto.checked };
  colorRanges.forEach(r => { p[r.dataset.c] = +r.value / 100; });
  return p;
}
let prevRaf = 0, autoInfoCache = null;
function colorPreview() {
  if (!st.base || st.tool !== 'color') return;
  cancelAnimationFrame(prevRaf);
  prevRaf = requestAnimationFrame(() => {
    if (!st.previewImg || st.previewImg.src !== st.base) {
      const k = Math.min(1, 1024 / Math.max(st.base.w, st.base.h));
      st.previewImg = { src: st.base, img: C.resize(st.base, st.base.w * k, st.base.h * k) };
      autoInfoCache = C.analyzeAuto(st.previewImg.img);
    }
    const p = colorParams();
    const pi = st.previewImg.img;
    const out = C.enhance(pi, p, autoInfoCache);
    drawDisplay($('#cBefore'), pi); drawDisplay($('#cAfter'), out);
    $('#cwrap').classList.remove('single', 'checker'); layoutStage();
    if (parseFloat($('#divider').style.left || '50') > 99) setSplit(50);
  });
}
colorRanges.forEach(r => {
  rangeFill(r);
  r.addEventListener('input', () => { rangeFill(r); $('#o_' + r.dataset.c).textContent = r.value; colorPreview(); });
});
cAuto.addEventListener('change', () => { haptic(); colorPreview(); });
$('#colorReset').addEventListener('click', () => {
  haptic(); colorRanges.forEach(r => { r.value = COLOR_DEF[r.dataset.c] * 1; $('#o_' + r.dataset.c).textContent = r.value; rangeFill(r); }); cAuto.checked = true; colorPreview();
});

// çalıştır
let busy = false, lastInfo = {};
function upArgs(img, o) {
  return {
    img: { w: img.w, h: img.h, buffer: img.data.slice().buffer }, model: o.model, scale: +o.scale, maxOutPixels: MAX_OUT,
    face: o.face ? { model: S.faceModel, s: S.faceS / 100 } : null,
  };
}
async function runJob(cmd, args) {
  const e = await ensureEngine();
  const r = await e.run(cmd, args, [args.img.buffer]);
  lastInfo = r.info || {};
  return { w: r.img.w, h: r.img.h, data: new Uint8ClampedArray(r.img.buffer) };
}
$('#runBtn').addEventListener('click', async () => {
  if (busy || !st.base) return;
  haptic(); busy = true; showProg(true); keepAwake(true);
  const t0 = performance.now();
  try {
    let out, tag;
    const base = st.base;
    if (st.tool === 'up') {
      out = await runJob('upscale', upArgs(base, { model: S.model, scale: S.scale, face: S.faceOn }));
      tag = S.scale + 'x' + (S.faceOn ? '-yuz' : '');
    } else if (st.tool === 'bg') {
      out = await runJob('background', { img: { w: base.w, h: base.h, buffer: base.data.slice().buffer }, mode: S.bgMode, amount: S.bgAmount / 100 });
      tag = S.bgMode === 'remove' ? 'arkaplansiz' : 'portre';
    } else {
      out = await runJob('enhance', { img: { w: base.w, h: base.h, buffer: base.data.slice().buffer }, params: colorParams() });
      tag = 'renk';
    }
    $('#progStage').textContent = 'Kaydediliyor…'; setRing(1);
    const { blob, thumb } = await encode(out);
    st.before = base; st.result = out; st.resultBlob = blob; st.resultName = fname(blob, tag);
    DB.addItem({ blob, thumb, w: out.w, h: out.h, label: tag }).catch(() => {});
    showProg(false); haptic();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showCompare(base, out, true); setDims();
    $('#resultBar').hidden = false;
    toast('Bitti · ' + fmtSec((performance.now() - t0) / 1000) + (st.tool === 'up' && S.faceOn ? ' · ' + (lastInfo.faces || 0) + ' yüz iyileştirildi' : ''));
  } catch (err) {
    showProg(false);
    toast(err.cancelled ? 'İptal edildi' : 'Hata: ' + err.message, 5000);
  } finally { busy = false; keepAwake(false); }
});
$('#shareBtn').addEventListener('click', () => { haptic(); if (st.resultBlob) shareBlobs([{ blob: st.resultBlob, name: st.resultName }]); });
$('#continueBtn').addEventListener('click', () => {
  haptic(); if (!st.result) return;
  const r = st.result; loadBase(r); toast('Sonuç üzerinde düzenlemeye devam ediliyor');
});

// ---------------- toplu ----------------
const bFace = $('#bFace'), bColor = $('#bColor');
bFace.checked = S.bFace; bColor.checked = S.bColor;
bFace.addEventListener('change', () => { haptic(); S.bFace = bFace.checked; saveS(); });
bColor.addEventListener('change', () => { haptic(); S.bColor = bColor.checked; saveS(); });
let bItems = [], bRunning = false;
$('#bPick').addEventListener('click', () => { haptic(); if (!bRunning) $('#bFileIn').click(); });
$('#bFileIn').addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  bItems = files.map(f => ({ file: f, status: 'wait' }));
  const q = $('#queue'); q.innerHTML = '';
  bItems.forEach((it, i) => {
    const li = document.createElement('li'); li.style.animationDelay = (i * 0.04) + 's';
    li.innerHTML = `<img alt=""><div class="qi"><div class="qn"></div><div class="qs">Sırada</div><div class="bar"><i></i></div></div>`;
    li.querySelector('img').src = URL.createObjectURL(it.file);
    li.querySelector('.qn').textContent = it.file.name || ('Foto ' + (i + 1));
    it.li = li; it.qs = li.querySelector('.qs'); it.bar = li.querySelector('.bar i');
    q.appendChild(li);
  });
  $('#bStart').disabled = false; $('#bShare').hidden = true; $('#bEmpty').hidden = true;
});
$('#bStart').addEventListener('click', async () => {
  if (bRunning) { engine && engine.cancel(); bRunning = 'stop'; $('#bStart').textContent = 'Durduruluyor…'; return; }
  haptic(); bRunning = true; $('#bStart').textContent = 'Durdur'; $('#bPick').disabled = true; keepAwake(true);
  let ok = 0;
  for (const it of bItems) {
    if (bRunning === 'stop') break;
    if (it.status === 'done') continue;
    prog.batchItem = it; it.li.classList.remove('err');
    try {
      it.qs.textContent = 'Açılıyor…';
      const { img } = await decodeFile(it.file);
      let out = await runJob('upscale', upArgs(img, { model: S.bModel, scale: S.bScale, face: S.bFace }));
      if (S.bColor) { it.qs.textContent = 'Renk…'; out = await runJob('enhance', { img: { w: out.w, h: out.h, buffer: out.data.buffer }, params: { auto: true, sharpen: 0.2 } }); }
      it.qs.textContent = 'Kaydediliyor…';
      const { blob, thumb } = await encode(out);
      it.blob = blob; it.name = fname(blob, 'toplu-' + S.bScale + 'x');
      await DB.addItem({ blob, thumb, w: out.w, h: out.h, label: 'toplu ' + S.bScale + 'x' }).catch(() => {});
      it.status = 'done'; it.li.classList.add('done'); it.bar.style.width = '100%';
      it.qs.textContent = '✓ ' + out.w + '×' + out.h; ok++;
      const btn = document.createElement('button'); btn.textContent = 'Paylaş'; btn.className = 'press';
      btn.onclick = () => { haptic(); shareBlobs([{ blob: it.blob, name: it.name }]); };
      it.li.appendChild(btn); haptic();
    } catch (err) {
      it.li.classList.add('err'); it.qs.textContent = err.cancelled ? 'İptal edildi' : 'Hata: ' + err.message;
    }
  }
  prog.batchItem = null; bRunning = false; keepAwake(false);
  $('#bStart').textContent = 'Başlat'; $('#bPick').disabled = false;
  const done = bItems.filter(i => i.status === 'done');
  $('#bShare').hidden = done.length < 1;
  toast(ok + ' fotoğraf tamamlandı');
});
$('#bShare').addEventListener('click', () => { haptic(); shareBlobs(bItems.filter(i => i.blob).map(i => ({ blob: i.blob, name: i.name }))); });

// ---------------- geçmiş ----------------
let hItems = [], hCur = null;
async function renderHistory() {
  try { hItems = await DB.listItems(); } catch { hItems = []; }
  const g = $('#hGrid'); g.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src)); g.innerHTML = '';
  hItems.forEach((it, i) => {
    const b = document.createElement('button'); b.className = 'press'; b.style.animationDelay = Math.min(i, 15) * 0.03 + 's';
    b.innerHTML = '<img alt=""><span></span>';
    b.querySelector('img').src = URL.createObjectURL(it.thumb);
    b.querySelector('span').textContent = it.label || '';
    b.onclick = () => { haptic(); openHV(it); };
    g.appendChild(b);
  });
  $('#hEmpty').hidden = hItems.length > 0; $('#hClear').hidden = hItems.length === 0;
}
function openHV(it) {
  hCur = it; const img = $('#hvImg'); if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(it.blob);
  $('#hvMeta').textContent = it.w + '×' + it.h + ' · ' + (it.blob.size / 1e6).toFixed(1) + ' MB · ' + new Date(it.ts).toLocaleString('tr-TR');
  $('#hvScrim').classList.add('on'); $('#hvSheet').classList.add('on');
}
function closeHV() { $('#hvScrim').classList.remove('on'); $('#hvSheet').classList.remove('on'); }
$('#hvScrim').addEventListener('click', closeHV);
$('#hvShare').addEventListener('click', () => { haptic(); hCur && shareBlobs([{ blob: hCur.blob, name: fname(hCur.blob, 'gecmis') }]); });
$('#hvDel').addEventListener('click', async () => { haptic(); if (!hCur) return; await DB.delItem(hCur.id); closeHV(); renderHistory(); toast('Silindi'); });
$('#hvEdit').addEventListener('click', async () => {
  haptic(); if (!hCur) return; closeHV();
  const { img } = await decodeFile(hCur.blob); go('studio'); loadBase(img);
});
$('#hClear').addEventListener('click', async () => { if (confirm('Tüm geçmiş silinsin mi?')) { await DB.clearAll(); renderHistory(); } });
// sheet'i aşağı kaydırarak kapatma
(() => {
  const sh = $('#hvSheet'); let y0 = null;
  sh.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', e => { const dy = e.changedTouches[0].clientY - y0; sh.style.transition = ''; sh.style.transform = ''; y0 = null; if (dy > 90) closeHV(); });
})();

// ---------------- ayarlar / modeller ----------------
async function renderModels() {
  const ul = $('#mList'); let status = {};
  try { const e = await ensureEngine(); status = (await e.run('status')).info; } catch {}
  ul.innerHTML = '';
  for (const k of ['fast', 'best', 'det', 'gpen', 'codeformer', 'modnet']) {
    const li = document.createElement('li'); li.className = status[k] ? 'ok' : '';
    li.innerHTML = '<i class="st"></i><span class="nm"></span><span class="mb"></span>';
    li.querySelector('.nm').textContent = MODELS[k].name;
    li.querySelector('.mb').textContent = MODELS[k].mb + ' MB';
    if (!status[k]) {
      const b = document.createElement('button'); b.textContent = 'İndir';
      b.onclick = async () => {
        haptic(); b.textContent = '…'; b.disabled = true;
        try { showProg(true); await engine.run('prefetch', { keys: k === 'gpen' || k === 'codeformer' ? [k, 'det'] : [k] }); toast('İndirildi'); }
        catch (err) { toast('İndirilemedi: ' + err.message); }
        showProg(false); renderModels();
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}
$('#mClear').addEventListener('click', async () => {
  haptic(); if (!confirm('İndirilmiş modeller silinsin mi? (Gerekince tekrar indirilir)')) return;
  try { await (await ensureEngine()).run('clear'); toast('Önbellek temizlendi'); } catch {}
  renderModels();
});

// ---------------- açılış ----------------
applyTheme();
requestAnimationFrame(placeTabPill);
updateUpHint();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
setTimeout(() => $('#splash').classList.add('out'), 900);
setTimeout(() => $('#splash').remove(), 1600);
// motoru arka planda ısıt (model indirmez)
setTimeout(() => ensureEngine().catch(() => {}), 1200);
