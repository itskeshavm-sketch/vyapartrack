# VyaparTrack — WhatsApp Business Tracker 🇮🇳

**Turn messy WhatsApp order messages into a live profit ledger — right on your phone.**

[![Download the Android APK](https://img.shields.io/badge/Download-Android%20APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/itskeshavm-sketch/vyapartrack/raw/main/VyaparTrack-v2.3-onetap-debug.apk)

```
"Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees"
        ↓
Mayank · 500 g Ladoo · Cost ₹200 · Profit ₹30 (15%) · Total ₹230
```

## 📱 Quick start (Android)

**No terminal. No server. No API key. No setup.**

1. **[Download the APK](https://github.com/itskeshavm-sketch/vyapartrack/raw/main/VyaparTrack-v2.3-onetap-debug.apk)** — `VyaparTrack-v2.3-onetap-debug.apk`
2. Open the downloaded file on your Android phone.
3. Allow **"Install unknown apps"** if Android asks, then tap **Install**.
4. Open **VyaparTrack**. If the server dialog appears, tap **Close** — the app runs fully offline.
5. Tap **Load demo data** to see the dashboard populated instantly.

The dashboard, parser, and order storage run **on the phone**, so the demo works offline and business data never leaves the device. Type or paste an order into **Add / Test order**, then tap the share icon to send a confirmation to WhatsApp.

To auto-track incoming WhatsApp messages, connect the app to the hosted server: deploy it with `DEPLOY.md`, then paste the server URL and API token into **Settings**. Live WhatsApp tracking is a server feature; the offline APK handles manual orders, pricing, profit, and sharing by itself.

> **Demo tip:** load the sample orders before judging. They carry a **DEMO** badge so sample revenue is never confused with real business.

## 💻 Run on desktop (optional, for development)

Requires **Node.js 22 or newer** and Git. Run these two lines in **PowerShell or CMD** — the first downloads the repo, the second installs dependencies and starts the local dashboard + API server:

```cmd
git clone https://github.com/itskeshavm-sketch/vyapartrack.git
cmd /c "cd vyapartrack && npm install && npm run start:demo"
```

Open **http://localhost:3000**. `start:demo` runs the dashboard only, disables WhatsApp, uses the offline parser, and seeds four sample orders on first run.

To start fresh, delete `data/orders.json` and run `npm run start:demo` again.

## Full mode (dashboard + WhatsApp)

```bash
npm install
copy .env.example .env      # Windows
# cp .env.example .env      # macOS / Linux
npm start
```

Open **http://localhost:3000**. Without a WhatsApp link the dashboard still works normally.

- **Pair with a phone number (recommended):** enter the shop's number in the dashboard, request an 8-character code, then on the phone open **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** and type the code.
- **Or scan the QR** shown on the dashboard from the phone.
- The session is persisted, so pairing is a one-time step.
- `NO_BOT=true` in `.env`, or `NO_BOT=true npm start`, runs dashboard-only mode.

The WhatsApp network connection itself requires outbound WebSocket access to `web.whatsapp.com`. On restricted networks the dashboard will run but pairing cannot complete.

## How orders are read

Every message is parsed by the **built-in offline parser** in `src/parser.js`. There is no AI service, no API key, and no network call — the same parser runs on the desktop, in the hosted server, and on the phone. It never stops tracking because an external service is down.

The offline parser handles:

- Hinglish and informal phrasing: `sold 1kg kaju katli to sharma uncle, cost 850, profit 20%`
- Bare quantities with an intent word: `bhai 10 laddu chahiye`
- Spoken fractions: `aadha kilo besan`, `dedh kg doodh`
- Native scripts and native digits — Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Urdu — for example:
  - `500 ग्राम लड्डू चाहिए`
  - `2 ಕಿಲೋ ಅಕ್ಕಿ ಬೇಕು`
  - `1 కిలో పంచదార కావాలి`
  - `500 கிராம் பருப்பு வேண்டும்`

## Dashboard

- Stat cards: orders, revenue, profit + average margin, cost
- Money cards split demo sample data from real data
- Orders table with source labels, timestamps, and delete
- **Add / Test order** box: paste any message to see it parsed live
- One-click sample messages, including a native-script example
- "Load demo data" for an instant populated dashboard
- Auto-refresh

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Dashboard/API port |
| `NO_BOT` | `false` | `true` = dashboard only, never connect to WhatsApp |
| `AUTO_REPLY` | `true` | Send a short order confirmation to the customer |
| `VYAPAR_DATA_DIR` | `./data` | Where orders/contacts are stored |

All order parsing is local and deterministic, so there are no AI keys or model settings to configure. Keep `.env` out of git.

## Tests

```bash
npm test
```

This runs:

- `npm run test:parser` — parser cases (Hinglish, fractions, native scripts, pricing, intent handling)
- `npm run test:smoke` — end-to-end API test against an isolated temporary data directory

The smoke test never touches your real `data/orders.json`.

## REST API (dashboard server)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, parser, bot }` |
| GET | `/api/status` | — | WhatsApp pairing/connection status |
| POST | `/api/pair` | `{ "phone": "9876543210" }` | `{ code }` |
| GET | `/api/orders` | — | all orders |
| POST | `/api/orders` | `{ "text": "500g ladoo chahiye" }` | parsed order |
| DELETE | `/api/orders/:id` | — | `{ deleted: true }` |
| GET | `/api/stats` | — | `{ totalOrders, revenue, cost, profit, avgMarginPct }` |
| POST | `/api/demo` | — | seeds sample orders |

## Deploying the hosted server

`render.yaml` deploys the WhatsApp server (`server/server.js`) from the repo root. The server exposes the same order pipeline over REST and keeps its data in `server/data/`.

```bash
npm install
API_TOKEN=choose-a-strong-token PORT=3001 node server/server.js
```

The server prints its API token on first boot; protected endpoints use the `X-API-Token` header. On Render, `API_TOKEN` is generated automatically and the `/api/health` endpoint is used for health checks. See `DEPLOY.md` for the walkthrough.

## Build the Android app yourself

The prebuilt **`VyaparTrack-v2.3-onetap-debug.apk`** is the offline WebView client: local parser, demo data, profit dashboard, and WhatsApp sharing. It does not auto-read incoming WhatsApp messages without the hosted server.

The newer `android/` source (engine v2.7) contains the on-phone engine work:

- It embeds the on-phone Node engine and serves the dashboard in a WebView at `http://127.0.0.1:3000`, so it can work offline and keep data on the device.
- Orders and WhatsApp session data live in app-private storage.
- Login uses the pairing-code flow because a phone cannot scan its own QR.

Rebuild after engine changes:

```bash
node scripts/pack-node.js
cd android
gradle :app:assembleDebug
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`. This needs JDK 17+, `ANDROID_HOME`, and the NDK configured in `android/app/build.gradle`. The committed APK is an older debug build; rebuild for the latest parser and dashboard.

## Project layout

```
src/
  index.js       desktop/host entry point (dashboard + optional bot)
  server.js      Express REST API + dashboard
  bot.js         zapo-js WhatsApp connection, pairing code/QR, message listener
  extractor.js   thin wrapper around the offline parser
  parser.js      shared offline parser (Hinglish + native scripts)
  store.js       JSON persistence + stats
public/          dashboard (HTML/CSS/JS)
scripts/         demo launcher, parser tests, smoke test, seeders
server/          standalone hosted WhatsApp server (Render)
android/         Android app source and on-phone engine
```
