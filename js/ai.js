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
