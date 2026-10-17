// Разбор страниц PDF «слова + рассказ» и нарезка mp3 по паузам.
// Чистые функции без DOM: работают и в браузере, и в Node (для проверки).
(function (root) {
  // ---------- строки страницы из элементов pdf.js ----------
  // items: [{str, x, y}] → [{t: строка, y}] сверху вниз
  function groupLines(items) {
    // Лигатуры fi/fl/ffi pdf.js отдаёт отдельными кусками: склеиваем по расстоянию, а не по пробелу.
    const it = items.filter(i => i.str && i.str !== "");
    it.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const i of it) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - i.y) < 3) last.parts.push(i);
      else lines.push({ y: i.y, parts: [i] });
    }
    return lines.map(l => {
      l.parts.sort((a, b) => a.x - b.x);
      let t = "", prev = null;
      for (const p of l.parts) {
        if (prev) {
          const h = p.h || prev.h || 10, gap = p.x - (prev.x + (prev.w || 0));
          if (gap > 0.18 * h && !/\s$/.test(t) && !/^\s/.test(p.str)) t += " ";
        }
        t += p.str; prev = p;
      }
      return { t: t.replace(/\s+/g, " ").trim(), y: l.y };
    }).filter(l => l.t);
  }

  const HEAD = /^UNIT\s+(\d+)\s*\(\s*Word List\s*,\s*words\s*(\d+)\s*[–—-]\s*(\d+)\s*\)/i;
  const ENTRY = /^(.{1,40}?)\s*\[([^\]]*)\]\s*(.*)$/;

  // ---------- страница со словами ----------
  // lines: [{t}] → {unit, from, to, entries:[{w,ipa,pos,d,x}]} или null, если это не страница слов
  function parseWordPage(lines) {
    if (!lines.length) return null;
    const m = lines[0].t.match(HEAD);
    if (!m) return null;
    const entries = [];
    let cur = null, part = "d";
    for (const l of lines.slice(1)) {
      const e = !l.t.startsWith("→") && ENTRY.exec(l.t);
      if (e && e[1].trim().split(/\s+/).length <= 3) {
        cur = { w: e[1].trim(), ipa: e[2].trim(), pos: e[3].trim(), d: "", x: "" };
        entries.push(cur); part = "d"; continue;
      }
      if (!cur) continue;
      if (l.t.startsWith("→")) { part = "x"; cur.x = (cur.x + " " + l.t.replace(/^→\s*/, "")).trim(); }
      else cur[part] = (cur[part] + " " + l.t).trim();
    }
    return { unit: +m[1], from: +m[2], to: +m[3], entries };
  }

  // ---------- страница рассказа ----------
  // Абзацы отделяются пустой строкой (по увеличенному интервалу)
  function parseStoryPage(lines) {
    if (!lines.length) return null;
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const typical = sorted.length > 1 ? sorted[1] : 0;   // обычный межстрочный интервал: самый маленький
    let out = lines[0].t + "\n";
    for (let i = 1; i < lines.length; i++) {
      const g = gaps[i - 1];
      out += (i === 1 || g > typical * 1.35 ? "\n" : " ") + lines[i].t;
    }
    return { title: lines[0].t, text: out.replace(/ \n/g, "\n").trim() };
  }

  // ---------- весь том ----------
  // pages: [[{t,y}]] по порядку страниц → {units:{n:{words,entries,story,issues}}, issues:[...]}
  function buildUnits(pages) {
    const units = {}, issues = [];
    for (let i = 0; i < pages.length; i++) {
      const wp = parseWordPage(pages[i]);
      if (!wp) continue;
      const u = units[wp.unit] || (units[wp.unit] = { entries: [], pages: [], issues: [] });
      u.pages.push(i + 1);
      if (wp.entries.length !== wp.to - wp.from + 1)
        u.issues.push(`стр. ${i + 1}: найдено слов ${wp.entries.length}, ожидалось ${wp.to - wp.from + 1}`);
      u.entries.push(...wp.entries);
      // рассказ — страница сразу после второй страницы слов
      if (wp.from === 11) {
        const nx = pages[i + 1], sp = nx && !HEAD.test((nx[0] || {}).t || "") ? parseStoryPage(nx) : null;
        if (sp) { u.story = sp; u.storyPage = i + 2; }
        else u.issues.push(`после стр. ${i + 1} не найден рассказ`);
      }
    }
    Object.keys(units).forEach(k => {
      const u = units[k];
      u.words = u.entries.map(e => e.w);
      if (u.entries.length !== 20) u.issues.push(`слов ${u.entries.length}, ожидалось 20`);
      u.entries.forEach(e => {
        if (!e.d) u.issues.push(`«${e.w}»: нет определения`);
        if (!e.x) u.issues.push(`«${e.w}»: нет примера`);
        if (!e.pos) u.issues.push(`«${e.w}»: нет части речи`);
        const stem = e.w.toLowerCase().replace(/[^a-z]/g, "");
        const st = stem.slice(0, Math.max(3, stem.length - 2));
        if (e.x && !(e.d + " " + e.x).toLowerCase().includes(st)) u.issues.push(`«${e.w}»: слова нет в определении и примере`);
        if (/[^\x20-\x7E’‘“”–—…°é]/.test(e.d + e.x)) u.issues.push(`«${e.w}»: странные символы в тексте`);
      });
      if (!u.story) u.issues.push("нет рассказа");
      u.issues.forEach(s => issues.push(`юнит ${k}: ${s}`));
    });
    return { units, issues };
  }

  // ---------- аудио ----------
  // pcm: Float32Array моно, sr: частота. Возвращает паузы-сегменты речи [[s,e],...] в секундах.
  function segmentPCM(pcm, sr, join) {
    const w = Math.round(sr * 0.02), n = Math.floor(pcm.length / w), db = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * w; j < (i + 1) * w; j++) s += pcm[j] * pcm[j];
      db[i] = 20 * Math.log10(Math.sqrt(s / w) + 1e-9);
    }
    const srt = Array.from(db).sort((a, b) => a - b);
    const ref = srt[Math.floor(srt.length * 0.98)];
    const thr = Math.min(-30, Math.max(-50, ref - 30));   // порог от громкости записи
    const segs = []; let s = null;
    for (let i = 0; i < n; i++) {
      const on = db[i] > thr, t = i * 0.02;
      if (on && s === null) s = t;
      if (!on && s !== null) { segs.push([s, t]); s = null; }
    }
    if (s !== null) segs.push([s, n * 0.02]);
    const out = [];
    for (const x of segs) {
      if (out.length && x[0] - out[out.length - 1][1] < join) out[out.length - 1][1] = x[1];
      else out.push([x[0], x[1]]);
    }
    return out.filter(x => x[1] - x[0] >= 0.15);
  }
  const r2 = x => Math.round(x * 100) / 100;

  // Слова: паузы внутри блока < 0.8 с склеиваем. Между словами пауза ~2.2 с, внутри слова ~1.1 с.
  // Берём последние N-1 «длинных» пауз как границы слов; вступление остаётся в первой группе и отбрасывается.
  // Если в блоке лишний разрыв (длинный пример с паузой), его склеиваем по самой большой паузе.
  function wordClips(pcm, sr, nWords) {
    const segs = segmentPCM(pcm, sr, 0.8);
    if (segs.length < 3 * nWords) return { clips: null, warn: `пауз ${segs.length}, нужно не меньше ${3 * nWords}` };
    const bnd = [];
    for (let i = 0; i + 1 < segs.length; i++) if (segs[i + 1][0] - segs[i][1] >= 1.6) bnd.push(i);
    if (bnd.length < nWords - 1) {
      // Запасной путь: у какой-то пары слов пауза короче 1.6 с. Если сегментов хватает и все найденные
      // границы стоят на краях «троек» (слово, определение, пример), режем хвост ровно по три сегмента.
      const tail = segs.slice(segs.length - 3 * nWords), off = segs.length - 3 * nWords;
      const okTriples = bnd.every(i => i >= off && (i - off + 1) % 3 === 0);
      if (!okTriples) return { clips: null, warn: `границ между словами ${bnd.length}, нужно ${nWords - 1}` };
      const clips = [];
      for (let g = 0; g < nWords; g++) {
        const [w, d, x] = tail.slice(g * 3, g * 3 + 3);
        clips.push([r2(w[0]), r2(w[1]), "w"], [r2(d[0]), r2(d[1]), "d"], [r2(x[0]), r2(x[1]), "x"]);
      }
      return { clips, warn: `границы по тройкам: короткая пауза между словами (найдено ${bnd.length} из ${nWords - 1})` };
    }
    const cut = bnd.slice(bnd.length - (nWords - 1));        // индексы сегментов, после которых начинается новое слово
    const groups = [], first = cut[0];
    let from = 0;
    // первая группа: всё от начала до первой границы (там вступление + слово 1)
    groups.push(segs.slice(from, first + 1)); from = first + 1;
    for (let k = 1; k < cut.length; k++) { groups.push(segs.slice(from, cut[k] + 1)); from = cut[k] + 1; }
    groups.push(segs.slice(from));
    // первая группа содержит вступление: оставляем последние слово+определение+пример
    const clips = [], notes = [];
    let intro = 0;
    for (let g = 0; g < groups.length; g++) {
      let gr = groups[g];
      if (g === 0) {
        // длинное вступление могло дать группу > 3; если разрыв в самом блоке слова, берём последние 3
        intro = Math.max(0, gr.length - 3); gr = gr.slice(intro);
      }
      if (gr.length < 3) return { clips: null, warn: `у слова №${g + 1} найдено ${gr.length} фрагментов вместо 3` };
      let w = gr[0], rest = gr.slice(1), d, x;
      if (rest.length === 2) { d = rest[0]; x = rest[1]; }
      else {
        let bi = 0, bg = -1;
        for (let i = 0; i + 1 < rest.length; i++) { const gp = rest[i + 1][0] - rest[i][1]; if (gp > bg) { bg = gp; bi = i; } }
        d = [rest[0][0], rest[bi][1]]; x = [rest[bi + 1][0], rest[rest.length - 1][1]];
        notes.push(g + 1);
      }
      clips.push([r2(w[0]), r2(w[1]), "w"], [r2(d[0]), r2(d[1]), "d"], [r2(x[0]), r2(x[1]), "x"]);
    }
    const longW = clips.filter(c => c[2] === "w" && c[1] - c[0] > 2.2).length;
    let warn = "";
    if (notes.length) warn = `склеены разрывы у слов №${notes.join(",")}`;
    if (longW) warn += (warn ? "; " : "") + `слишком длинное слово (${longW})`;
    if (intro > 4) warn += (warn ? "; " : "") + `вступление из ${intro} сегментов (ожидалось ~3)`;
    return { clips, warn };
  }

  // Рассказ: фразы по паузам, пропускаем всё до start секунд
  function storyClips(pcm, sr, start) {
    const st = start == null ? 1.0 : start;
    const segs = segmentPCM(pcm, sr, 0.45).filter(x => x[1] > st + 0.3);   // по концу: заголовок мог начаться раньше
    return { clips: segs.map(x => [r2(Math.max(x[0], st)), r2(x[1])]), warn: segs.length ? "" : "речь не найдена" };
  }

  const api = { groupLines, parseWordPage, parseStoryPage, buildUnits, segmentPCM, wordClips, storyClips };
  if (typeof module !== "undefined") module.exports = api; else root.Ingest = api;
})(typeof window !== "undefined" ? window : globalThis);
