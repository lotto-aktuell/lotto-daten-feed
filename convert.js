#!/usr/bin/env node
'use strict';
/*
 * convert.js — lädt das offizielle 6aus49-Archiv (CSV, z. B. Sachsenlotto/WestLotto),
 * validiert jede Ziehung und schreibt/aktualisiert docs/lotto6aus49.json.
 *
 * Merge-Prinzip: Bestehende Ziehungen werden NIE gelöscht. Neue werden per Datum
 * ergänzt — so bleibt die Historie vollständig, selbst wenn die Quelle nur die
 * letzten Jahre liefert.
 *
 * Aufruf:
 *   node convert.js                      → lädt alle URLs aus CSV_SOURCES
 *   node convert.js --file pfad.csv      → liest eine lokale CSV (zum Testen/Seeden)
 *   node convert.js --out pfad.json      → abweichende Ausgabedatei
 */

// ► HIER die offiziellen Quellen eintragen. Drei Formen sind erlaubt:
//
//   1. Direkte URL (GET):
//      'https://…/gewinnzahlen.csv',
//
//   2. Dynamischer Endpoint (POST-Formular, z. B. Sachsenlotto "Download starten").
//      URL + Formularfelder per Entwicklertools ermitteln (Anleitung in README):
//      { url: 'https://www.sachsenlotto.de/portal/…/download.do',
//        method: 'POST',
//        body: { spielart: 'LOTTO', format: 'csv' } },   // Felder aus DevTools
//
//   3. Datei im Repo (z. B. einmalig manuell heruntergeladenes Voll-Archiv):
//      'seed/lotto-archiv-bis-2018.csv',
//
//   Die Quellen werden der Reihe nach eingelesen und per Datum zusammengeführt.
const CSV_SOURCES = [
  // 'seed/lotto-archiv-bis-2018.csv',
  // { url: 'https://www.sachsenlotto.de/…', method: 'POST', body: { … } },
];

const QUELLE = 'Offizielles Gewinnzahlen-Archiv (sachsenlotto.de / Landeslotterie)';
const SZ_SEIT = '1991-12-04'; // Einführung der Superzahl

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argVal = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const OUT = argVal('--out') || path.join(__dirname, 'docs', 'lotto6aus49.json');
const LOCAL = argVal('--file');

function die(msg){ console.error('✗ FEHLER:', msg); process.exit(1); }
function log(...a){ console.log('•', ...a); }

// ── CSV laden (Datei oder URL), Encoding tolerant (UTF-8 / Latin-1) ──
async function loadCsv(src){
  const conf = typeof src === 'string' ? { url: src } : src;
  let buf;
  if (/^https?:/i.test(conf.url)) {
    const opts = {
      method: conf.method || 'GET',
      headers: Object.assign(
        { 'User-Agent': 'Mozilla/5.0 (lotto-daten-feed; privater Statistik-Feed)' },
        conf.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        conf.headers || {}
      )
    };
    if (conf.body) opts.body = new URLSearchParams(conf.body).toString();
    log('lade', opts.method, conf.url, conf.body ? 'mit Formulardaten ' + JSON.stringify(conf.body) : '');
    const res = await fetch(conf.url, opts);
    if (!res.ok) die(`HTTP ${res.status} bei ${conf.url}`);
    buf = Buffer.from(await res.arrayBuffer());
    const head = buf.slice(0, 200).toString('utf8');
    if (/<html|<!doctype/i.test(head))
      die(`${conf.url} liefert HTML statt CSV — URL/Formularfelder prüfen (DevTools-Anleitung in README). Anfang der Antwort: ${head.slice(0,120)}`);
  } else {
    const p = path.isAbsolute(conf.url) ? conf.url : path.join(__dirname, conf.url);
    log('lese Datei', p);
    buf = fs.readFileSync(p);
  }
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) text = buf.toString('latin1'); // deutsche Umlaute in Latin-1
  return text.replace(/^\uFEFF/, '');
}

// ── Parser: Header-gesteuert, Spalten werden über Namen erkannt ──
function parseCsv(text, label){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) die(`${label}: leere Datei`);
  const delim = (lines[0].split(';').length >= lines[0].split(',').length) ? ';' : ',';

  // Header-Zeile suchen (enthält "Datum")
  let headIdx = lines.findIndex(l => /datum/i.test(l));
  if (headIdx < 0) die(`${label}: keine Header-Zeile mit "Datum" gefunden — Format prüfen (erste Zeile: ${lines[0].slice(0,120)})`);
  const head = lines[headIdx].split(delim).map(h => h.trim().toLowerCase());

  const dateIdx = head.findIndex(h => /datum/.test(h));
  const numIdx = [];
  for (let k = 1; k <= 6; k++) {
    const i = head.findIndex(h => new RegExp(`^(lotto)?(gewinn)?zahl[ _-]?${k}$`).test(h) || h === 'z' + k);
    if (i < 0) die(`${label}: Spalte für Zahl ${k} nicht gefunden — Header: ${head.join(' | ')}`);
    numIdx.push(i);
  }
  const szIdx = head.findIndex(h => /superzahl/.test(h)); // Zusatzzahl/Spiel77/Super6 bewusst ignoriert
  log(`${label}: Header Zeile ${headIdx+1}, Trennzeichen "${delim}", Datum→${dateIdx}, Zahlen→[${numIdx}], Superzahl→${szIdx<0?'keine':szIdx}`);

  const draws = [];
  for (let li = headIdx + 1; li < lines.length; li++) {
    const f = lines[li].split(delim).map(x => x.trim().replace(/^"|"$/g, ''));
    if (f.length <= Math.max(dateIdx, ...numIdx)) continue;
    const iso = parseDate(f[dateIdx]);
    if (!iso) continue; // Fuß-/Leerzeilen überspringen
    const n = numIdx.map(i => parseInt(f[i], 10));
    if (n.some(x => !Number.isInteger(x))) { log(`  übersprungen (Zahlen unlesbar): ${lines[li].slice(0,80)}`); continue; }
    let sz = null;
    if (szIdx >= 0 && f[szIdx] !== '' && f[szIdx] != null) {
      const v = parseInt(f[szIdx], 10);
      if (Number.isInteger(v) && v >= 0 && v <= 9) sz = v;
    }
    if (sz != null && iso < SZ_SEIT) sz = null; // vor Einführung keine Superzahl
    draws.push({ d: iso, n: [...n].sort((a,b)=>a-b), sz });
  }
  log(`${label}: ${draws.length} Ziehungen gelesen`);
  return draws;
}

function parseDate(s){
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);            // 09.10.1955
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);                // 09.10.55
  if (m) { const y = +m[3] >= 55 ? '19'+m[3] : '20'+m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);                      // 1955-10-09
  if (m) return s;
  return null;
}

// ── Ziehung validieren ──
function checkDraw(dr){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dr.d)) return 'Datum';
  if (dr.n.length !== 6 || new Set(dr.n).size !== 6) return '6 eindeutige Zahlen';
  if (dr.n.some(x => x < 1 || x > 49)) return 'Zahlenbereich 1–49';
  if (dr.sz != null && (dr.sz < 0 || dr.sz > 9)) return 'Superzahl 0–9';
  return null;
}

(async function main(){
  const sources = LOCAL ? [LOCAL] : CSV_SOURCES;
  if (!sources.length) die('Keine Quelle: CSV_SOURCES in convert.js eintragen oder --file nutzen (siehe README).');

  // Bestehenden Feed laden (Merge-Basis)
  const byDate = new Map();
  if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    for (const dr of (prev.draws || [])) byDate.set(dr.d, dr);
    log(`bestehender Feed: ${byDate.size} Ziehungen (Stand ${prev.meta && prev.meta.stand})`);
  }
  const prevCount = byDate.size;

  let added = 0, conflicts = 0;
  for (const src of sources) {
    const label = path.basename(String(typeof src === 'string' ? src : src.url)).slice(0, 40) || 'Quelle';
    const draws = parseCsv(await loadCsv(src), label);
    for (const dr of draws) {
      const err = checkDraw(dr);
      if (err) die(`ungültige Ziehung am ${dr.d}: ${err} → ${JSON.stringify(dr)}`);
      const old = byDate.get(dr.d);
      if (old) {
        if (JSON.stringify(old.n) !== JSON.stringify(dr.n) || old.sz !== dr.sz) {
          conflicts++;
          console.warn(`⚠ Konflikt am ${dr.d}: vorhanden ${JSON.stringify(old)} vs. neu ${JSON.stringify(dr)} — Quelle übernimmt`);
        }
        byDate.set(dr.d, dr);
      } else { byDate.set(dr.d, dr); added++; }
    }
  }

  const all = [...byDate.values()].sort((a,b) => a.d < b.d ? -1 : 1);
  if (all.length < prevCount) die('Ergebnis hätte weniger Ziehungen als zuvor — Abbruch zum Schutz der Historie');
  if (all.length < 5000 && !LOCAL)
    console.warn(`⚠ Nur ${all.length} Ziehungen insgesamt — für die App-Validierung sind ≥5000 nötig (ggf. einmalig per --file mit Voll-Archiv seeden).`);

  const out = {
    meta: { quelle: QUELLE, stand: all.length ? all[all.length-1].d : null, ziehungen: all.length, generiert: new Date().toISOString() },
    draws: all
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`geschrieben: ${OUT} — ${all.length} Ziehungen (+${added} neu, ${conflicts} Konflikte), Stand ${out.meta.stand}`);
})().catch(e => die(e.stack || e));
