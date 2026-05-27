# CaRadar

Willhaben-Fahrzeug-Alert-Dienst: überwacht öffentliche Inserate auf willhaben.at
anhand benutzerdefinierter Kriterien und sendet passende Treffer per Telegram.
Konfiguration und Steuerung über ein lokales Web-UI.

## Voraussetzungen

- **Node.js** ≥ 18
- **PM2** (global): `npm install -g pm2`
- **Playwright-Browser** (einmalig nach `npm install`): `npx playwright install chromium`
- Ein **Telegram-Bot-Token** (via [@BotFather](https://t.me/BotFather))

## Installation

```bash
git clone <repo-url>
cd caradar
npm install
npx playwright install chromium
```

## Konfiguration

Lege eine Datei `.env` im Projektverzeichnis an:

```env
TELEGRAM_TOKEN=<dein-bot-token-von-@BotFather>
TELEGRAM_CHAT_ID=<optionale-fallback-chat-id>
CARADAR_PASSWORD=<starkes-passwort-fürs-web-ui>
CARADAR_SECRET=<langer-zufallsstring-fürs-session-token>
```

`CARADAR_PASSWORD` und `CARADAR_SECRET` **müssen** gesetzt sein — sonst
beendet sich `server.js` beim Start. `CARADAR_SECRET` sollte mindestens
32 Zufallszeichen lang sein (z. B. `openssl rand -hex 32`).

## Start

Scraper und UI werden separat über PM2 betrieben:

```bash
# Scraper-Loop (4–7 min Intervall)
pm2 start scraper.js --name caradar

# Web-UI auf http://localhost:3000
pm2 start server.js --name caradar-ui
```

Lokales Ausprobieren ohne PM2:

```bash
npm start        # Scraper
npm run ui       # UI (Restart-/Stop-Buttons brauchen aber PM2)
```

Die UI erwartet, dass der Scraper-Prozess unter PM2 den Namen `caradar` trägt.

## Bedienung

1. UI öffnen → mit `CARADAR_PASSWORD` einloggen.
2. Telegram-Chat-ID hinterlegen (Anleitung im UI), Test-Alert senden.
3. Suchkriterien eingeben → **Alert starten**. Der Scraper läuft danach
   selbständig und meldet neue Inserate per Telegram.

## Dateien (Runtime-State)

Werden automatisch erzeugt und sind in `.gitignore`:

| Datei                | Zweck                                            |
| -------------------- | ------------------------------------------------ |
| `config.json`        | Aktuelle Suchkriterien                           |
| `user-config.json`   | Telegram-Chat-ID                                 |
| `seen.json`          | Gesehene Inserats-IDs (Dedup), Tageszähler       |
| `sent.json`          | Bereits per Telegram gemeldete IDs               |
| `scraper-mode.json`  | running / paused / stopped / resuming            |
| `lastAlert.json`     | Letzter gesendeter Alert (für UI-Anzeige)        |
| `alertHistory.json`  | Letzte 5 Alerts                                  |
| `browser-state.json` | Playwright-Storage (Cookie-Consent)              |

## Lizenz

ISC
