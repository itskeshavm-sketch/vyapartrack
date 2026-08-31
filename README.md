# VyaparTrack — WhatsApp Business Tracker 🇮🇳

Connects to a vendor's WhatsApp and **automatically tracks business orders** — customer, item, quantity, cost, profit %, profit ₹ and total — into a beautiful dashboard. Built for local Indian businesses that run entirely on WhatsApp.

```
"Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees"
        ↓ automatically becomes ↓
Mayank · 500 g Ladoo · Cost ₹200 · Profit ₹30 (15%) · Total ₹230
```

## Quick start (desktop)

```bash
npm install
copy .env.example .env      # then paste your Poolside API key inside
npm start
```

1. Open **http://localhost:3000**
2. Connect WhatsApp (one-time, session is saved):
   - **On your phone (recommended):** enter your number → get an 8-character code → WhatsApp → *Settings → Linked Devices → Link a Device* → **"Link with phone number instead"** → type the code.
   - **On a computer:** scan the QR shown on the dashboard from the phone.
3. Done. Every incoming order message is now tracked automatically, and the customer gets a ✅ confirmation reply.

> `NO_BOT=true npm start` runs dashboard-only mode (no WhatsApp).

## How orders are read

Every incoming message first goes through **Poolside AI** (`poolside/laguna-xs-2.1`) for extraction; if the API is unreachable or the key is missing, a built-in offline regex parser takes over — the tool never stops tracking.

Handles informal/Hinglish phrasing too:
- `sold 1kg kaju katli to sharma uncle, cost 850, profit 20%`
- `ravi kirana ne 5kg namkeen mange, cost 400, profit 18%`

## Dashboard

- Stat cards: total orders, revenue, profit (₹ + avg margin %), cost spent
- Orders table with delete, auto-refresh
- "Add / Test order" box — paste any order message to see it parsed live
- "Load demo data" to preview instantly

## Poolside configuration (`.env`)

| Variable | Default |
|---|---|
| `POOLSIDE_API_KEY` | — (required for AI parsing) |
| `POOLSIDE_MODEL` | `poolside/laguna-xs-2.1` |
| `POOLSIDE_BASE_URL` | `https://api.poolside.ai/v1` (override if docs differ) |

The key is read only from `.env` — never hardcoded, never logged.

## Tests

```bash
npm run test:parser   # regex parser checks (incl. the flagship Mayank example)
node scripts/smoke.js # full API end-to-end test
```

## Android APK

**`VyaparTrack-v1.0-debug.apk`** (project root, ~160 MB) is a full standalone app:

- Embedded Node.js runtime (nodejs-mobile `libnode`) runs the same engine on-device
- WebView dashboard served on `localhost:3000` inside the phone — works offline, data never leaves the device
- Orders + WhatsApp session stored in app-private storage, **survive app updates**
- Foreground service keeps tracking alive while the app is backgrounded
- Login uses the **pairing code** flow (a phone can't scan its own QR): enter number → 8-char code → WhatsApp → Linked Devices → Link with phone number

Install: copy the APK to the phone → open it (allow "install unknown apps") → sign in with the pairing code.

Rebuild after engine changes:

```bash
node scripts/pack-node.js                     # repack engine into android assets
cd android
gradle :app:assembleDebug                     # needs JDK 17+, ANDROID_HOME, NDK (see app/build.gradle)
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`.

⚠️ **Disclaimer:** linking a personal WhatsApp via Baileys is unofficial (same mechanism as WhatsApp Web). For heavy/production use, consider the official WhatsApp Business Cloud API. Use responsibly — vendor's own account, vendor's own data, stored locally.

## Project layout

```
src/
  index.js       entry point (dashboard + bot)
  bot.js         Baileys connection, QR + pairing-code login, message listener
  extractor.js   AI-first, regex-fallback extraction
  parser.js      offline regex parser
  poolside.js    Poolside API client (laguna-xs-2.1)
  store.js       JSON persistence + stats
  server.js      Express REST API
public/          dashboard (HTML/CSS/JS)
scripts/         parser tests, API smoke test, demo seeder
```
