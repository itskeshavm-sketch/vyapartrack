// WhatsApp connection via zapo-js (independent TypeScript implementation of
// the WhatsApp Web protocol). Replaced Baileys in Sept 2026 because WhatsApp's
// server started silently rejecting Baileys' pairing-code registration crypto
// (Stage-3 companion_finish) while QR kept working - zapo's pairing-code flow
// is implemented against the current protocol and works with a single phone.
//
// Login works two ways:
//  - QR code (shown in dashboard as an image - for desktop use)
//  - Pairing code (8 chars - for a single phone: WhatsApp > Linked Devices >
//    Link a Device > "Link with phone number instead" > type the code)
//
// Session is persisted in a SQLite file, so linking happens only once.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const QRCode = require('qrcode');
const pino = require('pino');
const { WaClient, createStore } = require('zapo-js');
const { createSqliteStore } = require('@zapo-js/store-sqlite');
const { extract } = require('./extractor');
const store = require('./store');

// Session db can be overridden (Android APK stores it outside the bundled engine)
const STORE_PATH = process.env.VYAPAR_AUTH_DB || path.join(__dirname, '..', 'auth', 'zapo.db');

let client = null;
let connectPromise = null;

// phone jid -> saved WhatsApp contact name (from the user's address book).
// Persisted to disk: the address book sync delivers names only once (at
// pairing), so the in-memory map must survive engine restarts.
const CONTACTS_FILE = path.join(__dirname, '..', 'data', 'contacts.json');
const contactNames = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  for (const [k, v] of saved.contactNames || []) contactNames.set(k, v);
} catch { /* first run or corrupted file - start empty */ }
let contactsSaveTimer = null;
function persistContacts() {
  if (contactsSaveTimer) return;
  contactsSaveTimer = setTimeout(() => {
    contactsSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify({
        contactNames: [...contactNames.entries()],
        lidToPn: [],
      }));
    } catch (e) { console.error('[bot] contacts persist failed:', e.message); }
  }, 2000);
}

/** WhatsApp reports masked phones ("+91………39") as display names - never treat those as names. */
function isMaskedName(name) { return /[•…]/.test(String(name || '')); }

/**
 * Sender display: saved contact name -> real phone number. zapo resolves LID
 * jids to phone jids internally, so `senderJid` is always a phone-based jid.
 */
function resolveSenderName(senderJid, pushName) {
  const saved = contactNames.get(senderJid) || null;
  if (saved && !isMaskedName(saved)) return saved;
  const digits = String(senderJid).split('@')[0].replace(/\D/g, '');
  return digits ? '+' + digits : senderJid;
}

let botStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  pairingCode: null,
  pairingExpiresAt: null,
  lastError: null,
};

const PAIRING_CODE_TTL_MS = 150000; // rough validity estimate for the countdown
let pairingCodeAt = 0;
let pairingReady = false;   // server-side pairing screen is up (auth_pairing_required seen)
let pairingWaiter = null;   // resolve() called when pairing becomes possible
let reconnectAttempts = 0;  // exponential backoff counter for non-logout closes

function notePairingCode(code) {
  pairingCodeAt = Date.now();
  botStatus.pairingCode = code;
  botStatus.pairingExpiresAt = new Date(pairingCodeAt + PAIRING_CODE_TTL_MS).toISOString();
}

function getStatus() {
  return { ...botStatus };
}

function resetLinkState() {
  botStatus.qrDataUrl = null;
  botStatus.pairingCode = null;
  botStatus.pairingExpiresAt = null;
}

async function startBot(onOrderRecorded) {
  botStatus.connecting = true;
  botStatus.lastError = null;

  // The SQLite store cannot create missing parent directories itself - and on
  // a fresh clone/Render deploy the auth dir doesn't exist yet.
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

  const zapoStore = createStore({
    backends: { sqlite: createSqliteStore({ path: STORE_PATH }) },
    providers: {
      auth: 'sqlite', signal: 'sqlite', senderKey: 'sqlite', appState: 'sqlite',
      preKey: 'sqlite', session: 'sqlite', identity: 'sqlite',
      messages: 'none', threads: 'none', contacts: 'none', privacyToken: 'sqlite',
    },
  });

  const logger = pino({ level: process.env.WA_DEBUG === '1' ? 'debug' : 'error' });
  client = new WaClient({ store: zapoStore, sessionId: 'default', logger });

  // QR fallback: rendered into the dashboard whenever the device is unpaired
  client.on('auth_qr', async ({ qr }) => {
    try {
      botStatus.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
      botStatus.connected = false;
      botStatus.connecting = true;
      console.log('[bot] QR ready - scan it from the dashboard, or use a pairing code');
    } catch (err) {
      console.error('[bot] QR render failed:', err.message);
    }
  });

  // The server-side pairing screen is up: minting a code is now possible
  client.on('auth_pairing_required', ({ forceManual }) => {
    pairingReady = true;
    if (forceManual) console.log('[bot] QR budget exhausted - use a pairing code to link');
    if (pairingWaiter) { pairingWaiter(); pairingWaiter = null; }
  });

  client.on('auth_paired', ({ credentials }) => {
    botStatus.connected = true;
    botStatus.connecting = false;
    botStatus.qrDataUrl = null;
    botStatus.pairingCode = null;
    botStatus.pairingExpiresAt = null;
    pairingReady = false;
    console.log('[bot] WhatsApp paired:', credentials?.meJid || 'ok');
  });

  client.on('connection', async (event) => {
    if (event.status === 'open') {
      botStatus.connected = true;
      botStatus.connecting = false;
      botStatus.qrDataUrl = null;
      botStatus.pairingCode = null;
      botStatus.pairingExpiresAt = null;
      botStatus.lastError = null;
      pairingReady = false;
      reconnectAttempts = 0; // backoff resets on a healthy connection
      console.log('[bot] WhatsApp connected. Listening for orders...');
      return;
    }
    // status === 'close'
    botStatus.connected = false;
    botStatus.connecting = false;
    resetLinkState();
    pairingCodeAt = 0;
    pairingReady = false;
    try { client.disconnect(); } catch {}
    if (event.isLogout) {
      // Device was unlinked - the persisted session is useless. Wipe the DB so
      // the next start presents a fresh linkable session.
      reconnectAttempts = 0;
      botStatus.lastError = 'Previous link expired - get a new code';
      console.warn('[bot] closed: logged out - wiping session db');
      try {
        fs.rmSync(STORE_PATH, { force: true });
        for (const suffix of ['-wal', '-shm']) fs.rmSync(STORE_PATH + suffix, { force: true });
      } catch (e) { console.error('[bot] session wipe failed:', e.message); }
      setTimeout(() => startBot(onOrderRecorded).catch(() => {}), 5000);
    } else {
      // Exponential backoff: 5s, 10s, 20s... capped at 5 min. A tight reconnect
      // loop hammers WhatsApp and looks like abuse.
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      const delay = Math.min(300000, 5000 * Math.pow(2, reconnectAttempts - 1));
      botStatus.lastError = 'Connection lost - reconnecting...';
      console.warn(`[bot] closed: ${event.reason || event.code || 'unknown'} - reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
      setTimeout(() => startBot(onOrderRecorded).catch(() => {}), delay);
    }
  });

  client.on('message', async (event) => {
    try {
      const key = event.key || {};
      const chatJid = String(key.remoteJid || '');
      if (!chatJid || key.fromMe) return;
      if (chatJid === 'status@broadcast' || chatJid.endsWith('@broadcast') || chatJid.endsWith('@newsletter')) return;

      const proto = event.message || {};
      const text =
        proto.conversation ||
        proto.extendedTextMessage?.text ||
        proto.imageMessage?.caption ||
        '';
      if (!text) return;

      // Ignore messages that are mostly links (spam/marketing)
      const linkCount = (text.match(/https?:\/\//gi) || []).length;
      if (linkCount >= 1 && text.replace(/https?:\/\/\S+/gi, '').trim().length < 20) return;

      // zapo resolves LID jids to phone jids internally, but masked senders
      // (not saved in contacts) still arrive as @lid. The real phone number
      // rides in remoteJidAlt/participantAlt - prefer it when it's a phone jid.
      const alt = key.remoteJidAlt || key.participantAlt;
      const senderJid = String((alt && alt.endsWith('@s.whatsapp.net') ? alt : (key.participant || chatJid)));
      const senderName = resolveSenderName(senderJid, event.pushName);

      const order = await extract(text);
      if (!order) return;

      const record = store.addOrder({ ...order, customer: senderName || order.customer, source: 'whatsapp' });
      console.log(`[bot] Order tracked: ${record.customer} | ${record.quantity ?? ''}${record.unit ?? ''} ${record.item} | cost ${record.costPrice ?? '-'} | profit ${record.profitAmount ?? '-'} (${record.profitPercent ?? '-'}%) | total ${record.totalAmount ?? '-'}`);
      if (onOrderRecorded) onOrderRecorded(record);

      if (process.env.AUTO_REPLY !== 'false') {
        await client.message.send(chatJid, {
          type: 'text',
          text:
            `✅ *Order tracked*\n` +
            `📦 ${record.quantity ?? '-'}${record.unit ? ' ' + record.unit : ''} ${record.item}\n` +
            `💰 Cost: ₹${record.costPrice ?? '-'} | Profit: ₹${record.profitAmount ?? '-'}${record.profitPercent != null ? ` (${record.profitPercent}%)` : ''}\n` +
            `🧾 Total: ₹${record.totalAmount ?? '-'}`,
          contextInfo: {
            quotedMessageId: key.id,
            quotedParticipant: key.participant || chatJid,
            quotedRemoteJid: chatJid,
            quotedMessage: proto,
          },
        });
      }
    } catch (err) {
      console.error('[bot] message handler error:', err.message);
    }
  });

  // connect() resolves only after the device is paired; run it in the
  // background and surface pairing prompts via the auth_* events above.
  connectPromise = client.connect().then(() => {
    botStatus.connected = true;
    botStatus.connecting = false;
  }).catch((err) => {
    botStatus.connecting = false;
    botStatus.lastError = err?.message || String(err);
    console.error('[bot] connect failed:', err?.message || err);
  });

  return client;
}

/** Generate a pairing code for "Link with phone number" login (phone: 10-digit Indian number or with country code). */
async function requestPairingCode(phoneRaw) {
  if (!client) throw new Error('Bot not started yet');
  let phone = String(phoneRaw).replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone; // assume Indian number
  if (phone.length < 11) throw new Error('Invalid phone number');
  console.log(`[bot] pairing code requested for +${phone}`);

  // Same code minted <60s ago -> hand it back (a re-tap must not invalidate a
  // code the user may be entering)
  if (botStatus.pairingCode && Date.now() - pairingCodeAt < 60000) {
    return botStatus.pairingCode;
  }

  // Mint once per click. WhatsApp rate-limits pairing requests (429
  // rate-overlimit) and ANY retry extends the window - so surface the error
  // instead of auto-retrying. The user waits a few minutes and clicks again.
  if (!client) throw new Error('Bot not started yet');
  if (client.connected) throw new Error('Already paired - unlink the device first to re-link');
  try {
    const code = await client.auth.requestPairingCode(phone);
    console.log(`[bot] pairing code minted for +${phone}: ${code}`);
    notePairingCode(code);
    return code;
  } catch (err) {
    const msg = String(err?.message || err);
    console.error(`[bot] pairing code request failed: ${msg}`);
    if (/rate-overlimit|429/i.test(msg)) {
      throw new Error('WhatsApp is rate-limiting pairing attempts for this account. Wait at least 30 minutes (a few hours is safer), then click Get code again.');
    }
    throw err;
  }
}

module.exports = { startBot, getStatus, requestPairingCode };
