// Katmanlı tuval: arka plan + özne (kesik ya da fotoğraf) + gölge + metin. Önizleme ve dışa aktarma aynı kodla.
export class Composer {
  constructor() {
    this.W = 1080; this.H = 1080;
    this.fg = null;           // canvas (kesik RGBA ya da fotoğraf)
    this.fgDraw = null;       // renk uyumlu sürüm (varsa)
    this.fgBox = null;        // öznenin fg içindeki kutusu {x,y,w,h}
    this.t = { s: 1, x: 540, y: 540 };
    this.bg = { type: 'none' };
    this.shadow = { on: false, soft: 0.55, dark: 0.45 };
    this.texts = [];
    this.sel = -1;
    this.showOriginal = false;
    this.original = null;     // canvas: orijinal foto (fg ile aynı koordinatlarda)
  }
  fitContain(margin = 1) { const s = Math.min(this.W / this.fg.width, this.H / this.fg.height) * margin; this.t = { s, x: this.W / 2, y: this.H / 2 }; }
  fitCover() { const s = Math.max(this.W / this.fg.width, this.H / this.fg.height); this.t = { s, x: this.W / 2, y: this.H / 2 }; }
  fgRect(k = 1) {
    const { s, x, y } = this.t, w = this.fg.width * s, h = this.fg.height * s;
    return [(x - w / 2) * k, (y - h / 2) * k, w * k, h * k];
  }
  drawCover(ctx, src, k, blurPx = 0) {
    const W = this.W * k, H = this.H * k, s = Math.max(W / src.width, H / src.height);
    const w = src.width * s, h = src.height * s;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }
  drawBg(ctx, k) {
    const W = this.W * k, H = this.H * k, b = this.bg;
    if (b.type === 'color') { ctx.fillStyle = b.c; ctx.fillRect(0, 0, W, H); }
    else if (b.type === 'grad') {
      let g;
      if (b.radial) { g = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.75); }
      else { const t = (b.angle ?? 160) * Math.PI / 180, dx = Math.sin(t), dy = -Math.cos(t), L = (Math.abs(dx) * W + Math.abs(dy) * H) / 2; g = ctx.createLinearGradient(W / 2 - dx * L, H / 2 - dy * L, W / 2 + dx * L, H / 2 + dy * L); }
      g.addColorStop(0, b.a); g.addColorStop(1, b.b); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    else if (b.type === 'img' && b.img) this.drawCover(ctx, b.img, k);
    else if (b.type === 'blur' && b.img) {
      // bulanık arka plan: önce kaplayan, sonra özneyle hizalı
      this.drawCover(ctx, b.img, k);
      if (b.aligned) { const r = this.fgRect(k); ctx.drawImage(b.img, r[0], r[1], r[2], r[3]); }
    }
    else if (b.type === 'extend' && b.img) {
      ctx.imageSmoothingQuality = 'high';
      this.drawCover(ctx, b.img, k);
    }
  }
  render(canvas, k = 1, opts = {}) {
    const W = Math.round(this.W * k), H = Math.round(this.H * k);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (this.showOriginal && this.original) {
      const r = this.fgRect(k); ctx.drawImage(this.original, r[0], r[1], r[2], r[3]); return canvas;
    }
    this.drawBg(ctx, k);
    if (!this.fg) return canvas;
    const r = this.fgRect(k), src = this.fgDraw || this.fg;
    if (this.shadow.on) {
      // zemin gölgesi (elips) + yumuşak düşen gölge
      const box = this.fgBox || { x: 0, y: 0, w: this.fg.width, h: this.fg.height };
      const s = this.t.s * k, bx = r[0] + box.x * s, by = r[1] + (box.y + box.h) * s, bw = box.w * s;
      if (by < H * 0.985) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        g.addColorStop(0, `rgba(0,0,0,${0.55 * this.shadow.dark + 0.1})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.translate(bx + bw / 2, by - bw * 0.01); ctx.scale(bw * 0.62, bw * 0.08 * (0.6 + this.shadow.soft)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${0.15 + 0.6 * this.shadow.dark})`;
      ctx.shadowBlur = Math.max(2, (4 + this.shadow.soft * 60) * k * this.W / 1080);
      ctx.shadowOffsetY = (6 + this.shadow.soft * 14) * k * this.W / 1080;
      ctx.drawImage(src, r[0], r[1], r[2], r[3]);
      ctx.restore();
    }
    ctx.drawImage(src, r[0], r[1], r[2], r[3]);
    this.texts.forEach((t, i) => {
      const fs = t.size * this.W * k;
      ctx.save();
      ctx.font = `800 ${fs}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = fs * 0.15; ctx.shadowOffsetY = fs * 0.04;
      ctx.fillStyle = t.color; ctx.fillText(t.t, t.x * W, t.y * H);
      if (opts.ui && i === this.sel) {
        const m = ctx.measureText(t.t); ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(139,92,246,.95)'; ctx.lineWidth = Math.max(1.5, 2 * k); ctx.setLineDash([6 * k, 4 * k]);
        ctx.strokeRect(t.x * W - m.width / 2 - fs * 0.2, t.y * H - fs * 0.65, m.width + fs * 0.4, fs * 1.3);
      }
      ctx.restore();
    });
    return canvas;
  }
  hitText(px, py) {
    const c = document.createElement('canvas').getContext('2d');
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i], fs = t.size * this.W;
      c.font = `800 ${fs}px -apple-system, sans-serif`;
      const w = c.measureText(t.t).width;
      if (Math.abs(px - t.x * this.W) < w / 2 + fs * 0.3 && Math.abs(py - t.y * this.H) < fs * 0.8) return i;
    }
    return -1;
  }
}

// Boyut ön ayarları
export const SIZES = [
  { g: 'Standart', id: 'custom', n: 'Özel boyut', w: 0, h: 0 },
  { g: 'Standart', id: 'subject', n: 'Özne boyutu', w: 0, h: 0, sub: 'Özneye sıkıca kırp' },
  { g: 'Standart', id: 'land', n: 'Manzara', w: 2016, h: 1512 },
  { g: 'Standart', id: 'port', n: 'Portre', w: 1512, h: 2016 },
  { g: 'Standart', id: 'square', n: 'Kare', w: 1512, h: 1512 },
  { g: 'Sosyal medya', id: 'igstory', n: 'Instagram hikâyesi', w: 1080, h: 1920 },
  { g: 'Sosyal medya', id: 'igpost', n: 'Instagram gönderisi', w: 1080, h: 1080 },
  { g: 'Sosyal medya', id: 'igport', n: 'Instagram portre', w: 1080, h: 1350 },
  { g: 'Sosyal medya', id: 'fbpost', n: 'Facebook gönderisi', w: 1200, h: 630 },
  { g: 'Sosyal medya', id: 'fbcover', n: 'Facebook kapak', w: 1640, h: 624 },
  { g: 'Sosyal medya', id: 'ytthumb', n: 'YouTube kapak', w: 1280, h: 720 },
  { g: 'Sosyal medya', id: 'tiktok', n: 'TikTok', w: 1080, h: 1920 },
  { g: 'Sosyal medya', id: 'wa', n: 'WhatsApp profil', w: 640, h: 640 },
  { g: 'Sosyal medya', id: 'wastatus', n: 'WhatsApp durum', w: 1080, h: 1920 },
  { g: 'Sosyal medya', id: 'liprofile', n: 'LinkedIn profil', w: 400, h: 400 },
  { g: 'Sosyal medya', id: 'licover', n: 'LinkedIn kapak', w: 1584, h: 396 },
  { g: 'Sosyal medya', id: 'xpost', n: 'X (Twitter) gönderi', w: 1600, h: 900 },
  { g: 'Belge', id: 'biometric', n: 'Vesikalık / biyometrik', w: 600, h: 720, sub: '50×60 mm' },
  { g: 'Belge', id: 'passport', n: 'Pasaport (TR)', w: 591, h: 709, sub: '50×60 mm, 300 dpi' },
  { g: 'Belge', id: 'a4', n: 'A4 (300 dpi)', w: 2480, h: 3508 },
];
export function ratioLabel(w, h) {
  const g = (a, b) => b ? g(b, a % b) : a, d = g(w, h);
  let a = w / d, b = h / d;
  if (a > 30 || b > 30) { const r = w / h; const c = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16], [4, 5], [5, 4], [3, 2], [2, 3], [1.91, 1], [4, 1], [5, 6]]; let best = c[0]; for (const x of c) if (Math.abs(x[0] / x[1] - r) < Math.abs(best[0] / best[1] - r)) best = x; return best[0] + ':' + best[1]; }
  return a + ':' + b;
}
