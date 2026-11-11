// Geçmiş: IndexedDB'de son sonuçlar
const DB = 'bulut-gecmis', ST = 'sonuclar', MAX = 30;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(ST, mode), s = t.objectStore(ST);
    let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
// Safari bazı sürümlerde Blob saklamada sorun çıkarabildiği için ArrayBuffer olarak saklıyoruz
export async function addItem(item) {
  const rec = { ...item, ts: Date.now(), blob: await item.blob.arrayBuffer(), type: item.blob.type, thumb: await item.thumb.arrayBuffer() };
  const id = await tx('readwrite', s => s.add(rec));
  const all = await listItems(true);
  for (const old of all.slice(MAX)) await delItem(old.id);
  return id;
}
export async function listItems(raw) {
  const all = (await tx('readonly', s => s.getAll())) || [];
  all.sort((a, b) => b.ts - a.ts);
  if (raw) return all;
  return all.map(r => ({ ...r, blob: new Blob([r.blob], { type: r.type }), thumb: new Blob([r.thumb], { type: 'image/jpeg' }) }));
}
export const delItem = id => tx('readwrite', s => s.delete(id));
export const clearAll = () => tx('readwrite', s => s.clear());
