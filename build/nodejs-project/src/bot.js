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
let botStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  pairingCode: null,
  lastError: null,
};

function getStatus() {
  return { ...botStatus };
}

function resetLinkState() {
  botStatus.qrDataUrl = null;
  botStatus.pairingCode = null;
}

async function startBot(onOrderRecorded) {
  botStatus.connecting = true;
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
      botStatus = { ...botStatus, connected: true, connecting: false, qrDataUrl: null, pairingCode: null, lastError: null };
      console.log('[bot] WhatsApp connected. Listening for orders...');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      botStatus.connected = false;
      botStatus.connecting = false;
      botStatus.lastError = loggedOut ? 'Logged out - link again' : 'Connection lost - reconnecting...';
      console.warn('[bot] closed:', code, loggedOut ? '(logged out)' : '');
      if (!loggedOut) {
        setTimeout(() => startBot(onOrderRecorded).catch(() => {}), 5000); // auto-reconnect
      } else {
        resetLinkState();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text) return;

      const order = await extract(text);
      if (!order) return;

      const record = store.addOrder({ ...order, source: 'whatsapp' });
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

  const code = await sock.requestPairingCode(phone);
  botStatus.pairingCode = code;
  return code;
}

module.exports = { startBot, getStatus, requestPairingCode };
