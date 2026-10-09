/* Texte Net — résumé automatique par extraction de phrases (hors connexion).
   Français, anglais, arabe. Aucune reformulation : les phrases les plus représentatives du texte
   sont reprises telles quelles, dans leur ordre d'origine.
   Méthode : poids TF-IDF des mots, graphe de similarité entre phrases, classement de type PageRank
   (TextRank), léger bonus pour la première phrase de chaque paragraphe. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Summarizer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- mots vides ---------- */
  const SW = {
    fr: 'a à â ai aie aient aies ait as au aux avaient avais avait avec avez aviez avions avons ayant ce ceci cela celà celle celles celui ces cet cette ceux chaque ci comme comment dans de des du donc dont elle elles en encore es est et étaient était étant été etre être eu eux furent fut il ils je la là le les leur leurs lors lui ma mais me même mes moi mon ne ni nos notre nous on ont ou où par parce pas peu plus pour pourquoi qu que quel quelle quelles quels qui sa sans se sera seront ses si sinon soit son sont sous suis sur ta te tes toi ton tous tout toute toutes très tu un une vos votre vous y ainsi alors après aussi autre autres avant bien cependant ceci deux entre fait faire faut ici puis quand sous tandis toujours trop sera également selon',
    en: 'a about above after again against all am an and any are aren as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also however thus therefore may might must shall one two within without among per via often much many',
    ar: 'في من على إلى الى عن مع هذا هذه ذلك تلك هؤلاء الذي التي الذين اللذان اللتان ما ماذا متى أين كيف لماذا هل أن ان إن إنّ كان كانت يكون تكون كانوا ليس ليست لا لم لن قد لقد بين بعد قبل حتى عند عندما حيث إذا اذا إذ ثم أو او أم بل لكن غير كل بعض أي اي أيضا ايضا هو هي هم هن نحن أنا انا أنت انت هما كما مثل نحو خلال دون منذ لدى لدي ذات ذو فقط جدا أكثر اكثر أقل اقل وقد وقال قال وهو وهي وفي ومن وعلى وإلى والتي والذي وكان وأن وإن ولا وما وله وبه به بها له لها لهم منه منها فيه فيها عليه عليها إليه اليه عنه تم يتم وفقا حسب عبر لأن لان بأن بان',
  };
  const STOP = {};
  for (const k of Object.keys(SW)) STOP[k] = new Set(SW[k].split(/\s+/));

  /* ---------- utilitaires de texte ---------- */
  const AR_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
  const AR_MARKS = /[ً-ٰٟۖ-ۭـ]/g; // voyelles brèves, tatwil

  function detectLang(text) {
    const letters = (text.match(/\p{L}/gu) || []).length || 1;
    const ar = (text.match(/[؀-ۿݐ-ݿ]/g) || []).length;
    if (ar / letters > 0.3) return 'ar';
    let f = 0, e = 0;
    for (const w of (text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) || [])) {
      if (STOP.fr.has(w)) f++;
      if (STOP.en.has(w)) e++;
    }
    if (f === e) return /[àâçéèêëîïôûùüÿœ]/i.test(text) ? 'fr' : 'en';
    return f > e ? 'fr' : 'en';
  }

  const ABBR = new Set(['m', 'mm', 'mme', 'mmes', 'mlle', 'dr', 'pr', 'prof', 'st', 'ste', 'cf', 'cfr', 'etc', 'vs', 'fig', 'tab',
    'al', 'no', 'nos', 'ex', 'éd', 'ed', 'eds', 'op', 'cit', 'ibid', 'id', 'vol', 'ch', 'chap', 'p', 'pp', 'art', 'env', 'ca',
    'mr', 'mrs', 'ms', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp', 'eg', 'ie', 'viz', 'resp', 'sect', 'suiv', 'trad', 'dir', 'coll', 'réf', 'ref']);

  /* Découpe en phrases en gardant le numéro de paragraphe. */
  function splitSentences(text) {
    const out = [];
    const paras = text.replace(/\r/g, '').split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
    paras.forEach((p, pi) => {
      const re = /[.!?؟…]+["»”)\]]*(?=\s+|$)/g;
      let start = 0, m;
      const pieces = [];
      while ((m = re.exec(p))) {
        const end = m.index + m[0].length;
        const before = p.slice(start, m.index);
        const last = (before.match(/[\p{L}\p{N}'’-]+$/u) || [''])[0].toLowerCase().replace(/['’-]/g, '');
        const next = p.slice(end).trimStart();
        const isAbbr = m[0] === '.' && (ABBR.has(last) || /^\p{Lu}$/u.test((before.match(/[\p{L}]+$/u) || [''])[0]) || /^\d+$/.test(last) && /^\d/.test(next));
        const lowerNext = /^\p{Ll}/u.test(next);
        if (isAbbr || (m[0] === '.' && lowerNext)) continue;
        pieces.push(p.slice(start, end).trim());
        start = end;
      }
      const rest = p.slice(start).trim();
      if (rest) pieces.push(rest);
      pieces.forEach((s, si) => out.push({ text: s, para: pi, first: si === 0 }));
    });
    return out;
  }

  /* ---------- normalisation des mots ---------- */
  const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  function arStem(w) {
    w = w.replace(AR_MARKS, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
    const pre = ['وبال', 'وكال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'ولل'];
    for (const p of pre) if (w.startsWith(p) && w.length - p.length >= 3) { w = w.slice(p.length); break; }
    const suf = ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'هن', 'كم', 'نا', 'ية', 'ة', 'ه', 'ي'];
    for (const s of suf) if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
    return w;
  }
  function frStem(w) {
    w = stripAccents(w);
    if (w.length > 5 && /(ements|ement|ations|ation|ités|ité|ences|ence|ances|ance)$/.test(w)) return w.replace(/(ements|ement|ations|ation|ités|ité|ences|ence|ances|ance)$/, '');
    if (w.length > 4) w = w.replace(/(aux)$/, 'al').replace(/(es|s|x)$/, '');
    return w;
  }
  function enStem(w) {
    if (w.length > 6) w = w.replace(/(ations|ation|ments|ment|ness|ities|ity|ingly|ing|edly|ed)$/, '');
    if (w.length > 3) w = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
    return w;
  }

  function terms(sentence, lang) {
    const words = sentence.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
    const sw = STOP[lang];
    const out = [];
    for (let w of words) {
      w = w.replace(/^[lndjmcstq]['’]/, '');          // l'innovation → innovation
      if (/^\d+$/.test(w)) { if (w.length >= 4) out.push(w); continue; } // années, chiffres significatifs
      let key = lang === 'ar' ? w.replace(AR_MARKS, '') : w;
      if (key.length < 3 || sw.has(key) || (lang !== 'ar' && sw.has(stripAccents(key)))) continue;
      key = lang === 'ar' ? arStem(key) : (lang === 'fr' ? frStem(key) : enStem(key));
      if (key.length >= 3 && !sw.has(key)) out.push(key);
    }
    return out;
  }

  /* ---------- classement ---------- */
  function rank(sentences, lang) {
    const n = sentences.length;
    const tf = sentences.map((s) => {
      const m = new Map();
      for (const t of terms(s.text, lang)) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
    const df = new Map();
    tf.forEach((m) => m.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
    const idf = (t) => Math.log(1 + n / (df.get(t) || 1));
    const vec = tf.map((m) => {
      const v = new Map(); let norm = 0;
      m.forEach((c, t) => { const w = (1 + Math.log(c)) * idf(t); v.set(t, w); norm += w * w; });
      return { v, norm: Math.sqrt(norm) };
    });
    // similarité cosinus
    const sim = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      if (!vec[i].norm) continue;
      for (let j = i + 1; j < n; j++) {
        if (!vec[j].norm) continue;
        let dot = 0;
        const [a, b] = vec[i].v.size < vec[j].v.size ? [vec[i].v, vec[j].v] : [vec[j].v, vec[i].v];
        a.forEach((w, t) => { const o = b.get(t); if (o) dot += w * o; });
        const s = dot / (vec[i].norm * vec[j].norm);
        if (s > 0.04) { sim[i][j] = s; sim[j][i] = s; }
      }
    }
    const outSum = sim.map((row) => row.reduce((a, b) => a + b, 0));
    let score = new Float64Array(n).fill(1 / n);
    for (let it = 0; it < 40; it++) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j < n; j++) if (sim[j][i] && outSum[j]) acc += (sim[j][i] / outSum[j]) * score[j];
        next[i] = 0.15 / n + 0.85 * acc;
      }
      score = next;
    }
    // normalisation, bonus de position, pénalité de longueur
    const max = Math.max(...score) || 1;
    return sentences.map((s, i) => {
      const words = (s.text.match(/[\p{L}\p{N}]+/gu) || []).length;
      let sc = score[i] / max;
      if (s.first) sc *= 1.12;
      if (i === 0) sc *= 1.1;
      if (words < 6) sc *= 0.35;
      else if (words < 10) sc *= 0.8;
      else if (words > 70) sc *= 0.7;
      if (!/[.!?؟…"»”)]$/.test(s.text) && words < 12) sc *= 0.4; // titre ou fragment
      if (!vec[i].norm) sc = 0;
      return sc;
    });
  }

  function keywords(sentences, lang, k) {
    const count = new Map(), first = new Map();
    sentences.forEach((s) => terms(s.text, lang).forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
    // on restitue une forme réelle du mot (la plus fréquente) plutôt que la racine
    const forms = new Map();
    sentences.forEach((s) => (s.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).forEach((w) => {
      const t = terms(w, lang)[0];
      if (!t) return;
      const m = forms.get(t) || new Map(); m.set(w, (m.get(w) || 0) + 1); forms.set(t, m);
      if (!first.has(t)) first.set(t, w);
    }));
    return [...count.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, k || 8).map(([t]) => {
      const m = forms.get(t); let best = first.get(t), bc = 0;
      if (m) m.forEach((c, w) => { if (c > bc) { bc = c; best = w; } });
      return best;
    });
  }

  /* ---------- API ---------- */
  const SIZES = { short: 0.1, medium: 0.2, long: 0.35 };
  const LIMITS = { short: [2, 6], medium: [3, 12], long: [5, 24] };

  /* opts : size 'short' | 'medium' | 'long' ; format 'para' | 'bullets' ; lang 'auto' | 'fr' | 'en' | 'ar' */
  function summarize(text, opts) {
    opts = Object.assign({ size: 'medium', format: 'para', lang: 'auto' }, opts || {});
    const src = String(text || '').replace(/­/g, '').trim();
    if (!src) return { text: '', count: 0, total: 0, lang: opts.lang === 'auto' ? 'fr' : opts.lang, keywords: [], short: true };
    const lang = opts.lang === 'auto' ? detectLang(src) : opts.lang;
    const sentences = splitSentences(src);
    const total = sentences.length;
    const [lo, hi] = LIMITS[opts.size] || LIMITS.medium;
    if (total <= lo) {
      return { text: opts.format === 'bullets' ? sentences.map((s) => '• ' + s.text).join('\n') : sentences.map((s) => s.text).join(' '),
        count: total, total, lang, keywords: keywords(sentences, lang), short: true };
    }
    // textes longs : classement par blocs de 400 phrases (coût quadratique), les scores sont comparables
    // car normalisés par bloc ; la sélection finale reste globale, donc répartie sur tout le texte.
    const BLOCK = 400;
    let scores = [];
    if (total <= BLOCK * 1.25) scores = rank(sentences, lang);
    else {
      const nb = Math.ceil(total / BLOCK), size = Math.ceil(total / nb);
      for (let b = 0; b < nb; b++) scores.push(...rank(sentences.slice(b * size, (b + 1) * size), lang));
    }
    const want = Math.max(lo, Math.min(hi, Math.round(total * (SIZES[opts.size] || SIZES.medium))));
    const picked = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, want).map((x) => x[1]).sort((a, b) => a - b);
    const chosen = picked.map((i) => sentences[i]);
    let outText;
    if (opts.format === 'bullets') outText = chosen.map((s) => '• ' + s.text).join('\n');
    else {
      const parts = []; let prevPara = -1;
      chosen.forEach((s) => { if (parts.length && s.para !== prevPara) parts.push('\n\n'); else if (parts.length) parts.push(' '); parts.push(s.text); prevPara = s.para; });
      outText = parts.join('');
    }
    return { text: outText, count: chosen.length, total, lang, keywords: keywords(sentences, lang), short: false };
  }

  return { summarize, detectLang, splitSentences, terms, keywords };
});
