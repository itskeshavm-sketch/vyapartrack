# VyaparTrack server

Node.js + Baileys + Poolside AI backend. The Android app is a thin client that talks to this server over HTTPS.

## What it does

- Connects to WhatsApp via Baileys (real incoming message tracking, QR + pairing-code login)
- Parses each incoming message with **Poolside `laguna-xs-2.1`** (falls back to a regex parser if Poolside is unreachable)
- Records every detected order to `data/orders.json`
- Sends an auto-reply confirmation back to the customer on WhatsApp
- Exposes a REST API (`/api/orders`, `/api/stats`, `/api/status`, `/api/pair`) protected by an `X-API-Token` header

## Run locally

```bash
cd server
cp .env.example .env        # then edit values
npm install
npm start
```

On first boot the server prints an `API token` to the console — copy it into the Android app's Settings screen.

## Deploy to Render / Railway / Fly.io (free tier)

The repo already has the `server/` folder. Point any Node-hosting platform at it:

- **Build command:** `cd server && npm install`
- **Start command:** `cd server && npm start`
- **Health check:** `GET /api/health`
- **Environment variables:** copy from `.env.example`. **Set `API_TOKEN` to a strong random string** — the Android app will need it.

Recommended hosts:

| Host | Free tier | Notes |
|---|---|---|
| [Render](https://render.com) | 750h/month, sleeps after 15m idle | Easiest. Connects GitHub repo. |
| [Railway](https://railway.app) | $5 free credit/month | Slightly more reliable. |
| [Fly.io](https://fly.io) | 3 shared VMs free | Best for always-on + low latency. |

After deploy, you'll get a URL like `https://vyapartrack.onrender.com`. Put that into the Android app's Settings → Server URL field along with your `API_TOKEN`.

## API

All endpoints (except `/api/health`) require header `X-API-Token: <API_TOKEN>`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, aiConfigured, aiModel, botStarted }` |
| GET | `/api/status` | — | `{ connected, connecting, qrDataUrl, pairingCode, lastError, aiConfigured, aiModel }` |
| POST | `/api/pair` | `{ "phone": "9876543210" }` | `{ code }` |
| GET | `/api/orders` | — | `[ {...order}, ... ]` |
| POST | `/api/orders` | `{ "text": "..." }` | created order |
| DELETE | `/api/orders/:id` | — | `{ deleted: bool }` |
| POST | `/api/demo` | — | seeds demo orders |
| GET | `/api/stats` | — | `{ totalOrders, revenue, cost, profit, avgMarginPct }` |