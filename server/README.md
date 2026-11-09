# VyaparTrack server

Node.js + zapo-js + offline order parser backend for the Android app and hosted dashboard.

## What it does

- Connects to WhatsApp via **zapo-js** (incoming message tracking, QR + pairing-code login)
- Parses each message with the shared **offline parser** in `../src/parser.js`
- Records orders in `server/data/orders.json` and sends an auto-reply confirmation
- Exposes a REST API (`/api/orders`, `/api/stats`, `/api/status`, `/api/pair`, `/api/catalog`, `/api/pending-pricing`) protected by an `X-API-Token` header
- Serves `/api/health` without auth for uptime checks

The parser itself lives in `../src/parser.js`, shared with the desktop engine.

## Run locally

From the **repository root**, so the shared parser and root dependencies are available:

```bash
npm install
copy server/.env.example server/.env    # Windows; edit values
node server/server.js
```

On first boot the server prints an `API token` — copy it into the Android app's Settings screen.

## Deploy to Render / Railway / Fly.io

Use the repo root as the project directory, not `server/` alone, because the server imports the shared parser from `src/`. The included `render.yaml` already does this:

- **Root directory:** repository root
- **Build command:** `npm install --no-audit --no-fund`
- **Start command:** `node server/server.js`
- **Health check:** `GET /api/health`
- **Environment variables:** copy from `server/.env.example`. Set **`API_TOKEN`** to a strong random string.

Recommended hosts:

| Host | Free tier | Notes |
|---|---|---|
| [Render](https://render.com) | 750 h/month, sleeps after 15 min idle | Easiest. Connects to a GitHub repo. |
| [Railway](https://railway.app) | $5 free credit/month | Slightly more reliable. |
| [Fly.io](https://fly.io) | 3 shared VMs free | Best for always-on + low latency. |

After deploy, you get a URL like `https://vyapartrack.onrender.com`. Put that into the Android app's Settings → Server URL field along with your `API_TOKEN`.

> **Render free tier:** the service sleeps after 15 minutes without traffic. WhatsApp needs it awake to receive messages. Ping `https://your-service.onrender.com/api/health` every 10 minutes with a free cron service, or use a paid always-on instance.

## API

All endpoints except `/api/health` require header `X-API-Token: <API_TOKEN>`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, parser, botStarted }` |
| GET | `/api/status` | — | `{ connected, connecting, qrDataUrl, pairingCode, lastError, parser }` |
| POST | `/api/pair` | `{ "phone": "9876543210" }` | `{ code, expiresIn }` |
| GET | `/api/orders` | — | `[ {...order}, ... ]` |
| POST | `/api/orders` | `{ "text": "..." }` | created order |
| DELETE | `/api/orders/:id` | — | `{ deleted: bool }` |
| POST | `/api/demo` | — | seeds demo orders |
| GET | `/api/stats` | — | `{ totalOrders, revenue, cost, profit, avgMarginPct }` |
| GET/POST | `/api/catalog` | item fields | item catalog |
| DELETE | `/api/catalog/:id` | — | `{ deleted: bool }` |
| GET | `/api/pending-pricing` | — | items awaiting prices |
| POST | `/api/pending-pricing/:id/resolve` | `{ sellPrice, costPrice?, unit?, pieceWeight?, priceQty? }` | updated catalog entry |
