# Netlik – Yapay Zekâ Foto

Tamamen tarayıcıda çalışan fotoğraf büyütme ve yüz iyileştirme uygulaması (iPhone Safari / Android Chrome). Fotoğraflar cihazdan çıkmaz.

- Büyütme: Real-ESRGAN general x4v3 (Hızlı) / Real-ESRGAN x4plus (En iyi), 2× veya 4×
- Yüz iyileştirme: SCRFD algılama + GPEN-BFR-256 (Doğal) veya CodeFormer (Güçlü; S-Lab lisansı, ticari olmayan kullanım)
- Arka plan: MODNet (bulanıklaştır / sil)
- Renk: otomatik düzeltme + parlaklık, kontrast, doygunluk, sıcaklık, netlik
- Toplu işlem, cihazda geçmiş (IndexedDB)

ONNX Runtime Web (WebGPU, yoksa WASM). Modeller Hugging Face'ten bir kez indirilip Cache API'de saklanır.
