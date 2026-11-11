# Netlik – Yapay zekâ foto stüdyosu (tarayıcıda)

https://gokhangeo.github.io/upscale/

Tamamen tarayıcıda çalışan, Türkçe, mobil öncelikli foto düzenleyici (onnxruntime-web: WebGPU, yoksa çok çekirdekli WASM).

- **Görsel İyileştirici**: tek dokunuşla ışık/renk, kroma gürültü temizleme, GPEN yüz iyileştirme (detay korumalı), netlik. İsteğe bağlı 2× detay (Real-ESRGAN).
- **YZ büyütme** 2×/4× (Real-ESRGAN v3 / x4plus) – karo karo kaydedilir, iOS sayfayı kapatsa da kaldığı yerden devam eder.
- **Yüz iyileştir**: yalnızca yüzler (GPEN / CodeFormer), anlık güç kaydırıcısı.
- **Arka planı kaldır / değiştir**: ORMBG (ISNet, Apache-2.0) + guided filter kenar iyileştirme, leke temizliği, renk uyumu, hazır sahneler, kendi fotoğrafın, metin, gölge.
- **Profil resmi** (1080×1080, daire/kare), **Tekrar boyutlandır** (sosyal medya ölçüleri, bulanık/uzat/renk dolgu), **Klasik efektler**, **Renk**, **Toplu**.
- **AI Stüdyo** (isteğe bağlı): Google Gemini görüntü düzenleme, kullanıcının kendi API anahtarıyla (yalnızca cihazda saklanır, repoda anahtar yok).

`sw.js`, GitHub Pages'te COOP/COEP başlıklarını ekleyerek çok çekirdekli WASM'ı açar.
