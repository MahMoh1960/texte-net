/* Texte Net — moteur de nettoyage du texte copié depuis un PDF.
   Fonctionne dans le navigateur (window.Cleaner) et sous Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cleaner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    dehyphenate: true,   // recoller les mots coupés par un tiret en fin de ligne
    pageNumbers: true,   // supprimer les numéros de page isolés
    repeated: true,      // supprimer les en-têtes / pieds de page répétés
    arabicForms: true,   // normaliser les formes de présentation arabes (NFKC)
    arabicVisual: false, // texte arabe stocké en ordre visuel (inversé)
    paraSep: 'blank'     // 'blank' | 'single' | 'none'
  };

  // Fragments qui forment un mot composé : on garde le trait d'union.
  const KEEP_PREFIXES = new Set([
    'socio', 'politico', 'anglo', 'franco', 'judéo', 'afro', 'austro', 'sino',
    'russo', 'germano', 'italo', 'hispano', 'nord', 'sud', 'peut', 'est',
    "c'est", "c’est", 'ex', 'quasi', 'non', 'self', 'well', 'ill'
  ]);

  const TERMINAL = /(?:[.!?؟…۔][»”"')\]]*|:)$/;
  const BULLET = /^(?:[•●▪■◦‣∙·*]\s*|[-–—]\s+|\d{1,2}[.)]\s+|\d{1,2}(?:\.\d{1,2})+\.?\s+|\(\d{1,2}\)\s+|[a-h][.)]\s+)/;
  const UPPER_START = /^[A-ZÀ-ÖØ-Þ«“"(\[0-9]/;
  const LOWER_START = /^[a-zà-öø-ÿ]/;

  const toLatinDigits = (s) => s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));

  // Texte arabe copié en ordre visuel : on inverse la ligne, puis on remet
  // à l'endroit les passages latins et les chiffres.
  function reverseVisualArabic(line) {
    if (!/[؀-ۿ]/.test(line)) return line;
    const rev = Array.from(line).reverse().join('');
    const ltr = '[A-Za-z0-9\\u00C0-\\u024F\\u0660-\\u0669\\u06F0-\\u06F9]+';
    const re = new RegExp(ltr + '(?:[ .,:/%-]' + ltr + ')*', 'g');
    return rev.replace(re, (run) => Array.from(run).reverse().join(''));
  }

  // 0 = autre, 1 = numéro de page explicite, 2 = nombre seul (≤ 3 chiffres)
  function pageNumberKind(line) {
    const t = toLatinDigits(line).trim();
    if (!t) return 0;
    if (/^(?:page|pages|p\.?|صفحة|الصفحة)\s*\d{1,4}(?:\s*(?:\/|sur|of|من)\s*\d{1,4})?$/i.test(t)) return 1;
    if (/^\d{1,4}\s*(?:\/|sur|of|من)\s*\d{1,4}$/i.test(t)) return 1;
    if (/^[-–—•·|]\s*\d{1,4}\s*[-–—•·|]$/.test(t)) return 1;
    if (/^\d{1,3}$/.test(t)) return 2;
    return 0;
  }

  function isBreak(prev, next, L) {
    if (BULLET.test(next)) return true;
    const short = prev.length < 0.6 * L;
    if (short && TERMINAL.test(prev)) return true;
    if (short && !/[,;\-–]$/.test(prev) && UPPER_START.test(next)) return true;
    return false;
  }

  function joinLines(cur, line, o, stats) {
    if (/\p{L}-$/u.test(cur)) {
      const word = (cur.match(/[\p{L}'’-]+$/u) || [''])[0];
      const frag = word.slice(0, -1);
      if (!o.dehyphenate) return cur + line;
      const keep =
        /^[\p{Lu}\d]/u.test(line) ||
        frag.includes('-') ||
        KEEP_PREFIXES.has(frag.toLowerCase());
      if (keep) return cur + line;
      stats.hyphens++;
      return cur.slice(0, -1) + line;
    }
    return cur + ' ' + line;
  }

  function clean(input, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const stats = { pageNumbers: 0, repeated: 0, hyphens: 0, paragraphs: 0 };

    let s = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
    s = s.replace(/­[ \t]*\n[ \t]*/g, '');                       // coupure douce en fin de ligne
    s = s.replace(/[­​⁠﻿‎‏‪-‮⁦-⁩]/g, '');
    s = s.replace(/[   -   　\t\f\v]/g, ' ');
    s = s.replace(/[ﬀ-ﬆ]/g, (ch) => ch.normalize('NFKC')); // ligatures ﬁ ﬂ…
    if (o.arabicForms) s = s.replace(/[ﭐ-﷿ﹰ-﻾]/g, (ch) => ch.normalize('NFKC'));

    let lines = s.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim());
    if (o.arabicVisual) lines = lines.map(reverseVisualArabic);

    // Numéros de page
    if (o.pageNumbers) {
      const kinds = lines.map(pageNumberKind);
      const neighbor = (i, dir) => {
        for (let j = i + dir; j >= 0 && j < lines.length; j += dir) if (lines[j] !== '') return j;
        return -1;
      };
      const drop = new Array(lines.length).fill(false);
      for (let i = 0; i < lines.length; i++) {
        if (kinds[i] === 1) drop[i] = true;
        else if (kinds[i] === 2) {
          const p = neighbor(i, -1), n = neighbor(i, 1);
          // un nombre entouré d'autres nombres est probablement un tableau
          if (!(p !== -1 && kinds[p] === 2) && !(n !== -1 && kinds[n] === 2)) drop[i] = true;
        }
      }
      stats.pageNumbers = drop.filter(Boolean).length;
      lines = lines.filter((_, i) => !drop[i]);
    }

    // En-têtes et pieds de page répétés (chiffres ignorés)
    if (o.repeated) {
      const key = (l) => toLatinDigits(l).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
      const counts = new Map();
      for (const l of lines) {
        if (l.length < 8 || l.length > 120) continue;
        const k = key(l);
        if (k.replace(/[^\p{L}]/gu, '').length >= 4) counts.set(k, (counts.get(k) || 0) + 1);
      }
      lines = lines.filter((l) => {
        if (l.length < 8 || l.length > 120) return true;
        if ((counts.get(key(l)) || 0) >= 3) { stats.repeated++; return false; }
        return true;
      });
    }

    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (!lines.length) return { text: '', stats };

    // Longueur de référence d'une ligne pleine (90e centile)
    const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
    const L = lens[Math.floor(0.9 * (lens.length - 1))];
    // Lignes vides à chaque ligne = bruit de copie, pas de vrais paragraphes
    const blankIsNoise = (lines.length - lens.length) >= 0.4 * lines.length;

    const paras = [];
    let cur = '', prev = '', pendingBlank = false;
    const push = () => { if (cur) { paras.push(cur); cur = ''; } };

    for (const line of lines) {
      if (!line) { pendingBlank = true; continue; }
      if (!cur) { cur = line; prev = line; pendingBlank = false; continue; }
      let brk;
      if (pendingBlank && !blankIsNoise) {
        // ligne vide = fin de paragraphe, sauf coupure de page en pleine phrase
        brk = !( !TERMINAL.test(prev) && LOWER_START.test(line) );
      } else {
        brk = isBreak(prev, line, L);
      }
      pendingBlank = false;
      if (brk) { push(); cur = line; } else { cur = joinLines(cur, line, o, stats); }
      prev = line;
    }
    push();

    const sep = o.paraSep === 'none' ? ' ' : o.paraSep === 'single' ? '\n' : '\n\n';
    stats.paragraphs = paras.length;
    return { text: paras.map((p) => p.replace(/ {2,}/g, ' ')).join(sep), stats };
  }

  return { clean, reverseVisualArabic, DEFAULTS };
});
