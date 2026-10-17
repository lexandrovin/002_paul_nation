// Чистые функции без доступа к DOM: разбор вставленного текста и сопоставление с клипами.
// Одинаково работают для любого тома и юнита.
(function (root) {
  const ARROWS = /^[\s\-–—>►♦■*»→•·]+/;

  // ---------- предложения ----------
  // Первая «заголовочная» часть (строки без знаков конца предложения) становится отдельной фразой.
  function splitSentences(raw) {
    const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out = [];
    let i = 0, title = [];
    while (i < lines.length && i < 3 && !/[.!?"”]/.test(lines[i]) && lines[i].split(/\s+/).length <= 7) {
      title.push(lines[i]); i++;
    }
    if (title.length) out.push(title.join(" "));
    const body = lines.slice(i).join(" ").replace(/\s+/g, " ").replace(/([“‘])\s+/g, "$1");
    // конец предложения: . ! ? (+ закрывающая кавычка), дальше пробел и заглавная/кавычка
    const parts = body.match(/[^.!?]+(?:[.!?]+["”’']*|$)\s*/g) || [];
    parts.forEach(p => { p = p.trim(); if (p.split(/\s+/).filter(w => w.replace(/[^A-Za-z]/g, "").length >= 3).length >= 2) out.push(p); });
    return out;
  }

  // ---------- выравнивание предложений по паузам ----------
  // segs: [[s,e],...]  sentences: [str,...]  → [[s,e,text],...] либо null, если предложений больше пауз
  function alignSentences(segs, sentences) {
    const m = segs.length, n = sentences.length;
    if (!n || n > m) return null;
    const chars = sentences.map(t => Math.max(3, t.replace(/[^A-Za-z']/g, "").length));
    // время речи без пауз: так темп диктора почти постоянен
    const pre = [0];
    segs.forEach(x => pre.push(pre[pre.length - 1] + (x[1] - x[0])));
    const rate = pre[m] / chars.reduce((a, b) => a + b, 0);
    const gapAfter = b => (b + 1 < m ? segs[b + 1][0] - segs[b][1] : 0);
    const INF = 1e18;
    const f = Array.from({ length: n }, () => new Array(m).fill(INF));
    const from = Array.from({ length: n }, () => new Array(m).fill(-1));
    const cost = (j, a, b) => {
      const exp = chars[j] * rate, d = pre[b + 1] - pre[a] - exp;
      const r = d / (0.2 * exp + 0.4);
      return r * r - 1.5 * Math.min(gapAfter(b), 1.2);
    };
    for (let b = 0; b < m; b++) f[0][b] = cost(0, 0, b);
    for (let j = 1; j < n; j++)
      for (let b = j; b < m; b++)
        for (let a = j; a <= b; a++) {
          const v = f[j - 1][a - 1] + cost(j, a, b);
          if (v < f[j][b]) { f[j][b] = v; from[j][b] = a; }
        }
    const res = new Array(n);
    let b = m - 1;
    for (let j = n - 1; j >= 0; j--) {
      const a = j === 0 ? 0 : from[j][b];
      // [начало, конец, текст, сколько пауз склеено, во сколько раз речь длиннее ожидаемой по числу букв]
      res[j] = [segs[a][0], segs[b][1], sentences[j], b - a + 1, (pre[b + 1] - pre[a]) / (chars[j] * rate)];
      b = a - 1;
    }
    return res;
  }

  // ---------- проверка склейки ----------
  // Фраза «подозрительная», если склеено 3+ пауз или длительность сильно не вяжется с длиной текста.
  function checkStory(clips, text) {
    const sents = splitSentences(text), al = alignSentences(clips, sents);
    if (!al) return { ok: false, n: sents.length, m: clips.length, glued: 0, chk: [] };
    const chk = [];
    al.forEach((c, i) => { if (c[3] >= 3 || c[4] < 0.6 || c[4] > 1.6) chk.push(i + 1); });
    return { ok: true, n: al.length, m: clips.length, glued: clips.length - al.length, chk };
  }

  // ---------- словарные статьи (слово → определение → пример) ----------
  function headKey(line) {
    return line.toLowerCase().split(/[\[(]/)[0].replace(/[^a-z]/g, "");
  }
  function isHead(line, w) {
    const k = headKey(line);
    if (/[\[(]/.test(line)) return k === w || (k.endsWith(w) && k.length <= w.length + 2);
    // строка без транскрипции (так иногда читается PDF): короткая, слово среди первых трёх слов
    const t = line.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    return t.length <= 5 && t.slice(0, 3).includes(w);
  }
  // → [{d, x}] по порядку слов юнита
  function parseEntries(raw, words) {
    const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out = words.map(() => ({ d: "", x: "" }));
    let pos = 0;
    const heads = [];
    words.forEach((w, wi) => {
      for (let i = pos; i < lines.length; i++) {
        if (isHead(lines[i], w)) { heads.push([wi, i]); pos = i + 1; break; }
      }
    });
    heads.forEach(([wi, at], h) => {
      const end = h + 1 < heads.length ? heads[h + 1][1] : lines.length;
      const body = lines.slice(at + 1, end)
        .map(s => s.replace(ARROWS, "").trim())
        .filter(s => s.length > 8 && (s.match(/[A-Za-z]/g) || []).length / s.length > 0.7);
      out[wi].d = body[0] || "";
      out[wi].x = body.slice(1).join(" ");
    });
    return { items: out, found: heads.length };
  }

  const api = { splitSentences, alignSentences, parseEntries, checkStory };
  if (typeof module !== "undefined") module.exports = api; else root.Lib = api;
})(typeof window !== "undefined" ? window : globalThis);
