# lotto-daten-feed — offizieller 6aus49-Datenfeed für den Tipp-Generator

Dieses Mini-Repo hält die historischen Lottozahlen automatisch aktuell:
Ein GitHub-Actions-Workflow lädt nach jeder Ziehung (Mi/Sa) das **offizielle
Gewinnzahlen-Archiv** (CSV, z. B. von sachsenlotto.de), validiert jede Ziehung
und veröffentlicht `docs/lotto6aus49.json` über GitHub Pages. Die Generator-App
ruft diese JSON beim Start ab — GitHub Pages liefert CORS-Header, deshalb
funktioniert das direkt aus dem Browser. Schlägt der Abruf fehl, nutzt die App
automatisch die letzten bekannten Daten (Cache → eingebettete Basis).

## Einrichtung (einmalig, ~15 Minuten)

1. **Repo anlegen:** Neues öffentliches GitHub-Repo, z. B. `lotto-daten-feed`.
   Alle Dateien aus diesem Ordner hineinladen (inkl. `.github/`-Ordner!).

2. **CSV-Quelle eintragen:** Auf sachsenlotto.de → *Zahlen & Quoten →
   Gewinnzahlen → Download-Archiv* die Spielart **LOTTO 6aus49** und Format
   **CSV** wählen. Rechtsklick auf „Download starten" → **Link-Adresse
   kopieren** und in `convert.js` bei `CSV_SOURCES` eintragen.
   (Falls der Link dynamisch ist: Browser-Entwicklertools → Netzwerk-Tab →
   Download auslösen → URL der CSV-Anfrage kopieren. WestLotto geht analog.)

3. **Erstbefüllung testen:** Im Repo → Tab *Actions* → Workflow
   „Lotto-Daten aktualisieren" → **Run workflow**. Im Log prüfen, wie viele
   Ziehungen gelesen wurden. Reicht das offizielle Archiv nicht bis 1955
   zurück, einmalig lokal seeden:
   `node convert.js --file vollarchiv.csv` und die entstandene
   `docs/lotto6aus49.json` mit committen — danach hält der Workflow per
   Merge alles aktuell (bestehende Ziehungen werden nie gelöscht).

4. **GitHub Pages aktivieren:** Repo → *Settings → Pages* →
   Source: **Deploy from a branch**, Branch **main**, Ordner **/docs**.
   Nach ~1 Minute ist der Feed erreichbar unter:
   `https://DEIN-NAME.github.io/lotto-daten-feed/lotto6aus49.json`

5. **App verbinden:** In `Lotto6aus49V5.html` oben im Skript bei
   `DATA_FEED_URLS` die Pages-URL eintragen. Fertig — die App zeigt rechts
   oben den Datenstand (grün = frisch abgerufen, gelb = Cache,
   grau = eingebettete Basis) und hat einen ↻-Button für manuelle Abrufe.

## Zeitplan

Der Workflow läuft Mi & Sa ca. 23:45 (dt. Zeit) sowie als Sicherheitslauf am
Folgetag früh — falls die Quelle ihr Archiv verzögert aktualisiert. Gibt es
keine neuen Ziehungen, wird nichts committet.

## Datenformat des Feeds

```json
{
  "meta": { "quelle": "…", "stand": "2026-06-10", "ziehungen": 5012, "generiert": "…" },
  "draws": [ { "d": "1955-10-09", "n": [3,12,13,16,23,41], "sz": null }, … ]
}
```

Die App aggregiert FREQ/Superzahl **selbst aus den Rohziehungen** und prüft:
6 eindeutige Zahlen 1–49 pro Ziehung, Superzahl 0–9 (erst ab 04.12.1991),
keine doppelten Daten, ≥5000 Ziehungen, Plausibilität jeder Häufigkeit (±6σ).
Ungültige Feeds werden verworfen — die letzten bekannten Daten bleiben aktiv.

## Lokal testen

```
node convert.js --file fixtures/beispiel-sachsenlotto.csv --out /tmp/test.json
```

Hinweis: privater Gebrauch der offiziellen Download-Angebote; bitte fair
abrufen (der Workflow lädt nur 2–4× pro Woche).
