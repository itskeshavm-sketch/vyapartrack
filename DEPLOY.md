# Deploy VyaparTrack server to Render (5 minutes)

The Android app needs a small server to handle WhatsApp + Poolside AI. Render's free tier is enough.

## 1. Push the repo to GitHub

You need a GitHub account. From a terminal in the project root:

```bash
git init
git add .
git commit -m "VyaparTrack"
```

Then create an empty repo on github.com (e.g., `vyapartrack`) and:

```bash
git remote add origin https://github.com/YOUR_USERNAME/vyapartrack.git
git branch -M main
git push -u origin main
```

## 2. Create the Render service

1. Go to **https://render.com** → sign up with GitHub.
2. Click **New +** → **Web Service** → select your `vyapartrack` repo.
3. Render auto-detects `render.yaml` at the repo root and pre-fills the config. Confirm:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Scroll to **Environment Variables** and add:
   - `POOLSIDE_API_KEY` = `sky_Enz4ISLy.cSr8KUk3ySWAFyf9OYROfBRbFuFPs1l5`
   - (others are pre-filled from `render.yaml`)
5. Click **Create Web Service**. Wait ~3 min for the first build.

## 3. Grab the API token and URL

When the deploy finishes, the **Logs** tab shows a line like:

```
API token (save it!): a1b2c3d4e5f6...
```

Copy that token. Your server URL is shown at the top: `https://vyapartrack-xxxx.onrender.com`.

## 4. Bake the values into the APK (so users don't see Settings)

Edit `android/app/src/main/assets/dashboard/app.js` and set:

```js
const DEFAULT_SERVER_URL = 'https://vyapartrack-xxxx.onrender.com';
const DEFAULT_API_TOKEN = 'a1b2c3d4e5f6...';
```

Then build the APK (in the project root):

```bash
cd android
gradle :app:assembleDebug
```

APK lands at `android/app/build/outputs/apk\debug/app-debug.apk`. Copy it to the phone and install.

## 5. Keep the server awake (free tier sleeps after15 min idle)

Free Render services sleep after 15 min of no traffic. WhatsApp needs the server awake to receive messages. Two options:

- **Free cron ping:** Use a free service like [cron-job.org](https://cron-job.org) to hit `https://vyapartrack-xxxx.onrender.com/api/health` every 10 min. The server wakes in ~30s on first request.
- **Paid Render plan ($7/mo):** the service never sleeps. Worth it if you use WhatsApp actively.

## 6. First-time WhatsApp login from the app

Open the app on your phone → tap ⚙ **Settings** (or first-launch prompt) → **Test connection** → should say `✅ Connected — WhatsApp: waiting · AI: on`.

Then tap the **Pairing code** button in the dashboard, enter your WhatsApp number → an 8-character code appears.

On your phone's WhatsApp: **Settings → Linked Devices → Link a Device → "Link with phone number instead"** → type the code. Done.

Every incoming order message gets parsed by Poolside and appears in the dashboard within a few seconds.