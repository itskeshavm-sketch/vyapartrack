// WhatsApp connection via Baileys (pure JS, no Chromium - runs on desktop
// AND inside the Android APK via nodejs-mobile).
//
// Login works two ways:
//  - QR code (shown in dashboard as an image - for desktop use)
//  - Pairing code (8 chars - for a single phone: WhatsApp > Linked Devices >
//    Link a Device > "Link with phone number instead" > type the code)
//
// Session is saved to disk, so linking happens only once.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const QRCode = require('qrcode');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { extract } = require('./extractor');
const store = require('./store');

// Session dir can be overridden (Android APK stores it outside the bundled engine)
const AUTH_DIR = process.env.VYAPAR_AUTH_DIR || path.join(__dirname, '..', 'auth');

let sock = null;
// jid -> saved WhatsApp contact name (from the user's address book).
// Indexed by BOTH the phone jid and the LID jid - messages may arrive as either.
// Profile names (pushName) are kept separately and never override saved names.
const contactNames = new Map();
const lidToPn = new Map();
function rememberContact(c) {
  if (!c || !c.id || !c.name || isMaskedName(c.name)) return;
  contactNames.set(c.id, c.name);
  if (c.lid) contactNames.set(c.lid, c.name);
}
function rememberLidMapping(m) {
  if (!m || !m.lid || !m.pn) return;
  if (lidToPn.get(m.lid) === m.pn) return; // already known
  lidToPn.set(m.lid, m.pn);
  const name = contactNames.get(m.lid) || contactNames.get(m.pn);
  if (name) { contactNames.set(m.lid, name); contactNames.set(m.pn, name); }
}

/** WhatsApp reports masked phones ("+91………39") as display names - never treat those as names. */
function isMaskedName(name) { return /[•…]/.test(String(name || '')); }

/**
 * Sender display: saved contact name -> real phone number. Never the WhatsApp
 * profile/display name (it's often a masked "+91………39" or a random nickname).
 */
async function resolveSenderName(jid, pushName) {
  void pushName; // intentionally unused - display names are not shown
  const pn = lidToPn.get(jid);
  const saved = contactNames.get(jid) || (pn && contactNames.get(pn)) || null;
  if (saved && !isMaskedName(saved)) return saved;
  const digits = String(jid).split('@')[0].replace(/\D/g, '');
  return digits ? '+' + digits : jid;
}
let botStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  pairingCode: null,
  pairingExpiresAt: null,
  lastError: null,
};

// Pairing codes die ~2-3 minutes after issuance on WhatsApp's side. We treat
// them as valid for 100s, reuse a still-fresh code for the same number, and
// regenerate automatically (keeper below) so the on-screen code never goes stale.
const PAIRING_CODE_TTL_MS = 100000;
let pairingPhone = null;
let pairingCodeAt = 0;
let pairingKeeperRunning = false;
let pairingKeeperStarted = false;
let pairingInflight = null;

function notePairingCode(code, phone) {
  pairingPhone = phone;
  pairingCodeAt = Date.now();
  botStatus.pairingCode = code;
  botStatus.pairingExpiresAt = new Date(pairingCodeAt + PAIRING_CODE_TTL_MS).toISOString();
}

/** Wait for the WhatsApp socket to open, then request the code. Retries through reconnects. */
async function requestCodeWithRetry(phone) {
  const deadline = Date.now() + 45000;
  let lastErr = new Error('WhatsApp connection is not ready yet');
  while (Date.now() < deadline) {
    if (!sock) throw new Error('Bot not started yet');
    if (sock.ws?.isOpen) {
      try {
        return await sock.requestPairingCode(phone);
      } catch (err) {
        lastErr = err; // socket died mid-request - wait for the auto-reconnect and try again
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw lastErr;
}

/** Keep a live pairing code on screen: re-mint it whenever it expires while unlinked. */
function startPairingKeeper() {
  if (pairingKeeperStarted) return;
  pairingKeeperStarted = true;
  setInterval(async () => {
    if (pairingKeeperRunning) return;
    if (botStatus.connected || !pairingPhone) return;
    if (botStatus.pairingCode && Date.now() - pairingCodeAt < PAIRING_CODE_TTL_MS) return;
    if (!sock || !sock.ws?.isOpen) return;
    pairingKeeperRunning = true;
    try {
      const code = await sock.requestPairingCode(pairingPhone);
      notePairingCode(code, pairingPhone);
      console.log('[bot] pairing code refreshed automatically');
    } catch { /* keeper retries on the next tick */ }
    finally { pairingKeeperRunning = false; }
  }, 10000);
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
  startPairingKeeper();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // offline / blocked network - Baileys falls back to its baked-in version
  }

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);
  // Saved contact names arrive here on first connect (full address book sync)
  sock.ev.on('messaging-history.set', ({ contacts = [], chats = [] } = {}) => {
    contacts.forEach(rememberContact);
    chats.forEach((ch) => { if (ch.name && ch.id) contactNames.set(ch.id, ch.name); });
  });
  // New/renamed contacts saved while connected
  sock.ev.on('contacts.upsert', (cs) => cs.forEach(rememberContact));
  sock.ev.on('contacts.update', (cs) => cs.forEach(rememberContact));
  // Link LID jids (how messages arrive) to phone jids (how contacts are saved)
  sock.ev.on('lid-mapping.update', rememberLidMapping);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        botStatus.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
        botStatus.connected = false;
        botStatus.connecting = true;
        botStatus.lastError = null;
        console.log('[bot] QR ready - scan it from the dashboard, or use a pairing code');
      } catch (err) {
        console.error('[bot] QR render failed:', err.message);
      }
    }

    if (connection === 'connecting') {
      botStatus.connecting = true;
    }

    if (connection === 'open') {
      botStatus = { ...botStatus, connected: true, connecting: false, qrDataUrl: null, pairingCode: null, pairingExpiresAt: null, lastError: null };
      pairingPhone = null;
      console.log('[bot] WhatsApp connected. Listening for orders...');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      botStatus.connected = false;
      botStatus.connecting = false;
      // A dead/expired pairing session surfaces as 401 loggedOut. The old auth
      // files are useless then - keeping them makes every retry fail with
      // "Connection Closed" - so wipe them and start a fresh linkable socket.
      botStatus.lastError = loggedOut ? 'Previous link expired - get a new code' : 'Connection lost - reconnecting...';
      botStatus.pairingCode = null;
      botStatus.pairingExpiresAt = null;
      pairingCodeAt = 0;
      console.warn('[bot] closed:', code, loggedOut ? '(logged out - resetting session)' : '');
      if (loggedOut) {
        resetLinkState();
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (e) { console.error('[bot] auth reset failed:', e.message); }
      }
      // Always come back up - logged-out or not, the vendor must be able to re-link.
      setTimeout(() => startBot(onOrderRecorded).catch(() => {}), loggedOut ? 2000 : 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      // Ignore newsletters/channels and broadcasts - marketing gets parsed as phantom orders
      const jid = String(msg.key.remoteJid);
      if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text) return;
      // Ignore messages that are mostly links (spam/marketing)
      const linkCount = (text.match(/https?:\/\//gi) || []).length;
      if (linkCount >= 1 && text.replace(/https?:\/\/\S+/gi, '').trim().length < 20) return;

      // Learn phone <-> LID from the message key so saved contact names resolve
      const senderAlt = msg.key.participantAlt || msg.key.remoteJidAlt;
      if (senderAlt) {
        const altIsLid = senderAlt.endsWith('@lid');
        const lid = altIsLid ? senderAlt : senderJid;
        const pn = altIsLid ? senderJid : senderAlt;
        if (lid.endsWith('@lid') && pn.endsWith('@s.whatsapp.net')) {
          rememberLidMapping({ lid, pn });
        }
      }

      const senderName = await resolveSenderName(senderJid, msg.pushName);
      const order = await extract(text);
      if (!order) return;

      const record = store.addOrder({ ...order, customer: senderName || order.customer, source: 'whatsapp' });
      console.log(`[bot] Order tracked: ${record.customer} | ${record.quantity ?? ''}${record.unit ?? ''} ${record.item} | cost ${record.costPrice ?? '-'} | profit ${record.profitAmount ?? '-'} (${record.profitPercent ?? '-'}%) | total ${record.totalAmount ?? '-'}`);
      if (onOrderRecorded) onOrderRecorded(record);

      if (process.env.AUTO_REPLY !== 'false') {
        await sock.sendMessage(
          msg.key.remoteJid,
          {
            text:
              `✅ *Order tracked*\n` +
              `👤 ${record.customer}\n` +
              `📦 ${record.quantity ?? '-'}${record.unit ? ' ' + record.unit : ''} ${record.item}\n` +
              `💰 Cost: ₹${record.costPrice ?? '-'} | Profit: ₹${record.profitAmount ?? '-'}${record.profitPercent != null ? ` (${record.profitPercent}%)` : ''}\n` +
              `🧾 Total: ₹${record.totalAmount ?? '-'}`,
          },
          { quoted: msg }
        );
      }
    } catch (err) {
      console.error('[bot] message handler error:', err.message);
    }
  });

  return sock;
}

/** Generate a pairing code for "Link with phone number" login (phone: 10-digit Indian number or with country code). */
async function requestPairingCode(phoneRaw) {
  if (!sock) throw new Error('Bot not started yet');
  let phone = String(phoneRaw).replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone; // assume Indian number
  if (phone.length < 11) throw new Error('Invalid phone number');

  // Same number + code still fresh + socket alive -> hand back the existing code
  const fresh = botStatus.pairingCode && pairingPhone === phone
    && Date.now() - pairingCodeAt < PAIRING_CODE_TTL_MS;
  if (fresh && sock.ws?.isOpen) return botStatus.pairingCode;

  // Double-tap dedup: don't mint two codes for the same request
  if (pairingInflight && pairingInflight.phone === phone) return pairingInflight.promise;

  const promise = (async () => {
    const code = await requestCodeWithRetry(phone);
    notePairingCode(code, phone);
    return code;
  })();
  pairingInflight = { phone, promise };
  try {
    return await promise;
  } finally {
    if (pairingInflight?.promise === promise) pairingInflight = null;
  }
}

module.exports = { startBot, getStatus, requestPairingCode };
