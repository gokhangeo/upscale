// AI Stüdyo: Google Gemini (Nano Banana) görüntü düzenleme, kullanıcının kendi API anahtarıyla.
// Anahtar yalnızca localStorage'da tutulur; repoda anahtar YOK.
// REST: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   body: { contents:[{role:'user', parts:[{text}, {inlineData:{mimeType,data}}]}],
//           generationConfig:{ responseModalities:['IMAGE'], imageConfig:{ aspectRatio, imageSize } } }
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
export const KEY_LS = 'netlik-gemini-key', MODEL_LS = 'netlik-gemini-model';
export const DEFAULT_MODEL = 'gemini-nano-banana-2.1';
export const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const ID = 'Keep the person\'s face, identity, facial features, skin tone, hairstyle, age, expression and body proportions exactly the same as in the input photo — the result must be clearly recognisable as the same person. Do not beautify, slim or alter the face. Photorealistic, natural result. No text, no watermark.';

export const PRESETS = [
  { id: 'product', n: 'Ürün sahnesi', sub: 'Hikâye anlatan, yaşam tarzını hareket halinde gösteren çarpıcı görseller oluştur', ex: ['img/ex_bottle.jpg', 'img/ex_bottle_scene.jpg'],
    p: 'Place this exact product into an aspirational lifestyle scene where it is being used naturally, for example held by a hiker on a misty pine forest trail at golden hour. Keep the product\'s shape, colour, material, label, logo and proportions exactly the same. Cinematic, photorealistic lifestyle product photography, shallow depth of field, natural light and shadows. No text, no watermark.' },
  { id: 'suit', n: 'Takım elbise', sub: 'Kıyafeti şık bir takım elbiseyle değiştir; yüz aynen kalsın', ex: ['img/ex_portrait.jpg', 'img/ex_suit.jpg'],
    p: 'Change only the clothing: dress the person in a well-fitted, elegant dark navy two-piece business suit with a crisp white dress shirt. Keep the background, pose, framing and lighting the same. ' + ID },
  { id: 'tie', n: 'Gömlek + kravat', sub: 'Resmî gömlek ve kravat', ex: ['img/ex_portrait.jpg', 'img/ex_suit.jpg'],
    p: 'Change only the clothing: the person wears a crisp, well-ironed light blue dress shirt with a classic dark silk tie, neatly knotted. Keep the background, pose, framing and lighting the same. ' + ID },
  { id: 'women', n: 'Resmî kadın kıyafeti', sub: 'Blazer ve bluz ile profesyonel görünüm', ex: ['img/ex_portrait.jpg', 'img/ex_suit.jpg'],
    p: 'Change only the clothing: the person wears an elegant, modest professional women\'s business outfit — a tailored blazer over a silk blouse. Keep the background, pose, framing, hair and lighting the same. ' + ID },
  { id: 'dress', n: 'Elbise', sub: 'Zarif bir elbise', ex: ['img/ex_portrait.jpg', 'img/ex_suit.jpg'],
    p: 'Change only the clothing: the person wears an elegant, tasteful dress in a flattering solid colour suitable for a special occasion. Keep the background, pose, framing, hair and lighting the same. ' + ID },
  { id: 'studio', n: 'Profesyonel profil', sub: 'Stüdyo ışığı, nötr fon, baş-omuz çekim', ex: ['img/ex_portrait.jpg', 'img/ex_suit.jpg'],
    p: 'Turn this into a professional studio headshot: soft flattering three-point studio lighting, neutral mid-grey seamless backdrop with a subtle vignette, head-and-shoulders framing, crisp focus on the eyes. Keep the same clothing. ' + ID },
  { id: 'scene', n: 'Manzara arka planı', sub: 'Arka planı doğal bir manzarayla değiştir', ex: ['img/ex_portrait.jpg', 'img/t_scene_full.jpg'],
    p: 'Replace only the background with a beautiful natural landscape — a calm mountain lake at golden hour — with realistic depth of field. Match the light direction and colour temperature on the person so it looks like a real photo taken there. Keep the person, clothing and pose exactly the same. ' + ID },
  { id: 'enhance', n: 'AI ile iyileştir', sub: 'Profesyonel fotoğraf kalitesi: ışık, netlik, renk', ex: ['img/enh_before.jpg', 'img/enh_after.jpg'],
    p: 'Enhance this photo to professional photo quality: correct the exposure and lighting, balanced natural colours and white balance, remove noise and compression artifacts, and sharpen fine details. Keep the person\'s identity, face, clothes, background and composition exactly the same; do not add, remove or move anything. ' + ID },
  { id: 'free', n: 'Serbest', sub: 'Ne istediğini kendi cümlelerinle yaz', ex: ['img/ex_portrait.jpg', 'img/t_ai.jpg'], p: '' },
];

export function nearestRatio(w, h) {
  const r = w / h; let best = RATIOS[0];
  for (const x of RATIOS) { const [a, b] = x.split(':').map(Number); const [c, d] = best.split(':').map(Number); if (Math.abs(Math.log(a / b / r)) < Math.abs(Math.log(c / d / r))) best = x; }
  return best;
}

export function buildPrompt(preset, userText, hasPerson = true) {
  let p = preset.p || '';
  if (userText && userText.trim()) p += (p ? '\n\nAdditional instructions from the user (in Turkish, follow them): ' : 'Edit the provided photo as follows (instructions in Turkish): ') + userText.trim();
  if (preset.id === 'free' && hasPerson) p += '\n\n' + ID;
  return p;
}

export function buildRequest({ prompt, b64, mime = 'image/jpeg', aspect, size, model }) {
  const imageConfig = {};
  if (aspect) imageConfig.aspectRatio = aspect;
  if (size && !/gemini-2\.5/.test(model)) imageConfig.imageSize = size;
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64 } }] }],
    generationConfig: { responseModalities: ['IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
  };
}

export async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(s);
}

export async function geminiEdit({ key, model, prompt, blob, aspect, size, signal }) {
  if (!key) throw new Error('Gemini API anahtarı yok');
  const body = buildRequest({ prompt, b64: await blobToB64(blob), mime: blob.type || 'image/jpeg', aspect, size, model });
  let r;
  try {
    r = await fetch(API + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Google\'a bağlanılamadı (internet?)');
  }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const m = (j && j.error && j.error.message) || ('HTTP ' + r.status);
    if (r.status === 400 && /API key/i.test(m)) throw new Error('API anahtarı geçersiz');
    if (r.status === 429) throw new Error('Kota/limit aşıldı – biraz sonra tekrar dene ya da faturalandırmayı aç');
    if (r.status === 404) throw new Error('Model bulunamadı (' + model + '). Ayarlar\'dan başka model seç.');
    throw new Error(m);
  }
  if (j && j.promptFeedback && j.promptFeedback.blockReason) throw new Error('İstek güvenlik filtresine takıldı (' + j.promptFeedback.blockReason + ')');
  const parts = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const im = parts.find(p => p.inlineData || p.inline_data);
  if (!im) {
    const txt = parts.map(p => p.text).filter(Boolean).join(' ');
    const fr = j && j.candidates && j.candidates[0] && j.candidates[0].finishReason;
    throw new Error('Görsel üretilemedi' + (fr ? ' (' + fr + ')' : '') + (txt ? ': ' + txt.slice(0, 160) : ''));
  }
  const d = im.inlineData || im.inline_data;
  const bin = atob(d.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: d.mimeType || d.mime_type || 'image/png' });
}

// ---------------- Pollinations (ücretsiz Quest Pollen ile) ----------------
// Anahtar: "Pollinations ile bağlan" (OAuth PKCE, Netlik App Key) ya da elle yapıştırılan sk_ anahtarı. Yalnızca bu cihazda.
export const POL_APP_KEY = 'pk_c9eoiB18vZ9w68qb';
export const POL_REDIRECT = 'https://gokhangeo.github.io/upscale/';
export const POL_KEY_LS = 'netlik-pol-key', POL_EXP_LS = 'netlik-pol-exp', POL_MODEL_LS = 'netlik-pol-model', PROV_LS = 'netlik-ai-prov';
export const POL_DEFAULT_MODEL = 'black-forest-labs/flux.1-kontext-pro';
export const POL_MODELS = [
  ['black-forest-labs/flux.1-kontext-pro', 'FLUX Kontext Pro (önerilen, ~0,03 Pollen)'],
  ['black-forest-labs/flux.2-klein-4b', 'FLUX.2 Klein (en ucuz, ~0,005 Pollen)'],
  ['microsoft/mai-image-2.6-flash', 'MAI Image 2.6 Flash'],
  ['microsoft/mai-image-2.6', 'MAI Image 2.6 (kaliteli)'],
];
const POL_API = 'https://gen.pollinations.ai/v1/images/edits';
const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function provider() {
  const p = localStorage.getItem(PROV_LS);
  if (p) return p;
  return localStorage.getItem(KEY_LS) && !localStorage.getItem(POL_KEY_LS) ? 'gemini' : 'pollinations';
}
export function polKey() {
  const k = localStorage.getItem(POL_KEY_LS), exp = +localStorage.getItem(POL_EXP_LS) || 0;
  if (k && exp && Date.now() > exp) { localStorage.removeItem(POL_KEY_LS); localStorage.removeItem(POL_EXP_LS); return null; }
  return k;
}

export async function polConnect() {
  const ver = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const chal = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ver))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  localStorage.setItem('netlik-pol-pkce', JSON.stringify({ ver, state, t: Date.now() }));
  const q = new URLSearchParams({ response_type: 'code', client_id: POL_APP_KEY, redirect_uri: POL_REDIRECT, scope: 'usage', models: 'image', budget: '10', expiry: '30', state, code_challenge: chal, code_challenge_method: 'S256' });
  location.href = 'https://enter.pollinations.ai/authorize?' + q;
}

// Uygulama açılışında: ?code=…&state=… ile dönüldüyse anahtarı al. true = bağlandı
export async function polHandleRedirect() {
  const u = new URL(location.href), code = u.searchParams.get('code'), state = u.searchParams.get('state'), err = u.searchParams.get('error');
  if (!code && !err) return null;
  history.replaceState(null, '', u.pathname);
  let pk = null; try { pk = JSON.parse(localStorage.getItem('netlik-pol-pkce') || 'null'); } catch {}
  localStorage.removeItem('netlik-pol-pkce');
  if (err) throw new Error('Pollinations izni verilmedi');
  if (!pk || pk.state !== state) throw new Error('Pollinations bağlantısı doğrulanamadı, tekrar dene');
  const r = await fetch('https://enter.pollinations.ai/api/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: POL_APP_KEY, redirect_uri: POL_REDIRECT, code_verifier: pk.ver }),
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || !j || !j.access_token) throw new Error('Pollinations anahtarı alınamadı' + (j && (j.error_description || j.error) ? ' (' + (j.error_description || j.error) + ')' : ''));
  localStorage.setItem(POL_KEY_LS, j.access_token);
  if (j.expires_in) localStorage.setItem(POL_EXP_LS, String(Date.now() + j.expires_in * 1000 - 60000)); else localStorage.removeItem(POL_EXP_LS);
  localStorage.setItem(PROV_LS, 'pollinations');
  return true;
}

export async function polBalance(key) {
  try {
    const r = await fetch('https://gen.pollinations.ai/account/balance', { headers: { Authorization: 'Bearer ' + key } });
    if (!r.ok) return null; const j = await r.json(); return typeof j.balance === 'number' ? j.balance : null;
  } catch { return null; }
}

function polSize(aspect, q) {
  const [a, b] = (aspect || '1:1').split(':').map(Number); const base = q === '1K' ? 1024 : 1536;
  const k = Math.sqrt(base * base / (a * b)); const r8 = v => Math.max(256, Math.round(v / 16) * 16);
  return r8(a * k) + 'x' + r8(b * k);
}

export async function polEdit({ key, model, prompt, blob, aspect, size, signal }) {
  if (!key) throw new Error('Pollinations bağlı değil');
  const dataUri = 'data:' + (blob.type || 'image/jpeg') + ';base64,' + await blobToB64(blob);
  let r;
  try {
    r = await fetch(POL_API, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, prompt, image: [{ image_url: dataUri }], size: polSize(aspect, size), response_format: 'b64_json' }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Pollinations\'a bağlanılamadı (internet?)');
  }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const m = (j && ((j.error && (j.error.message || j.error)) || j.message)) || ('HTTP ' + r.status);
    if (r.status === 401) throw new Error('Pollinations anahtarı geçersiz ya da süresi doldu – Ayarlar\'dan yeniden bağlan');
    if (r.status === 402) throw new Error('Pollen bakiyesi bitti – enter.pollinations.ai'de görev (Quest) tamamlayarak ücretsiz Pollen kazanabilirsin');
    if (r.status === 429) throw new Error('Çok sık istek – birkaç saniye sonra tekrar dene');
    throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 200));
  }
  const d = j && j.data && j.data[0];
  if (d && d.b64_json) {
    const bin = atob(d.b64_json), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: bin.startsWith('\x89PNG') ? 'image/png' : 'image/jpeg' });
  }
  if (d && d.url) { const ir = await fetch(d.url, { signal }); if (ir.ok) return await ir.blob(); }
  throw new Error('Görsel üretilemedi');
}
