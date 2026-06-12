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
  {
    url: 'https://www.westlotto.de/wlinfo/WL_InfoService'
       + '?gruppe=ErgebnisDownload&client=wldl'
       + '&jahr_von=1955&jahr_bis={{AKTUELLES_JAHR}}'
       + '&spielart=LOTTO&format=csv',
    headers: { 'Referer': 'https://www.sachsenlotto.de/' }
  },
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
function decodeText(buf){
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) text = buf.toString('latin1'); // deutsche Umlaute in Latin-1
  return text.replace(/^\uFEFF/, '');
}

// ZIP-Archiv entpacken (Standard-ZIP, Deflate/Stored) — ohne Zusatzpakete.
// Liest das Inhaltsverzeichnis am Dateiende und extrahiert alle Einträge.
function unzipAll(buf){
  const zlib = require('zlib');
  // End-of-Central-Directory-Signatur (PK\x05\x06) im letzten Stück suchen
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die('ZIP-Archiv: Inhaltsverzeichnis nicht gefunden');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16); // Offset des Central Directory
  const entries = [];
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) die('ZIP-Archiv: Verzeichniseintrag beschädigt');
    const method   = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen  = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commLen  = buf.readUInt16LE(pos + 32);
    const lhOff    = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('latin1');
    // Datenposition über den lokalen Header ermitteln
    if (buf.readUInt32LE(lhOff) !== 0x04034b50) die('ZIP-Archiv: lokaler Header beschädigt');
    const lhName  = buf.readUInt16LE(lhOff + 26);
    const lhExtra = buf.readUInt16LE(lhOff + 28);
    const dataStart = lhOff + 30 + lhName + lhExtra;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 8) data = zlib.inflateRawSync(comp);
    else if (method === 0) data = comp;
    else die(`ZIP-Archiv: Kompressionsmethode ${method} nicht unterstützt (${name})`);
    if (!name.endsWith('/')) entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

// Lädt eine Quelle und liefert 1..n CSV-Texte (ZIP wird automatisch entpackt)
async function loadSource(src){
  const conf = typeof src === 'string' ? { url: src } : { ...src };
  conf.url = conf.url.replace('{{AKTUELLES_JAHR}}', String(new Date().getFullYear()));
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
  } else {
    const p = path.isAbsolute(conf.url) ? conf.url : path.join(__dirname, conf.url);
    log('lese Datei', p);
    buf = fs.readFileSync(p);
  }

  // ZIP? (Signatur "PK") → entpacken, CSV-Einträge verwenden
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const all = unzipAll(buf);
    let files = all.filter(e => /\.csv$/i.test(e.name));
    if (!files.length) files = all;
    if (!files.length) die('ZIP-Archiv ist leer');
    log(`ZIP entpackt: ${all.map(e=>e.name).join(', ')}`);
    return files.map(e => ({ name: e.name, text: decodeText(e.data) }));
  }

  const head = buf.slice(0, 200).toString('utf8');
  if (/<html|<!doctype/i.test(head))
    die(`${conf.url} liefert HTML statt CSV — URL/Formularfelder prüfen (DevTools-Anleitung in README). Anfang der Antwort: ${head.slice(0,120)}`);

  const label = path.basename(String(conf.url)).slice(0, 40) || 'Quelle';
  return [{ name: label, text: decodeText(buf) }];
}

// ── Parser: Header-gesteuert, Spalten werden über Namen erkannt ──
function parseCsv(text, label){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) die(`${label}: leere Datei`);
  const delim = (lines[0].split(';').length >= lines[0].split(',').length) ? ';' : ',';

  // Header-Zeile suchen ("Datum" oder getrennte Tag/Monat/Jahr-Spalten)
  let headIdx = lines.findIndex(l => /datum/i.test(l) || (/\btag\b/i.test(l) && /monat/i.test(l) && /jahr/i.test(l)));
  if (headIdx < 0) die(`${label}: keine Header-Zeile gefunden — Format prüfen (erste Zeile: ${lines[0].slice(0,120)})`);
  const head = lines[headIdx].split(delim).map(h => h.trim().toLowerCase());

  // Datum: entweder eine Datums-Spalte oder Tag/Monat/Jahr getrennt
  const dateIdx = head.findIndex(h => /datum/.test(h));
  const tagIdx = head.findIndex(h => h === 'tag');
  const monatIdx = head.findIndex(h => h === 'monat');
  const jahrIdx = head.findIndex(h => h === 'jahr');
  const splitDate = dateIdx < 0 && tagIdx >= 0 && monatIdx >= 0 && jahrIdx >= 0;
  if (dateIdx < 0 && !splitDate) die(`${label}: keine Datums-Spalte(n) — Header: ${head.join(' | ')}`);

  // Gewinnzahlen: entweder 6 einzelne Spalten ODER eine Kombi-Spalte "Gewinnzahlen"
  const numIdx = [];
  for (let k = 1; k <= 6; k++) {
    const i = head.findIndex(h =>
      new RegExp(`^(lotto)?(gewinn)?zahl[ _-]?${k}$`).test(h) ||      // Zahl1, Gewinnzahl 1
      new RegExp(`^${k}\\.?\\s*(lotto|gewinn)?zahl$`).test(h) ||      // 1. Zahl
      h === 'z' + k
    );
    if (i < 0) break;
    numIdx.push(i);
  }
  // Kombi-Modus (WestLotto-Archiv): Spalte "Gewinnzahlen" enthält alle 6 Zahlen;
  // ggf. sind sie in den Datenzeilen auch auf mehrere Felder verteilt — der Header
  // bleibt dabei kürzer als die Datenzeile, das gleichen wir pro Zeile aus.
  const gzIdx = numIdx.length === 6 ? -1 : head.findIndex(h => /^gewinnzahlen$/.test(h) || /^zahlen$/.test(h));
  if (numIdx.length !== 6 && gzIdx < 0)
    die(`${label}: weder 6 Zahlen-Spalten noch eine "Gewinnzahlen"-Spalte gefunden — Header: ${head.join(' | ')}`);
  // Superzahl: "Superzahl" oder Kurzform "S"; Zusatzzahl (ZZ)/Spiel77/Super6 ignoriert
  const szIdx = head.findIndex(h => /superzahl/.test(h) || h === 's');
  log(`${label}: Header Zeile ${headIdx+1}, Trennzeichen "${delim}", Datum→${splitDate?'Tag/Monat/Jahr':dateIdx}, Zahlen→${gzIdx>=0?`Kombi-Spalte ${gzIdx}`:`[${numIdx}]`}, Superzahl→${szIdx<0?'keine':szIdx}`);

  const draws = [];
  for (let li = headIdx + 1; li < lines.length; li++) {
    const f = lines[li].split(delim).map(x => x.trim().replace(/^"|"$/g, ''));
    if (f.length <= (splitDate ? jahrIdx : dateIdx)) continue;
    const iso = splitDate
      ? parseDate(`${f[tagIdx]}.${f[monatIdx]}.${f[jahrIdx]}`)
      : parseDate(f[dateIdx]);
    if (!iso) continue; // Fuß-/Leerzeilen überspringen

    // Datenzeilen können mehr Felder haben als der Header (verteilte Zahlen) —
    // Spalten NACH der Gewinnzahlen-Spalte verschieben sich entsprechend.
    const shift = gzIdx >= 0 ? Math.max(0, f.length - head.length) : 0;
    let n;
    if (gzIdx >= 0) {
      const region = f.slice(gzIdx, gzIdx + 1 + shift).join(' ');
      const found = (region.match(/\d+/g) || []).map(Number);
      if (found.length < 6) { log(`  übersprungen (keine 6 Zahlen): ${lines[li].slice(0,80)}`); continue; }
      n = found.slice(0, 6);
    } else {
      n = numIdx.map(i => parseInt(f[i], 10));
    }
    if (n.some(x => !Number.isInteger(x))) { log(`  übersprungen (Zahlen unlesbar): ${lines[li].slice(0,80)}`); continue; }
    let sz = null;
    if (szIdx >= 0) {
      const sIdx = szIdx > gzIdx && gzIdx >= 0 ? szIdx + shift : szIdx;
      const raw = f[sIdx];
      if (raw !== '' && raw != null) {
        const v = parseInt(raw, 10);
        if (Number.isInteger(v) && v >= 0 && v <= 9) sz = v;
      }
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

  // Bestehenden Feed laden (Merge-Basis). Pro Datum eine LISTE von Ziehungen:
  // Das Mittwochslotto hatte bis Dezember 2000 zwei Ziehungen pro Abend —
  // beide sind echte Ziehungen und werden erhalten.
  const DUAL_BIS = '2001-01-01';
  const byDate = new Map();
  let total = 0;
  if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    for (const dr of (prev.draws || [])) {
      if (!byDate.has(dr.d)) byDate.set(dr.d, []);
      byDate.get(dr.d).push(dr); total++;
    }
    log(`bestehender Feed: ${total} Ziehungen (Stand ${prev.meta && prev.meta.stand})`);
  }
  const prevCount = total;

  let added = 0, conflicts = 0;
  const same = (a, b) => JSON.stringify(a.n) === JSON.stringify(b.n) && a.sz === b.sz;
  for (const src of sources) {
    const parts = await loadSource(src);
    const draws = [];
    for (const part of parts) draws.push(...parseCsv(part.text, part.name.slice(0, 40)));
    for (const dr of draws) {
      const err = checkDraw(dr);
      if (err) die(`ungültige Ziehung am ${dr.d}: ${err} → ${JSON.stringify(dr)}`);
      const list = byDate.get(dr.d) || [];
      if (list.some(x => same(x, dr))) continue;            // exakt vorhanden → überspringen
      if (list.length === 0) { list.push(dr); added++; }
      else if (dr.d < DUAL_BIS && list.length < 2) { list.push(dr); added++; } // 2. Mittwochsziehung
      else {
        conflicts++;
        console.warn(`⚠ Konflikt am ${dr.d}: vorhanden ${JSON.stringify(list)} vs. neu ${JSON.stringify(dr)} — Quelle übernimmt`);
        list.length = 0; list.push(dr);
      }
      byDate.set(dr.d, list);
    }
  }

  const all = [...byDate.entries()].sort((a,b) => a[0] < b[0] ? -1 : 1).flatMap(e => e[1]);
  const dualDays = [...byDate.values()].filter(l => l.length === 2).length;
  if (dualDays) log(`${dualDays} Termine mit zwei Ziehungen (Mittwochslotto bis 2000) erhalten`);
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
