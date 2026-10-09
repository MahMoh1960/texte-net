/* Texte Net — bibliothèque, lecteur de livres et OCR (latin : français / anglais).
   Dépend de window.TN, exposé par index.html. */
(function () {
'use strict';
const TN = window.TN;
const { $, $$, el, toast } = TN;
const abs = (p) => new URL(p, location.href).href;
// Chemins des bibliothèques : dossiers « vendor » (version complète) ou fichiers à la racine (version à plat)
const V = window.TEXTE_NET_FLAT ? {
  pdfjs: './pdf.min.mjs', pdfWorker: 'pdf.worker.min.mjs', cmaps: './', fonts: './', wasm: './', icc: './',
  jszip: 'jszip.min.js', tess: 'tesseract.min.js', tessWorker: 'tesseract-worker.min.js', core: './', lang: './'
} : {
  pdfjs: './vendor/pdfjs/pdf.min.mjs', pdfWorker: 'vendor/pdfjs/pdf.worker.min.mjs', cmaps: 'vendor/pdfjs/cmaps/',
  fonts: 'vendor/pdfjs/standard_fonts/', wasm: 'vendor/pdfjs/wasm/', icc: 'vendor/pdfjs/iccs/',
  jszip: 'vendor/jszip/jszip.min.js', tess: 'vendor/tesseract/tesseract.min.js', tessWorker: 'vendor/tesseract/worker.min.js',
  core: 'vendor/tesseract/core', lang: 'vendor/tesseract/lang'
};
const MAX_FILE = 400 * 1024 * 1024;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const safeName = (s) => (s || 'livre').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'livre';
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');

/* ---------- chargement à la demande ---------- */
const scripts = {};
function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => { delete scripts[src]; rej(new Error('Chargement impossible : ' + src)); };
      document.head.append(s);
    });
  }
  return scripts[src];
}
let pdfjsP = null;
function getPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(V.pdfjs).then((m) => {
      m.GlobalWorkerOptions.workerSrc = abs(V.pdfWorker);
      return m;
    }).catch((e) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}

/* ---------- IndexedDB : livres, fichiers, textes OCR ---------- */
let dbP = null;
function db() {
  if (!dbP) {
    dbP = new Promise((res, rej) => {
      const r = indexedDB.open('texte-net', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files');
        d.createObjectStore('ocr');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbP;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transaction annulée'));
  });
}
async function deleteBook(id) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(['books', 'files', 'ocr'], 'readwrite');
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
    t.objectStore('ocr').delete(IDBKeyRange.bound(id + ':', id + ':￿'));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* =====================================================================
   OCR — latin uniquement (français + anglais)
   ===================================================================== */
let ocrWorker = null, ocrIdleT = null, ocrBusy = false, ocrLogger = null;
function ocrStatusText(m) {
  const map = {
    'loading tesseract core': 'chargement du moteur…',
    'initializing tesseract': 'initialisation…',
    'loading language traineddata': 'chargement des langues…',
    'initializing api': 'initialisation…',
    'recognizing text': 'reconnaissance'
  };
  const base = map[m.status] || m.status;
  return m.status === 'recognizing text' ? `${base} ${Math.round((m.progress || 0) * 100)} %` : base;
}
async function getOcrWorker() {
  clearTimeout(ocrIdleT);
  if (!ocrWorker) {
    await loadScript(V.tess);
    ocrWorker = await window.Tesseract.createWorker(['fra', 'eng'], 1, {
      workerPath: abs(V.tessWorker),
      corePath: abs(V.core),
      langPath: abs(V.lang),
      cacheMethod: 'none',
      logger: (m) => { if (ocrLogger) ocrLogger(ocrStatusText(m)); }
    });
  }
  return ocrWorker;
}
async function ocr(canvas, onStatus) {
  if (ocrBusy) throw new Error('Une reconnaissance est déjà en cours.');
  ocrBusy = true; ocrLogger = onStatus;
  try {
    const w = await getOcrWorker();
    const { data } = await w.recognize(canvas);
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  } catch (e) {
    try { if (ocrWorker) await ocrWorker.terminate(); } catch (e2) { /* déjà arrêté */ }
    ocrWorker = null;
    throw e;
  } finally {
    ocrBusy = false; ocrLogger = null;
    clearTimeout(ocrIdleT);
    ocrIdleT = setTimeout(() => { if (ocrWorker) { ocrWorker.terminate(); ocrWorker = null; } }, 120000);
  }
}
const LOW_CONF = 55;
const lowConfMsg = (c) => `Confiance faible (${c} %). L’OCR ne lit que le latin (français, anglais) : une page arabe ou de mauvaise qualité donnera un résultat inexploitable.`;

async function fileToCanvas(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, (maxSide || 3300) / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.2)';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return c;
}

// Bouton « Image (OCR) » de l'onglet Nettoyer
$('#cl-ocr').onclick = () => $('#cl-ocr-file').click();
$('#cl-ocr-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    TN.setStats('OCR : préparation…');
    const c = await fileToCanvas(f);
    const r = await ocr(c, (s) => TN.setStats('OCR : ' + s));
    c.width = c.height = 0;
    if (!r.text.trim()) { TN.setStats(''); toast('Aucun texte reconnu', 3000); return; }
    TN.toCleaner(r.text);
    if (r.confidence < LOW_CONF) toast(lowConfMsg(r.confidence), 6000);
    else toast(`OCR terminé (confiance ${r.confidence} %). À relire.`, 3500);
  } catch (err) { TN.setStats(''); toast('OCR impossible : ' + (err.message || err), 5000); }
});

/* =====================================================================
   Lecture des formats « à plat » (EPUB, DOCX, ODT, TXT, HTML)
   ===================================================================== */
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
function resolvePath(baseDir, href) {
  let h = href.split('#')[0];
  try { h = decodeURIComponent(h); } catch (e) { /* garder tel quel */ }
  const out = [];
  for (const p of (baseDir + h).split('/')) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
function blocksFromDoc(doc) {
  const root = doc.body || doc.documentElement;
  root.querySelectorAll('script,style').forEach((n) => n.remove());
  const sel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,td,th,caption';
  const all = Array.from(root.querySelectorAll(sel)).filter((e) => !e.querySelector(sel));
  let blocks = all.map((e) => ({ h: /^H[1-6]$/.test(e.tagName), t: e.textContent.replace(/\s+/g, ' ').trim() })).filter((b) => b.t);
  if (!blocks.length) {
    blocks = (root.textContent || '').split(/\n\s*\n/).map((s) => ({ h: false, t: s.replace(/\s+/g, ' ').trim() })).filter((b) => b.t);
  }
  return blocks;
}
function chunkBlocks(blocks, title) {
  const out = []; let cur = [], len = 0;
  const flush = () => { if (cur.length) { out.push({ blocks: cur }); cur = []; len = 0; } };
  for (const b of blocks) {
    if (cur.length && (len + b.t.length > 9000 || cur.length >= 120)) flush();
    cur.push(b); len += b.t.length;
  }
  flush();
  out.forEach((s, i) => {
    const h = s.blocks.find((b) => b.h);
    const base = (i === 0 && title) ? title : (h ? h.t.slice(0, 90) : (title || 'Partie'));
    s.title = base + (out.length > 1 ? ` (${i + 1}/${out.length})` : '');
  });
  return out;
}
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); } catch (e) { /* pas de l'UTF-8 */ }
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  const n = Math.min(u8.length, 20000); let hi = 0;
  for (let i = 0; i < n; i++) if (u8[i] >= 0x80) hi++;
  // beaucoup d'octets hauts = probablement de l'arabe Windows-1256 ; peu = accents latins
  return new TextDecoder(n && hi / n > 0.3 ? 'windows-1256' : 'windows-1252').decode(u8);
}
function textToBlocks(text) {
  const t = text.replace(/\r\n?/g, '\n');
  let paras = t.split(/\n\s*\n/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (paras.length < 3 && t.length > 3000) {
    paras = window.Cleaner.clean(t, { paraSep: 'blank' }).text.split('\n\n').filter(Boolean);
  }
  return paras.map((s) => ({ h: false, t: s }));
}
async function parseEpub(buf) {
  await loadScript(V.jszip);
  const zip = await window.JSZip.loadAsync(buf);
  const readText = async (path) => { const f = zip.file(path); return f ? f.async('string') : null; };
  const container = await readText('META-INF/container.xml');
  if (!container) throw new Error('EPUB invalide (container.xml manquant)');
  const rf = parseXml(container).querySelector('rootfile');
  const opfPath = rf && rf.getAttribute('full-path');
  const opfXml = opfPath && await readText(opfPath);
  if (!opfXml) throw new Error('EPUB invalide (fichier OPF manquant)');
  const opf = parseXml(opfXml);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach((i) => {
    manifest[i.getAttribute('id')] = { href: i.getAttribute('href') || '', type: i.getAttribute('media-type') || '', props: i.getAttribute('properties') || '' };
  });
  const titleEl = opf.getElementsByTagNameNS('*', 'title')[0];
  const bookTitle = titleEl ? titleEl.textContent.trim() : '';

  // Titres des chapitres (nav.xhtml ou toc.ncx)
  const titles = new Map();
  try {
    const navItem = Object.values(manifest).find((i) => /\bnav\b/.test(i.props));
    if (navItem) {
      const p = resolvePath(base, navItem.href);
      const html = await readText(p);
      if (html) {
        const d = new DOMParser().parseFromString(html, 'text/html');
        let nav = null;
        try { nav = d.querySelector('nav[epub\\:type="toc"]'); } catch (e) { /* sélecteur non pris en charge */ }
        const dir = p.slice(0, p.lastIndexOf('/') + 1);
        (nav || d).querySelectorAll('a[href]').forEach((a) => {
          const k = resolvePath(dir, a.getAttribute('href'));
          const t = a.textContent.replace(/\s+/g, ' ').trim();
          if (t && !titles.has(k)) titles.set(k, t);
        });
      }
    } else {
      const ncxItem = Object.values(manifest).find((i) => i.type === 'application/x-dtbncx+xml');
      if (ncxItem) {
        const p = resolvePath(base, ncxItem.href);
        const xml = await readText(p);
        if (xml) {
          const dir = p.slice(0, p.lastIndexOf('/') + 1);
          parseXml(xml).querySelectorAll('navPoint').forEach((np) => {
            const c = np.querySelector('content'); const l = np.querySelector('navLabel');
            if (!c || !l) return;
            const k = resolvePath(dir, c.getAttribute('src') || '');
            const t = l.textContent.replace(/\s+/g, ' ').trim();
            if (t && !titles.has(k)) titles.set(k, t);
          });
        }
      }
    }
  } catch (e) { /* sommaire facultatif */ }

  const sections = []; let n = 0;
  for (const ref of Array.from(opf.querySelectorAll('spine > itemref'))) {
    const item = manifest[ref.getAttribute('idref')];
    if (!item || !/html/.test(item.type)) continue;
    const p = resolvePath(base, item.href);
    const html = await readText(p);
    if (!html) continue;
    const blocks = blocksFromDoc(new DOMParser().parseFromString(html, 'text/html'));
    if (!blocks.length) continue;
    const heading = blocks.find((b) => b.h);
    const title = titles.get(p) || (heading ? heading.t.slice(0, 90) : `Section ${++n}`);
    sections.push(...chunkBlocks(blocks, title));
  }
  return { sections, title: bookTitle };
}
async function parseDocx(buf) {
  await loadScript(V.jszip);
  const zip = await window.JSZip.loadAsync(buf);
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('DOCX invalide');
  const doc = parseXml(await f.async('string'));
  const blocks = [];
  for (const p of Array.from(doc.getElementsByTagName('w:p'))) {
    const st = p.getElementsByTagName('w:pStyle')[0];
    const style = st ? (st.getAttribute('w:val') || '') : '';
    let t = '';
    for (const n of Array.from(p.getElementsByTagName('*'))) {
      if (n.nodeName === 'w:t') t += n.textContent;
      else if (n.nodeName === 'w:tab' || n.nodeName === 'w:br') t += ' ';
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ h: /^(heading|titre|title)/i.test(style), t });
  }
  return { sections: chunkBlocks(blocks, ''), title: '' };
}
async function parseOdt(buf) {
  await loadScript(V.jszip);
  const zip = await window.JSZip.loadAsync(buf);
  const f = zip.file('content.xml');
  if (!f) throw new Error('ODT invalide');
  const doc = parseXml(await f.async('string'));
  const blocks = [];
  for (const n of Array.from(doc.getElementsByTagName('*'))) {
    if (n.nodeName !== 'text:p' && n.nodeName !== 'text:h') continue;
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ h: n.nodeName === 'text:h', t });
  }
  return { sections: chunkBlocks(blocks, ''), title: '' };
}
async function parseFlow(format, blob) {
  const buf = await blob.arrayBuffer();
  if (format === 'epub') return parseEpub(buf);
  if (format === 'docx') return parseDocx(buf);
  if (format === 'odt') return parseOdt(buf);
  const text = decodeText(buf);
  const blocks = format === 'html'
    ? blocksFromDoc(new DOMParser().parseFromString(text, 'text/html'))
    : textToBlocks(text);
  return { sections: chunkBlocks(blocks, ''), title: '' };
}

/* =====================================================================
   Extraction du texte d'une page PDF
   ===================================================================== */
async function extractPdfText(pdf, n, margins) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const m = margins ? 0.06 : 0;
  let out = '', prevEOL = false, lastVy = null, lastH = 10;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const vy = vp.convertToViewportPoint(it.transform[4], it.transform[5])[1];
    if (m && (vy < vp.height * m || vy > vp.height * (1 - m))) continue;
    const h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
    if (prevEOL && lastVy !== null && (vy - lastVy) > 1.9 * lastH) out += '\n'; // grand blanc = nouveau paragraphe
    out += it.str;
    if (it.hasEOL) out += '\n';
    prevEOL = !!it.hasEOL; lastVy = vy; lastH = h;
  }
  page.cleanup();
  return out;
}

/* =====================================================================
   Bibliothèque
   ===================================================================== */
let lib = [];
const FORMATS = { pdf: 'pdf', epub: 'epub', docx: 'docx', odt: 'odt', txt: 'txt', text: 'txt', md: 'txt', markdown: 'txt', html: 'html', htm: 'html', xhtml: 'html' };
function detectFormat(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (FORMATS[ext]) return FORMATS[ext];
  if (f.type === 'application/pdf') return 'pdf';
  if (f.type === 'application/epub+zip') return 'epub';
  if (f.type === 'text/plain') return 'txt';
  return null;
}
async function loadLib() {
  try { lib = await idb('books', 'readonly', (s) => s.getAll()); } catch (e) { lib = []; toast('Stockage des livres indisponible sur ce navigateur', 4000); }
}
function renderLib() {
  const list = $('#bk-list'); list.replaceChildren();
  lib.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  $('#bk-count').textContent = lib.length ? `${lib.length} livre${lib.length > 1 ? 's' : ''}` : '';
  if (!lib.length) { list.append(el('p', 'empty', 'Aucun livre pour l’instant. Touchez « + Importer un livre ».')); return; }
  for (const b of lib) {
    const card = el('div', 'book');
    const main = el('button', 'book-main');
    const t = el('div', 't', b.title); t.dir = 'auto';
    let prog = 'jamais ouvert';
    if (b.total) {
      const cur = b.format === 'pdf' ? b.pos : b.pos + 1;
      prog = `${b.format === 'pdf' ? 'p. ' : ''}${cur} / ${b.total} (${Math.round(cur / b.total * 100)} %)`;
    }
    main.append(t, el('div', 'm', [b.format.toUpperCase(), fmtSize(b.size), prog].join(' · ')));
    main.onclick = () => openBook(b);
    const del = el('button', 'btn small danger', 'Supprimer');
    del.onclick = async () => {
      if (!confirm(`Supprimer « ${b.title} » de la bibliothèque ?`)) return;
      try { await deleteBook(b.id); lib = lib.filter((x) => x.id !== b.id); renderLib(); toast('Livre supprimé'); }
      catch (e) { toast('Suppression impossible'); }
    };
    card.append(main, del);
    list.append(card);
  }
}
async function importFiles(files) {
  let added = 0;
  for (const f of files) {
    const format = detectFormat(f);
    if (!format) { toast(`Format non pris en charge : ${f.name}. Utilisez PDF, EPUB, DOCX, ODT, TXT ou HTML.`, 4500); continue; }
    if (f.size > MAX_FILE) { toast(`${f.name} est trop volumineux (max. ${fmtSize(MAX_FILE)})`, 4000); continue; }
    if (lib.some((b) => b.title === f.name.replace(/\.[^.]+$/, '') && b.size === f.size)) { toast(`« ${f.name} » est déjà dans la bibliothèque`); continue; }
    const meta = { id: TN.uid(), title: f.name.replace(/\.[^.]+$/, ''), autoTitle: true, format, size: f.size, added: Date.now(), opened: 0, pos: format === 'pdf' ? 1 : 0, total: 0 };
    try {
      await idb('files', 'readwrite', (s) => s.put(f, meta.id));
      await idb('books', 'readwrite', (s) => s.put(meta));
      lib.push(meta); added++;
    } catch (e) {
      try { await deleteBook(meta.id); } catch (e2) { /* rien */ }
      toast(`Import impossible : ${f.name} (espace insuffisant ?)`, 4500);
    }
  }
  renderLib();
  if (added) toast(`${added} livre${added > 1 ? 's' : ''} importé${added > 1 ? 's' : ''}`);
}
$('#bk-import').onclick = () => $('#bk-file').click();
$('#bk-file').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  if (files.length) await importFiles(files);
});
let saveT;
const saveMeta = (meta) => idb('books', 'readwrite', (s) => s.put({ ...meta })).catch(() => {});
const saveMetaSoon = (meta) => { clearTimeout(saveT); saveT = setTimeout(() => saveMeta(meta), 500); };

/* =====================================================================
   Lecteur
   ===================================================================== */
let rd = null;
const body = $('#rd-body');
const setStatus = (msg, err) => { const s = $('#rd-status'); s.textContent = msg || ''; s.classList.toggle('err', !!err); };

async function openBook(meta) {
  if (rd) closeReader(true);
  $('#books-lib').hidden = true; $('#books-reader').hidden = false;
  history.pushState({ reader: true }, '');
  $('#rd-title').textContent = meta.title;
  body.replaceChildren(); setStatus('Ouverture…');
  const mine = rd = {
    meta, kind: meta.format === 'pdf' ? 'pdf' : 'flow', mode: meta.mode || (meta.format === 'pdf' ? 'page' : 'text'),
    zoom: 1, pdf: null, sections: [], total: 0, pos: 0, rawCache: new Map(), token: 0, renderTask: null, outline: null
  };
  window.scrollTo(0, 0);
  try {
    const blob = await idb('files', 'readonly', (s) => s.get(meta.id));
    if (!blob) throw new Error('fichier introuvable dans la bibliothèque');
    if (meta.format === 'pdf') {
      const pdfjs = await getPdfjs();
      const data = new Uint8Array(await blob.arrayBuffer());
      const task = pdfjs.getDocument({
        data,
        cMapUrl: abs(V.cmaps), cMapPacked: true,
        standardFontDataUrl: abs(V.fonts),
        wasmUrl: abs(V.wasm), iccUrl: abs(V.icc),
        isEvalSupported: false
      });
      task.onPassword = (update) => {
        const pw = prompt('Ce PDF est protégé. Mot de passe :');
        if (pw) update(pw); else task.destroy();
      };
      mine.pdf = await task.promise;
      mine.total = mine.pdf.numPages;
      mine.pos = clamp(meta.pos || 1, 1, mine.total);
    } else {
      const r = await parseFlow(meta.format, blob);
      if (!r.sections.length) throw new Error('aucun texte lisible dans ce fichier');
      mine.sections = r.sections; mine.total = r.sections.length; mine.mode = 'text';
      mine.pos = clamp(meta.pos || 0, 0, mine.total - 1);
      if (r.title && meta.autoTitle) { meta.title = r.title; $('#rd-title').textContent = r.title; }
    }
    if (rd !== mine) return;
    meta.total = mine.total; meta.pos = mine.pos; meta.opened = Date.now();
    saveMeta(meta);
    setStatus('');
    await show();
  } catch (e) {
    if (rd === mine) setStatus('Impossible d’ouvrir ce fichier : ' + ((e && e.message) || e), true);
  }
}
function closeReader(fromPop) {
  if (!rd) return;
  try { if (rd.renderTask) rd.renderTask.cancel(); } catch (e) { /* rien */ }
  try { if (rd.pdf) rd.pdf.destroy(); } catch (e) { /* rien */ }
  clearTimeout(saveT); saveMeta(rd.meta);
  rd = null;
  closeSheet();
  $('#books-reader').hidden = true; $('#books-lib').hidden = false;
  body.replaceChildren(); setStatus('');
  renderLib();
  if (!fromPop && history.state && history.state.reader) history.back();
}
window.addEventListener('popstate', () => { if (rd && !$('#tab-books').hidden) closeReader(true); });
$('#rd-back').onclick = () => closeReader();

function updateControls() {
  if (!rd) return;
  const pdf = rd.kind === 'pdf';
  const cur = pdf ? rd.pos : rd.pos + 1;
  $('#rd-pos').textContent = `${pdf ? 'p. ' : ''}${cur} / ${rd.total}`;
  $('#rd-prev').disabled = cur <= 1; $('#rd-next').disabled = cur >= rd.total;
  $('#rd-mode').hidden = !pdf; $('#rd-ocr').hidden = !pdf;
  $('#rd-mode').textContent = rd.mode === 'page' ? 'Texte' : 'Page';
  $('#rd-minus').textContent = rd.mode === 'page' ? '−' : 'A−';
  $('#rd-plus').textContent = rd.mode === 'page' ? '+' : 'A+';
}
async function show() {
  if (!rd) return;
  const token = ++rd.token;
  updateControls();
  if (rd.kind === 'flow') return showFlow();
  if (rd.mode === 'page') return showPdfPage(token);
  return showPdfText(token);
}
function go(n) {
  if (!rd) return;
  const lo = rd.kind === 'pdf' ? 1 : 0, hi = rd.kind === 'pdf' ? rd.total : rd.total - 1;
  n = clamp(n, lo, hi);
  if (n === rd.pos) return;
  rd.pos = n; rd.meta.pos = n; saveMetaSoon(rd.meta);
  setStatus('');
  show(); window.scrollTo(0, 0);
}

async function showPdfPage(token) {
  const mine = rd;
  const wrap = el('div', 'rd-page'); body.replaceChildren(wrap);
  try {
    const page = await mine.pdf.getPage(mine.pos);
    if (token !== mine.token) return;
    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(240, body.clientWidth - 4);
    const vp = page.getViewport({ scale: (avail / base.width) * mine.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px'; canvas.style.height = Math.floor(vp.height) + 'px';
    wrap.append(canvas);
    try { if (mine.renderTask) mine.renderTask.cancel(); } catch (e) { /* rien */ }
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    mine.renderTask = task;
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    if (token === mine.token) setStatus('Affichage impossible : ' + ((e && e.message) || e), true);
  }
}

const readerCleanOpts = () => Object.assign({}, TN.cleanOpts(), { arabicVisual: false, repeated: false, paraSep: 'blank' });
async function pageText(n) {
  const mine = rd;
  if (mine.rawCache.has(n)) return mine.rawCache.get(n);
  let r;
  const o = await idb('ocr', 'readonly', (s) => s.get(mine.meta.id + ':' + n)).catch(() => null);
  if (o) r = { raw: o, from: 'ocr' };
  else {
    const raw = await extractPdfText(mine.pdf, n, TN.settings.rdMargins);
    r = raw.trim().length >= 5 ? { raw, from: 'pdf' } : { raw: '', from: 'none' };
  }
  mine.rawCache.set(n, r);
  return r;
}
async function showPdfText(token) {
  const mine = rd;
  setStatus('Lecture du texte…');
  body.replaceChildren();
  let r;
  try { r = await pageText(mine.pos); } catch (e) { if (token === mine.token) setStatus('Lecture du texte impossible : ' + ((e && e.message) || e), true); return; }
  if (token !== mine.token) return;
  setStatus('');
  const wrap = el('div', 'rd-text'); wrap.style.fontSize = TN.settings.rdFont + 'px';
  if (r.from === 'none') {
    wrap.append(el('p', 'notice', 'Cette page ne contient pas de texte sélectionnable (page scannée ou image).'));
    const b = el('button', 'btn primary', 'Reconnaître le texte (OCR français / anglais)');
    b.onclick = runOcrOnPage; wrap.append(b);
    wrap.append(el('p', 'muted', 'L’OCR ne lit que le latin. Pour une page arabe, utilisez le mode Page.'));
  } else {
    if (r.from === 'ocr') wrap.append(el('p', 'notice', 'Texte reconnu par OCR (français / anglais) : à relire.'));
    const text = window.Cleaner.clean(r.raw, readerCleanOpts()).text;
    text.split('\n\n').filter(Boolean).forEach((p) => { const e = el('p', null, p); e.dir = 'auto'; wrap.append(e); });
  }
  body.replaceChildren(wrap);
}
function showFlow() {
  const s = rd.sections[rd.pos];
  const wrap = el('div', 'rd-text'); wrap.style.fontSize = TN.settings.rdFont + 'px';
  s.blocks.forEach((b) => { const e = el(b.h ? 'h3' : 'p', null, b.t); e.dir = 'auto'; wrap.append(e); });
  body.replaceChildren(wrap);
}

async function runOcrOnPage() {
  if (!rd || rd.kind !== 'pdf') return;
  const mine = rd, n = mine.pos;
  try {
    setStatus('OCR : préparation de la page…');
    const page = await mine.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, 3300 / Math.max(base.width, base.height)) });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const r = await ocr(c, (s) => { if (rd === mine) setStatus('OCR : ' + s); });
    c.width = c.height = 0;
    if (!r.text.trim()) { setStatus('Aucun texte reconnu sur cette page.', true); return; }
    await idb('ocr', 'readwrite', (s) => s.put(r.text, mine.meta.id + ':' + n));
    mine.rawCache.delete(n);
    if (rd === mine && mine.pos === n) { mine.mode = 'text'; mine.meta.mode = 'text'; await show(); }
    if (rd === mine) setStatus(r.confidence < LOW_CONF ? lowConfMsg(r.confidence) : `OCR terminé (confiance ${r.confidence} %).`, r.confidence < LOW_CONF);
  } catch (e) { if (rd === mine) setStatus('OCR impossible : ' + ((e && e.message) || e), true); }
}

/* ---------- commandes ---------- */
$('#rd-prev').onclick = () => rd && go(rd.pos - 1);
$('#rd-next').onclick = () => rd && go(rd.pos + 1);
$('#rd-pos').onclick = () => {
  if (!rd) return;
  if (rd.kind === 'flow') { openToc(); return; }
  const v = prompt(`Aller à la page (1 à ${rd.total})`, String(rd.pos));
  const n = parseInt(v, 10);
  if (n) go(n);
};
$('#rd-mode').onclick = () => {
  if (!rd || rd.kind !== 'pdf') return;
  rd.mode = rd.mode === 'page' ? 'text' : 'page'; rd.meta.mode = rd.mode; saveMetaSoon(rd.meta);
  setStatus(''); show();
};
function zoom(d) {
  if (!rd) return;
  if (rd.mode === 'page' && rd.kind === 'pdf') { rd.zoom = clamp(Math.round((rd.zoom + d * 0.25) * 100) / 100, 1, 3); show(); }
  else {
    TN.settings.rdFont = clamp(TN.settings.rdFont + d * 2, 14, 32); TN.saveSettings();
    const w = body.querySelector('.rd-text'); if (w) w.style.fontSize = TN.settings.rdFont + 'px';
  }
}
$('#rd-minus').onclick = () => zoom(-1);
$('#rd-plus').onclick = () => zoom(1);
$('#rd-ocr').onclick = runOcrOnPage;
$('#rd-toc-btn').onclick = () => openToc();

// Glisser horizontalement pour tourner la page (mode Page non zoomé)
let sx = null, sy = 0, st = 0;
body.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { sx = null; return; }
  sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
}, { passive: true });
body.addEventListener('touchend', (e) => {
  if (sx === null || !rd) return;
  const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
  sx = null;
  if (rd.kind !== 'pdf' || rd.mode !== 'page' || rd.zoom > 1) return;
  if (Date.now() - st > 500 || Math.abs(dx) < 90 || Math.abs(dy) > 50) return;
  go(rd.pos + (dx < 0 ? 1 : -1));
}, { passive: true });

/* ---------- feuilles (sommaire, envoi) ---------- */
function openSheet(title, rows, before) {
  const card = $('#rd-sheet-card'); card.replaceChildren();
  card.append(el('div', 'muted', title));
  if (before) card.append(before);
  for (const [label, fn, cls] of rows) {
    const b = el('button', 'btn ' + (cls || ''), label); b.dir = 'auto';
    b.onclick = async () => { closeSheet(); await fn(); };
    card.append(b);
  }
  $('#rd-sheet').hidden = false;
}
function closeSheet() { $('#rd-sheet').hidden = true; }
$('#rd-sheet').addEventListener('click', (e) => { if (e.target.id === 'rd-sheet') closeSheet(); });

async function pdfOutline() {
  if (rd.outline) return rd.outline;
  const items = [];
  try {
    const out = await rd.pdf.getOutline();
    const walk = async (list, depth) => {
      for (const o of list) {
        let page = null;
        try {
          let dest = o.dest;
          if (typeof dest === 'string') dest = await rd.pdf.getDestination(dest);
          if (Array.isArray(dest)) page = typeof dest[0] === 'object' ? (await rd.pdf.getPageIndex(dest[0])) + 1 : dest[0] + 1;
        } catch (e) { /* destination illisible */ }
        if (page) items.push({ title: (o.title || '').trim() || '(sans titre)', page, depth });
        if (o.items && o.items.length && depth < 2 && items.length < 600) await walk(o.items, depth + 1);
      }
    };
    if (out) await walk(out, 0);
  } catch (e) { /* pas de sommaire */ }
  rd.outline = items;
  return items;
}
async function openToc() {
  if (!rd) return;
  if (rd.kind === 'flow') {
    openSheet('Sommaire', rd.sections.map((s, i) => [(i === rd.pos ? '▸ ' : '') + s.title, () => go(i)]));
    return;
  }
  const items = await pdfOutline();
  if (!items.length) { toast('Ce PDF n’a pas de sommaire : utilisez « Aller à la page »'); return; }
  openSheet('Sommaire', items.map((i) => ['  '.repeat(i.depth) + i.title + '  ·  p. ' + i.page, () => go(i.page)]));
}

let lastSel = { text: '', at: 0 }, pressedAt = 0;
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  const t = s ? s.toString().trim() : '';
  const inside = s && s.rangeCount && body.contains(s.anchorNode);
  if (t && inside) lastSel = { text: t, at: Date.now() };
  else if (!t && Date.now() - pressedAt > 700) lastSel = { text: '', at: 0 };
});
$('#rd-controls').addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
const recentSelection = () => (lastSel.text && Date.now() - lastSel.at < 60000 ? lastSel.text : '');

async function currentText() {
  if (rd.kind === 'flow') return rd.sections[rd.pos].blocks.map((b) => b.t).join('\n\n');
  const r = await pageText(rd.pos);
  return window.Cleaner.clean(r.raw, readerCleanOpts()).text;
}
function sourceLabel() {
  if (rd.kind === 'pdf') return `${rd.meta.title}, p. ${rd.pos}`;
  const s = rd.sections[rd.pos];
  return s && s.title ? `${rd.meta.title} — ${s.title}` : rd.meta.title;
}
async function sendText(sel, dest) {
  if (!rd) return;
  const src = sourceLabel();
  const text = sel || await currentText();
  if (!text.trim()) { toast('Cette page ne contient pas de texte. Essayez l’OCR.', 4000); return; }
  lastSel = { text: '', at: 0 };
  if (dest === 'clean') TN.toCleaner(text);
  else if (dest === 'translate') TN.toTranslate(text);
  else if (dest === 'note') TN.toNote(text, src);
  else TN.copyText(text);
}
function openSendSheet() {
  if (!rd) return;
  const sel = recentSelection();
  const title = sel ? `Sélection (${sel.length.toLocaleString('fr-FR')} caractères)` : (rd.kind === 'pdf' ? `Page ${rd.pos} entière` : 'Section entière');
  let before = null;
  if (rd.kind === 'pdf') {
    before = el('label', 'sheet-opt');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!TN.settings.rdMargins;
    cb.onchange = () => { TN.settings.rdMargins = cb.checked; TN.saveSettings(); rd.rawCache.clear(); if (rd.mode === 'text') show(); };
    before.append(cb, ' Ignorer les marges (n° de page, en-têtes)');
  }
  openSheet(title, [
    ['Nettoyer →', () => sendText(sel, 'clean')],
    ['Traduire →', () => sendText(sel, 'translate')],
    ['Carnet → (source préremplie)', () => sendText(sel, 'note')],
    ['Copier', () => sendText(sel, 'copy')],
    ['Tout le livre en .txt', exportBook]
  ], before);
}
$('#rd-send').onclick = openSendSheet;

async function exportBook() {
  const mine = rd; if (!mine) return;
  let text = '';
  try {
    if (mine.kind === 'flow') {
      text = mine.sections.map((s) => s.blocks.map((b) => b.t).join('\n\n')).join('\n\n');
    } else {
      const parts = []; let empty = 0;
      for (let n = 1; n <= mine.total; n++) {
        const r = await pageText(n);
        if (rd !== mine) return;
        if (r.raw.trim()) parts.push(r.raw); else empty++;
        if (n % 5 === 0 || n === mine.total) setStatus(`Extraction du texte… ${n} / ${mine.total}`);
      }
      setStatus('Nettoyage du texte…');
      await new Promise((r) => setTimeout(r, 30));
      text = window.Cleaner.clean(parts.join('\n\n'), Object.assign({}, TN.cleanOpts(), { arabicVisual: false })).text;
      setStatus(empty ? `${empty} page(s) sans texte ignorée(s) (scannées) : lancez l’OCR page par page, puis exportez à nouveau.` : '');
    }
    if (!text.trim()) { setStatus('Aucun texte à exporter : ce livre est probablement scanné (OCR page par page).', true); return; }
    TN.downloadText(`${safeName(mine.meta.title)}.txt`, text);
  } catch (e) { setStatus('Export impossible : ' + ((e && e.message) || e), true); }
}

/* ---------- interface publique ---------- */
window.Books = {
  async onShow() { await loadLib(); if (!rd) renderLib(); },
  leave() { closeReader(); }
};
})();
