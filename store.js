// Хранилище на устройстве (IndexedDB). Книга и аудио остаются только здесь, на сервер не уходят.
//   u:В.Н      — юнит: {words, entries:[{w,ipa,pos,d,x}], story:{title,text}, issues:[...]}
//   c:В.Н      — тайминги: {words:{clips,warn}, story:{clips,warn}}
//   a:В.Н:w|s  — mp3 целиком (Blob): слова или рассказ
window.DB = { units: {}, tracks: {} };
window.DBX = (function () {
  let db = null;
  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open("words16data", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  const tx = (mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction("kv", mode), s = t.objectStore("kv"), out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  const get = k => tx("readonly", s => s.get(k));
  const set = (k, v) => tx("readwrite", s => { s.put(v, k); });
  const del = k => tx("readwrite", s => { s.delete(k); });
  const keys = prefix => tx("readonly", s => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "\uffff")));
  const delPrefix = prefix => tx("readwrite", s => { s.delete(IDBKeyRange.bound(prefix, prefix + "\uffff")); });

  // треки приложения из тайминговых записей
  function rebuild(k) {
    const [v, n] = k.split("."), c = (window.DBC || {})[k], t = [];
    if (c && c.words && c.words.clips) t.push({ id: "words", title: "Слова", mode: "entries", file: `idb:a:${k}:w`, clips: c.words.clips });
    if (c && c.story && c.story.clips) t.push({ id: "story", title: "Рассказ", mode: "sentences", file: `idb:a:${k}:s`, clips: c.story.clips });
    if (t.length) DB.tracks[k] = t; else delete DB.tracks[k];
  }
  window.DBC = {};
  async function loadAll() {
    try {
      const uk = await keys("u:"), ck = await keys("c:");
      await Promise.all(uk.map(async k => { DB.units[k.slice(2)] = await get(k); }));
      await Promise.all(ck.map(async k => { window.DBC[k.slice(2)] = await get(k); }));
      Object.keys(window.DBC).forEach(rebuild);
    } catch (e) { console.warn("IndexedDB недоступна", e); }
  }
  async function putUnit(k, u) { DB.units[k] = u; await set("u:" + k, u); }
  async function putClips(k, kind, info) {            // kind: "words" | "story"
    const c = window.DBC[k] || (window.DBC[k] = {});
    c[kind] = info; await set("c:" + k, c); rebuild(k);
  }
  async function putAudio(k, kind, blob) { await set(`a:${k}:${kind[0]}`, blob); }
  const getAudio = key => get(key);                    // key вида "a:1.5:w"
  async function clearVolume(v) {
    await delPrefix(`u:${v}.`); await delPrefix(`c:${v}.`); await delPrefix(`a:${v}.`);
    Object.keys(DB.units).filter(k => k.startsWith(v + ".")).forEach(k => delete DB.units[k]);
    Object.keys(window.DBC).filter(k => k.startsWith(v + ".")).forEach(k => { delete window.DBC[k]; delete DB.tracks[k]; });
  }
  async function audioKeys() { return keys("a:"); }
  const persist = () => (navigator.storage && navigator.storage.persist ? navigator.storage.persist().catch(() => false) : Promise.resolve(false));
  return { loadAll, putUnit, putClips, putAudio, getAudio, clearVolume, audioKeys, persist };
})();
