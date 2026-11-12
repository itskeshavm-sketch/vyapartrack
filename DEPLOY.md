# Deploy VyaparTrack to Render (5 minutes)

The hosted server handles WhatsApp and order parsing for the Android app. Render's free tier is enough for a demo.

## 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "VyaparTrack"
```

Create an empty repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/vyapartrack.git
git branch -M main
git push -u origin main
```

## 2. Create the Render service

1. Go to **https://render.com** and sign up with GitHub.
2. Click **New + → Web Service** and select your `vyapartrack` repo.
3. Render detects `render.yaml` and pre-fills the configuration. Confirm:
   - **Root Directory:** repository root (leave blank / `.`)
   - **Build Command:** `npm install --no-audit --no-fund`
   - **Start Command:** `node server/server.js`
   - **Health Check Path:** `/api/health`
   - **Plan:** Free
4. Add environment variables:
   - `API_TOKEN` — Render generates one automatically from `render.yaml`; or paste a strong random string
   - `AUTO_REPLY` — `false` (default). Set it to `true` only if you accept the risk of automated replies from an unofficial connection (see the Risks section in `README.md`).
   - `ALLOW_GROUP_CHATS` — `false` (default). Group messages are ignored.
5. Click **Create Web Service** and wait for the first build.

> Use the repo root, not `server/` alone: `server/server.js` imports the shared parser from `src/parser.js`.

## 3. Grab the API token and URL

When the deploy finishes, open the **Logs** tab and find:

```
API token (save it!): a1b2c3d4e5f6...
```

Copy the token. The service URL is shown at the top, e.g. `https://vyapartrack-xxxx.onrender.com`.

## 4. Point the app at your server (do not bake in the token)

Open the app's **Settings** screen and paste the server URL and the API token there. The app keeps them on the phone and sends the token in the `X-API-Token` header.

**Do not hard-code the token into the APK.** An APK is a public file: anyone who downloads it can unzip it and read the token out of `assets/dashboard/app.js` in a few seconds. A leaked token means anyone can read the shop's orders and write fake ones.

If you want to pre-fill the server URL (that part is not secret), edit `android/app/src/main/assets/dashboard/app.js`:

```js
const DEFAULT_SERVER_URL = 'https://vyapartrack-xxxx.onrender.com';
// leave DEFAULT_API_TOKEN empty - the shop types it in once
const DEFAULT_API_TOKEN = '';
```

Then rebuild from the repo root:

```bash
node scripts/pack-node.js
cd android
gradle :app:assembleDebug
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to the phone and install. You need JDK 17+, `ANDROID_HOME`, and the NDK configured in `android/app/build.gradle`.

> You do not need a local SDK: push to `main` and the **Build Android APK** GitHub Actions workflow builds the APK and attaches it to the run. The current installable build is published as a release: [VyaparTrack-2.9.2-white-debug.apk](https://github.com/itskeshavm-sketch/vyapartrack/releases/download/v2.9.2/VyaparTrack-2.9.2-white-debug.apk).

## 5. Keep the free server awake

Render free services sleep after 15 minutes without traffic. WhatsApp needs the server awake to receive messages.

- Use a free cron service such as [cron-job.org](https://cron-job.org) to request `https://vyapartrack-xxxx.onrender.com/api/health` every 10 minutes. The first request wakes the service in about 30 seconds.
- Or use a paid Render instance for always-on service.

## 6. First-time WhatsApp login

Open the app → **Settings** → **Test connection**. You should see `ok: true`.

Tap **Pairing code**, enter the WhatsApp number, and an 8-character code appears.

On the phone: **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → type the code. Done.

Every incoming order message is parsed and appears in the dashboard within a few seconds.

## Troubleshooting

- **Dashboard loads but no bot:** check `NO_BOT` is not `true`; check the Render logs for WhatsApp WebSocket errors. Some networks block `wss://web.whatsapp.com`.
- **Parser issues:** the offline parser lives in `src/parser.js`; `/api/health` returns `parser: "offline"`. No API key or network access is involved.
- **No orders after restart:** confirm the Render disk is mounted at `/opt/render/project/src/server/data`, matching `VYAPAR_DATA_DIR`/the default `server/data`.
- **401 from the API:** send `X-API-Token` with the token printed in the logs.
