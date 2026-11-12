// VyaparTrack server: WhatsApp (zapo-js) + offline order parser + REST API for the Android client.
// Deploy to Render/Railway/Fly.io free tier. See README.md.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
require('dotenv').config();

// zapo-js replaced Baileys in Sept 2026: WhatsApp's server silently rejects
// Baileys' pairing-code registration crypto (Stage-3 companion_finish) while
// zapo's implementation of the current protocol pairs successfully.
const { WaClient, createStore } = require('zapo-js');
const { createSqliteStore } = require('@zapo-js/store-sqlite');
const QRCode = require('qrcode');
const pino = require('pino');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.VYAPAR_DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = process.env.VYAPAR_AUTH_DIR || path.join(__dirname, 'auth');
const STORE_PATH = process.env.VYAPAR_AUTH_DB || path.join(AUTH_DIR, 'zapo.db');
const API_TOKEN = process.env.API_TOKEN || crypto.randomBytes(24).toString('hex');

// Group chats are ignored by default - a group message is not a customer
// order and replying inside a group messages everyone in it.
// Set ALLOW_GROUP_CHATS=true to opt back in.
const ALLOW_GROUP_CHATS = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_GROUP_CHATS || '').trim());

// Automated replies are OFF by default: replying automatically from an
// unofficial WhatsApp connection is what makes WhatsApp flag the number.
// Set AUTO_REPLY=true to switch it on deliberately.
const AUTO_REPLY = /^(1|true|yes|on)$/i.test(String(process.env.AUTO_REPLY || '').trim());

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveOrders(o) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(o, null, 2));
}
function addOrder(o) {
  const orders = loadOrders();
  const rec = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    customer: o.customer || 'Unknown',
    item: o.item || 'Item not specified',
    quantity: o.quantity ?? null,
    unit: o.unit ?? null,
    costPrice: o.costPrice ?? null,
    profitPercent: o.profitPercent ?? null,
    profitAmount: o.profitAmount ?? null,
    totalAmount: o.totalAmount ?? null,
    source: o.source || 'manual',
    pricedBy: o.pricedBy ?? null,
    pricedTotalBy: o.pricedTotalBy ?? null,
    pricedCostBy: o.pricedCostBy ?? null,
    raw: o.raw ?? null,
  };
  orders.unshift(rec);
  saveOrders(orders);
  return rec;
}

/**
 * Price/refresh orders of this catalog item. Fills orders still awaiting a
 * price and recalculates ones priced by the catalog earlier (so fixing a
 * catalog entry fixes wrong math). Orders whose prices came from the
 * customer's message are never touched.
 * Returns the number of orders updated.
 */
function repriceOrdersForItem(entry) {
  if (!entry || entry.sellPrice == null) return 0;
  const eTerms = nameTerms(entry.name);
  const orders = loadOrders();
  let updated = 0;
  for (const o of orders) {
    if (!o.item || o.quantity == null) continue;
    // Only touch orders whose total is missing or was calculated by the catalog.
    // Message-stated prices (and legacy orders) are never overwritten.
    if (o.pricedTotalBy !== 'catalog' && o.totalAmount != null) continue;
    const oTerms = nameTerms(o.item);
    const sameItem = oTerms.size > 0 && eTerms.size > 0
      ? [...eTerms].some((t) => oTerms.has(t))
      : o.item.toLowerCase() === entry.name.toLowerCase();
    if (!sameItem) continue;
    const qtyIn = convertQty(o.quantity, o.unit, entry.unit, entry.pieceWeight);
    if (qtyIn == null) continue; // incompatible units - leave the order alone
    const perQty = Number(entry.priceQty) > 0 ? Number(entry.priceQty) : 1;
    if (o.pricedTotalBy === 'catalog' || o.totalAmount == null) {
      o.totalAmount = round2(entry.sellPrice * qtyIn / perQty);
      o.pricedTotalBy = 'catalog';
    }
    if (o.pricedCostBy === 'catalog') {
      if (entry.costPrice != null) o.costPrice = round2(entry.costPrice * qtyIn / perQty);
    } else if (o.costPrice == null && entry.costPrice != null) {
      o.costPrice = round2(entry.costPrice * qtyIn / perQty);
      o.pricedCostBy = 'catalog';
    }
    if (o.costPrice != null && o.totalAmount != null) {
      o.profitAmount = round2(o.totalAmount - o.costPrice);
      o.profitPercent = o.costPrice > 0 ? round2((o.profitAmount / o.costPrice) * 100) : null;
    }
    o.pricedBy = 'catalog';
    updated++;
  }
  if (updated) saveOrders(orders);
  return updated;
}
function deleteOrder(id) {
  const before = loadOrders();
  const after = before.filter((o) => o.id !== id);
  const removed = after.length !== before.length;
  if (removed) saveOrders(after);
  return removed;
}
function getStats() {
  const orders = loadOrders();
  let revenue = 0, cost = 0, profit = 0;
  for (const o of orders) {
    if (o.totalAmount != null) revenue += o.totalAmount;
    if (o.costPrice != null) cost += o.costPrice;
    if (o.profitAmount != null) profit += o.profitAmount;
  }
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  return {
    totalOrders: orders.length,
    revenue: round2(revenue),
    cost: round2(cost),
    profit: round2(profit),
    avgMarginPct: round2(margin),
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

// ============ Item catalog ============
// The vendor teaches the app what they sell and at what price:
//   { id, name, unit, sellPrice, costPrice }  -> sellPrice per unit, costPrice per unit
// Orders mentioning a known item get priced automatically; unknown items go to
// a "pending pricing" queue the vendor fills once, and the reply then works.
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending-pricing.json');
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function loadCatalog() { return loadJson(CATALOG_FILE, []); }
function saveCatalog(items) { saveJson(CATALOG_FILE, items); }

// Everyday Hindi/regional trade names <-> English, so an item saved as "Oil"
// also matches orders that say "tel", "doodh" matches "milk", etc.
const ITEM_SYNONYMS = [
  ['oil', 'tel', 'thel', 'tail'],
  ['milk', 'doodh', 'dudh', 'pal', 'paal'],
  ['sugar', 'cheeni', 'chini', 'sakkar', 'shakkar'],
  ['flour', 'atta', 'aata', 'maida', 'besan'],
  ['rice', 'chawal', 'chaval', 'bhaat'],
  ['ghee', 'ghii'],
  ['dal', 'daal', 'pulse', 'lentils'],
  ['salt', 'namak', 'lun'],
  ['honey', 'shahad', 'shehad', 'madhu'],
  ['butter', 'makkhan', 'makhan'],
  ['curd', 'dahi', 'yogurt'],
  ['tea', 'chai'],
  ['coffee', 'kaapi'],
  ['spice', 'masala'],
  ['wheat', 'gehu', 'gahu'],
  ['jaggery', 'gud', 'gur'],
];
function nameTerms(name) {
  const n = String(name || '').toLowerCase().trim();
  const terms = new Set(n ? [n] : []);
  for (const group of ITEM_SYNONYMS) {
    if (group.includes(n)) group.forEach((g) => terms.add(g));
  }
  return terms;
}
function findCatalogItem(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return null;
  const items = loadCatalog();
  // exact: catalog name equals the order item, or is a known synonym of it
  const exact = items.find((it) => {
    const in2 = String(it.name || '').toLowerCase().trim();
    return in2 && (in2 === n || nameTerms(in2).has(n));
  });
  if (exact) return exact;
  // substring: any synonym of either name contained in the other ("mustard tel" vs "oil")
  const terms = nameTerms(n);
  return items.find((it) => {
    const in2 = String(it.name || '').toLowerCase().trim();
    if (!in2) return false;
    for (const t of terms) if (t.length >= 3 && in2.includes(t)) return true;
    for (const t of nameTerms(in2)) if (t.length >= 3 && n.includes(t)) return true;
    return false;
  }) || null;
}
function loadPending() { return loadJson(PENDING_FILE, []); }
function savePending(list) { saveJson(PENDING_FILE, list); }

/**
 * Convert a quantity between compatible units.
 * kg<->g, l<->ml, dozen<->pcs always; count<->mass (pcs/dozen <-> kg/g) also
 * works when the catalog item declares pieceWeight (grams per piece).
 */
const UNIT_DIMENSION = { kg: 'mass', g: 'mass', ml: 'volume', l: 'volume', pcs: 'count', dozen: 'count' };
const UNIT_TO_BASE = { kg: 1000, g: 1, ml: 1, l: 1000, pcs: 1, dozen: 12 };
function convertQty(qty, fromUnit, toUnit, pieceWeight) {
  if (qty == null) return null;
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
  const fd = UNIT_DIMENSION[fromUnit];
  const td = UNIT_DIMENSION[toUnit];
  if (fd !== td) {
    // count <-> mass bridge via grams-per-piece
    if ((fd === 'count' && td === 'mass') || (fd === 'mass' && td === 'count')) {
      const pw = Number(pieceWeight);
      if (!Number.isFinite(pw) || pw <= 0) return null;
      const grams = qty * (UNIT_TO_BASE[fromUnit] || 1) * (fd === 'count' ? pw : 1) / (fd === 'count' ? 1 : pw);
      return round2(td === 'kg' ? grams / 1000 : grams);
    }
    return null;
  }
  return round2(qty * (UNIT_TO_BASE[fromUnit] / UNIT_TO_BASE[toUnit]));
}

/** Fill in sell/cost from the catalog when the message didn't state prices. */
function applyCatalogPricing(order) {
  if (!order || !order.item || order.quantity == null) return order;
  const item = findCatalogItem(order.item);
  if (!item || item.sellPrice == null) return order;
  const qty = order.quantity;
  const knownUnit = order.unit && item.unit && order.unit === item.unit;
  const unitAgnostic = !order.unit || !item.unit || knownUnit;
  // Convert when the order unit differs but is compatible ("500 ml" vs catalog per "l",
  // "3 piece" vs catalog per "kg" when piece weight is known)
  const qtyInItemUnits = unitAgnostic ? qty : convertQty(qty, order.unit, item.unit, item.pieceWeight);
  if (qtyInItemUnits == null) return order;
  const priced = { ...order };
  // Track exactly which fields the catalog filled, so a later catalog fix
  // re-prices those - but never prices the customer's message stated itself.
  const filledTotal = priced.totalAmount == null;
  const filledCost = priced.costPrice == null && item.costPrice != null;
  const perQty = Number(item.priceQty) > 0 ? Number(item.priceQty) : 1;
  if (filledTotal) priced.totalAmount = round2(item.sellPrice * qtyInItemUnits / perQty);
  if (filledCost) priced.costPrice = round2(item.costPrice * qtyInItemUnits / perQty);
  if (priced.costPrice != null && priced.totalAmount != null) {
    priced.profitAmount = round2(priced.totalAmount - priced.costPrice);
    priced.profitPercent = priced.costPrice > 0 ? round2((priced.profitAmount / priced.costPrice) * 100) : null;
  }
  if (filledTotal || filledCost) {
    priced.pricedBy = 'catalog';
    if (filledTotal) priced.pricedTotalBy = 'catalog';
    if (filledCost) priced.pricedCostBy = 'catalog';
  }
  return priced;
}

/** Record an unmatched item for the vendor to price later. */
function addPendingPricing(order, customerJid) {
  if (!order || !order.item || order.quantity == null) return;
  const list = loadPending();
  const key = `${String(order.item).toLowerCase().trim()}|${order.unit || ''}`;
  const existing = list.find((p) => p.key === key);
  if (existing) {
    existing.examples.unshift({ orderId: order.id, customer: order.customer, jid: customerJid, at: new Date().toISOString() });
    existing.examples = existing.examples.slice(0, 5);
  } else {
    list.unshift({
      id: crypto.randomUUID(),
      key,
      item: order.item,
      unit: order.unit || null,
      examples: [{ orderId: order.id, customer: order.customer, jid: customerJid, at: new Date().toISOString() }],
      askedAt: new Date().toISOString(),
    });
  }
  savePending(list);
}

/** Hindi question sent to the vendor when a new item needs pricing. */
function pricingQuestionText(p) {
  const qty = p.unit ? `${p.examples[0] ? '' : ''}` : '';
  const itemLabel = p.unit ? `${p.item} (${p.unit})` : p.item;
  return (
    `🛒 नया आइटम मिला: *${itemLabel}*\n\n` +
    `1️⃣ आप इसे कितने में बेचते हैं? (₹ प्रति ${p.unit || 'यूनिट'})\n` +
    `2️⃣ इसमें आपका खर्चा कितना है? (₹ प्रति ${p.unit || 'यूनिट'})\n\n` +
    `ऐप में खोलकर भरें: Settings → Pricing`
  );
}

// ============ Offline parser ============
// Shared with the desktop engine (src/parser.js) so native-script handling
// (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi,
// Urdu) stays in one place and both entry points behave identically.
const { parseOrder: parseWithRegex } = require('../src/parser');

async function parseOrder(text) {
  return parseWithRegex(text);
}

/** Shared order pipeline: catalog pricing + pending queue. Used by bot AND REST API. */
async function recordParsedOrder(parsed, senderName, senderJid) {
  const priced = applyCatalogPricing(parsed);
  const rec = addOrder({ ...priced, customer: senderName || parsed.customer, source: parsed.source });
  if (senderJid) scheduleNameBackfill(rec.id, senderJid);

  // Unknown item with a quantity? Queue it so the vendor can price it once.
  if (!priced.pricedBy && priced.item && priced.quantity != null) {
    const before = loadPending().map((p) => p.key);
    addPendingPricing(priced, senderJid);
    const fresh = loadPending().find((p) => !before.includes(p.key));
    // Ask the vendor in their own WhatsApp chat ("Message yourself")
    if (fresh && client && client.connected) {
      try {
        const meJid = client.getCredentials()?.meJid;
        if (meJid) await client.message.send(meJid, { type: 'text', text: pricingQuestionText(fresh) });
      } catch {}
    }
  }
  return rec;
}

// ============ WhatsApp bot ============
let client = null;
let connectPromise = null;

// jid -> saved WhatsApp contact name (from the user's address book).
// Indexed by BOTH the phone jid and the LID jid - messages may arrive as either.
// Profile names (pushName) are kept separately and never override saved names.
const contactNames = new Map();
const lidToPn = new Map();
// Persisted to the Render disk so names survive restarts/redeploys
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
function saveContacts() {
  try { fs.writeFileSync(CONTACTS_FILE, JSON.stringify({ savedNames: [...contactNames], lidToPn: [...lidToPn] })); } catch {}
}
function loadContacts() {
  try {
    const d = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    for (const [k, v] of d.savedNames || []) contactNames.set(k, v);
    for (const [k, v] of d.lidToPn || []) lidToPn.set(k, v);
  } catch {}
}
loadContacts();
/** WhatsApp reports masked phones ("+91………39") as chat/profile display names - never treat those as names. */
function isMaskedName(name) { return /[•…]/.test(String(name || '')); }
function rememberContact(c) {
  if (!c || !c.id || !c.name || isMaskedName(c.name)) return;
  contactNames.set(c.id, c.name);
  if (c.lid) contactNames.set(c.lid, c.name);
  saveContacts();
  flushPendingNames();
}
function rememberLidMapping(m) {
  if (!m || !m.lid || !m.pn) return;
  if (lidToPn.get(m.lid) === m.pn) return; // already known - skip the disk write
  lidToPn.set(m.lid, m.pn);
  const name = contactNames.get(m.lid) || contactNames.get(m.pn);
  if (name) { contactNames.set(m.lid, name); contactNames.set(m.pn, name); }
  saveContacts();
  flushPendingNames();
}

/** Saved address-book name for a jid (LID or phone), or null. */
function savedNameFor(jid) {
  const pn = lidToPn.get(jid);
  const name = contactNames.get(jid) || (pn && contactNames.get(pn)) || null;
  return name && !isMaskedName(name) ? name : null;
}

// Orders recorded before a contact name was known get backfilled once it arrives
const pendingNames = new Map(); // orderId -> jid
function updateOrderCustomer(orderId, name) {
  const orders = loadOrders();
  const rec = orders.find((o) => o.id === orderId);
  if (!rec || rec.customer === name) return false;
  rec.customer = name;
  saveOrders(orders);
  return true;
}
function flushPendingNames() {
  for (const [orderId, jid] of [...pendingNames]) {
    const name = savedNameFor(jid);
    if (name && updateOrderCustomer(orderId, name)) pendingNames.delete(orderId);
  }
}
function scheduleNameBackfill(orderId, jid) {
  if (pendingNames.has(orderId)) return;
  pendingNames.set(orderId, jid);
  for (const delay of [5000, 20000, 60000]) setTimeout(flushPendingNames, delay);
}

/**
 * Sender display: saved contact name -> real phone number. Never the WhatsApp
 * profile/display name (it's often a masked "+91⬦⬦⬦39" or a random nickname).
 */
function resolveSenderName(jid, pushName) {
  void pushName; // intentionally unused - display names are not shown
  const saved = savedNameFor(jid);
  if (saved) return saved;
  const pn = lidToPn.get(jid);
  const digits = String(jid).split('@')[0].replace(/\D/g, '');
  if (!digits && pn) return String(pn).split('@')[0];
  return digits ? '+' + digits : jid;
}
let botStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  pairingCode: null,
  pairingExpiresAt: null,
  lastError: null,
  lastDisconnectCode: null,
  startedAt: null,
};
// Pairing code TTL for the dashboard countdown only.
const PAIRING_CODE_TTL_MS = 150000;
let pairingCodeAt = 0;

function notePairingCode(code) {
  pairingCodeAt = Date.now();
  botStatus.pairingCode = code;
  botStatus.pairingExpiresAt = new Date(pairingCodeAt + PAIRING_CODE_TTL_MS).toISOString();
}

/** Mint a pairing code once per click. WhatsApp rate-limits pairing requests
 *  (429 rate-overlimit) and ANY retry extends the window - so surface the
 *  error instead of auto-retrying. */
async function requestPairingCode(phoneRaw) {
  if (!client) throw new Error('Bot not started yet');
  let phone = String(phoneRaw).replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone; // assume Indian number
  if (phone.length < 11) throw new Error('Invalid phone number');

  // Same code minted <60s ago -> hand it back (a re-tap must not invalidate a
  // code the user may be entering)
  if (botStatus.pairingCode && Date.now() - pairingCodeAt < 60000) {
    return botStatus.pairingCode;
  }

  try {
    const code = await client.auth.requestPairingCode(phone);
    console.log(`[bot] pairing code minted for +${phone}: ${code}`);
    notePairingCode(code);
    return code;
  } catch (err) {
    const msg = String(err?.message || err);
    console.error(`[bot] pairing code request failed: ${msg}`);
    if (/rate-overlimit|429/i.test(msg)) {
      throw new Error('WhatsApp is rate-limiting pairing attempts for this account. Wait a few days without attempts, then try again.');
    }
    if (/not ready|reconnect/i.test(msg)) {
      throw new Error('WhatsApp is reconnecting - tap again in a few seconds');
    }
    throw new Error(msg);
  }
}

async function startBot() {
  // Pick a writable location for the SQLite session store: the configured
  // path first, then the persistent data dir, then tmp. On Render the disk
  // mount can lag or point elsewhere, so fall back instead of crash-looping.
  const candidates = [STORE_PATH, path.join(DATA_DIR, 'zapo.db'), path.join(os.tmpdir(), 'vyapartrack-zapo.db')];
  let storePath = null;
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      storePath = candidate;
      break;
    } catch { /* try the next candidate */ }
  }
  if (!storePath) throw new Error('No writable directory found for the WhatsApp session store');
  if (storePath !== STORE_PATH) console.warn(`[bot] session store moved to ${storePath}`);

  const zapoStore = createStore({
    backends: { sqlite: createSqliteStore({ path: storePath }) },
    providers: {
      auth: 'sqlite', signal: 'sqlite', senderKey: 'sqlite', appState: 'sqlite',
      preKey: 'sqlite', session: 'sqlite', identity: 'sqlite',
      messages: 'none', threads: 'none', contacts: 'none', privacyToken: 'sqlite',
    },
  });
  const logger = pino({ level: process.env.WA_DEBUG === '1' ? 'debug' : 'error' });
  client = new WaClient({ store: zapoStore, sessionId: 'default', logger });

  client.on('auth_qr', async ({ qr }) => {
    try {
      botStatus.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
      botStatus.connected = false;
      botStatus.connecting = true;
      botStatus.lastError = null;
      botStatus.startedAt = new Date().toISOString();
      console.log('[bot] QR ready');
    } catch (err) {
      console.error('[bot] QR render failed:', err.message);
    }
  });

  client.on('auth_paired', () => {
    botStatus.connected = true;
    botStatus.connecting = false;
    botStatus.qrDataUrl = null;
    botStatus.pairingCode = null;
    botStatus.pairingExpiresAt = null;
    console.log('[bot] WhatsApp paired');
  });

  client.on('connection', async (event) => {
    if (event.status === 'open') {
      botStatus.connected = true;
      botStatus.connecting = false;
      botStatus.qrDataUrl = null;
      botStatus.pairingCode = null;
      botStatus.pairingExpiresAt = null;
      botStatus.lastError = null;
      botStatus.lastDisconnectCode = null;
      reconnectAttempts = 0;
      console.log('[bot] WhatsApp connected');
      return;
    }
    // status === 'close'
    botStatus.connected = false;
    botStatus.connecting = false;
    botStatus.qrDataUrl = null;
    botStatus.pairingCode = null;
    botStatus.pairingExpiresAt = null;
    pairingCodeAt = 0;
    try { client.disconnect(); } catch {}
    if (event.isLogout) {
      // Device was unlinked - the persisted session is useless. Wipe the DB so
      // the next start presents a fresh linkable session.
      reconnectAttempts = 0;
      botStatus.lastDisconnectCode = 401;
      botStatus.lastError = 'Previous link expired - get a new code';
      console.warn('[bot] closed: logged out - wiping session db');
      try {
        fs.rmSync(STORE_PATH, { force: true });
        for (const suffix of ['-wal', '-shm']) fs.rmSync(STORE_PATH + suffix, { force: true });
      } catch (e) { console.error('[bot] session wipe failed:', e.message); }
    } else {
      // Backoff so a crash-loop can't hammer WhatsApp (each restart also
      // invalidates any outstanding pairing code).
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      const delay = Math.min(300000, 5000 * Math.pow(2, reconnectAttempts - 1));
      botStatus.lastDisconnectCode = typeof event.code === 'number' ? event.code : null;
      botStatus.lastError = 'Connection lost - reconnecting...';
      console.warn(`[bot] closed: ${event.reason || event.code || 'unknown'} - reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
      setTimeout(() => startBot().catch((e) => console.error(e)), delay);
    }
  });

  client.on('message', async (event) => {
    try {
      const key = event.key || {};
      const chatJid = String(key.remoteJid || '');
      if (!chatJid || key.fromMe) return;
      // Ignore newsletters/channels and broadcast statuses - marketing posts
      // there were being parsed as phantom orders.
      if (chatJid === 'status@broadcast' || chatJid.endsWith('@broadcast') || chatJid.endsWith('@newsletter')) return;
      // Group chat (JIDs ending in @g.us) - ignored unless ALLOW_GROUP_CHATS=true.
      if (!ALLOW_GROUP_CHATS && chatJid.endsWith('@g.us')) return;

      const proto = event.message || {};
      const text = proto.conversation
        || proto.extendedTextMessage?.text
        || proto.imageMessage?.caption
        || '';
      if (!text) return;
      // Ignore messages that are mostly links (spam/marketing)
      const linkCount = (text.match(/https?:\/\//gi) || []).length;
      if (linkCount >= 1 && text.replace(/https?:\/\/\S+/gi, '').trim().length < 20) return;

      // zapo resolves LID jids internally, but masked senders (not saved in
      // contacts) still arrive as @lid - the real phone rides in the Alt fields.
      const alt = key.remoteJidAlt || key.participantAlt;
      const senderJid = String((alt && alt.endsWith('@s.whatsapp.net') ? alt : (key.participant || chatJid)));
      const senderName = resolveSenderName(senderJid, event.pushName);

      const order = await parseOrder(text);
      if (!order) return;

      // Catalog pricing + pending queue (shared with the REST API)
      const rec = await recordParsedOrder(order, senderName, senderJid);
      console.log(`[bot] Order: ${rec.customer} | from ${senderJid} pushName=${event.pushName || 'none'} | ${rec.quantity ?? ''}${rec.unit ?? ''} ${rec.item} | total ${rec.totalAmount ?? '-'}`);

      if (AUTO_REPLY) {
        const pricedReply = rec.totalAmount != null;
        await client.message.send(chatJid, {
          type: 'text',
          text: pricedReply
            // Customer-facing: cost/profit/margin are seller-confidential — send only confirmation + price.
            ? `✅ *ऑर्डर मिल गया!*\n` +
              `📦 ${rec.quantity ?? '—'}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
              `🧾 कीमत: ₹${rec.totalAmount ?? '—'}\n\nधन्यवाद! 🙏`
            : `✅ *आपका ऑर्डर मिल गया!* ${rec.quantity ?? ''}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
              `🧾 कीमत जल्द ही कन्फर्म होगी। धन्यवाद! 🙏`,
          contextInfo: {
            quotedMessageId: key.id,
            quotedParticipant: key.participant || chatJid,
            quotedRemoteJid: chatJid,
            quotedMessage: proto,
          },
        });
      }
    } catch (err) {
      console.error('[bot] handler error:', err.message);
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
}

/** Vendor fills prices for a pending item -> save to catalog, re-price open orders. */
function resolvePendingItem(pendingId, sellPrice, costPrice, unit, pieceWeight, priceQty) {
  const list = loadPending();
  const p = list.find((x) => x.id === pendingId);
  if (!p) return null;
  const items = loadCatalog();
  // Merge into an existing catalog entry (incl. synonym match, e.g. "tel" -> "Oil")
  const matched = findCatalogItem(p.item);
  const existing = matched ? items.find((it) => it.id === matched.id) : null;
  const entry = existing || {
    id: crypto.randomUUID(),
    name: p.item,
    unit: unit || p.unit || null,
  };
  entry.sellPrice = sellPrice;
  entry.costPrice = costPrice;
  if (unit) entry.unit = unit;
  const pw = Number(pieceWeight);
  if (Number.isFinite(pw) && pw > 0) entry.pieceWeight = pw;
  const pq = Number(priceQty);
  if (Number.isFinite(pq) && pq > 0) entry.priceQty = pq;
  if (!existing) items.unshift(entry);
  saveCatalog(items);
  savePending(list.filter((x) => x.id !== pendingId));

  // Re-price older orders of the same item (incl. synonyms: "tel", "mustard tel"...)
  const updated = repriceOrdersForItem(entry);
  return { entry, updated };
}

// ============ Express API ============
const app = express();
app.use(express.json());

// The Android app loads its dashboard from file:// (Origin: null) and the
// browser blocks cross-origin fetches without these headers.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const tok = req.headers['x-api-token'];
  if (tok !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, parser: 'offline', botStarted: Boolean(client) }));
app.get('/api/status', auth, (req, res) =>
  res.json({ ...botStatus, parser: 'offline' })
);
app.post('/api/pair', auth, async (req, res) => {
  try {
    const code = await requestPairingCode(req.body?.phone);
    const expiresIn = botStatus.pairingExpiresAt
      ? Math.max(0, Math.round((new Date(botStatus.pairingExpiresAt).getTime() - Date.now()) / 1000))
      : null;
    res.json({ code, expiresIn });
  } catch (err) {
    const raw = err.message || 'Pairing failed';
    const msg = /Connection Closed|WebSocket|not ready/i.test(raw)
      ? 'WhatsApp is reconnecting - tap again in a few seconds'
      : raw;
    res.status(400).json({ error: msg });
  }
});
app.get('/api/orders', auth, (req, res) => res.json(loadOrders()));
app.post('/api/orders', auth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Provide { "text": "..." }' });
  const parsed = await parseOrder(text);
  if (!parsed) return res.status(422).json({ error: 'Could not find an order in that message' });
  parsed.source = parsed.source === 'regex' ? 'manual' : parsed.source;
  const rec = await recordParsedOrder(parsed, parsed.customer, null);
  res.status(201).json(rec);
});
app.delete('/api/orders/:id', auth, (req, res) => res.json({ deleted: deleteOrder(req.params.id) }));
app.post('/api/demo', auth, (req, res) => {
  const demo = [
    { customer: 'Mayank', item: 'Ladoo', quantity: 500, unit: 'g', costPrice: 200, profitPercent: 15, profitAmount: 30, totalAmount: 230 },
    { customer: 'Sharma Uncle', item: 'Kaju Katli', quantity: 1, unit: 'kg', costPrice: 850, profitPercent: 20, profitAmount: 170, totalAmount: 1020 },
    { customer: 'Priya Gupta', item: 'Chocolate Cake', quantity: 2, unit: 'kg', costPrice: 700, profitPercent: 25, profitAmount: 175, totalAmount: 875 },
    { customer: 'Ravi Kirana', item: 'Namkeen', quantity: 5, unit: 'kg', costPrice: 400, profitPercent: 18, profitAmount: 72, totalAmount: 472 },
  ].map((d) => addOrder({ ...d, source: 'demo' }));
  res.json({ ok: true, count: demo.length });
});
app.get('/api/stats', auth, (req, res) => res.json(getStats()));
// Debug: what names the bot has learned (saved contacts + LID mappings)
app.get('/api/contacts', auth, (req, res) => res.json({
  savedNames: Object.fromEntries(contactNames),
  lidToPn: Object.fromEntries(lidToPn),
}));

// ---- Item catalog ----
app.get('/api/catalog', auth, (req, res) => res.json(loadCatalog()));
app.post('/api/catalog', auth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const items = loadCatalog();
  // Reuse an existing entry when it's the same thing (e.g. "tel" vs "Oil")
  const matched = findCatalogItem(name);
  const existing = matched ? items.find((it) => it.id === matched.id) : null;
  const entry = existing || { id: crypto.randomUUID(), name };
  if (req.body?.unit != null) entry.unit = req.body.unit || null;
  if (req.body?.sellPrice != null) entry.sellPrice = Number(req.body.sellPrice) || null;
  if (req.body?.costPrice != null) entry.costPrice = Number(req.body.costPrice) || null;
  if (req.body?.pieceWeight != null) {
    const pw = Number(req.body.pieceWeight);
    entry.pieceWeight = Number.isFinite(pw) && pw > 0 ? pw : null;
  }
  if (req.body?.priceQty != null) {
    const pq = Number(req.body.priceQty);
    entry.priceQty = Number.isFinite(pq) && pq > 0 ? pq : null;
  }
  if (!existing) items.unshift(entry);
  saveCatalog(items);
  // Prices changed on an existing item -> fix orders the old price had miscalculated
  const repriced = existing ? repriceOrdersForItem(entry) : 0;
  res.json({ ...entry, repricedOrders: repriced });
});
app.delete('/api/catalog/:id', auth, (req, res) => {
  const items = loadCatalog();
  const next = items.filter((it) => it.id !== req.params.id);
  saveCatalog(next);
  res.json({ deleted: next.length !== items.length });
});

// ---- Pending pricing (items awaiting the vendor's prices) ----
app.get('/api/pending-pricing', auth, (req, res) => res.json(loadPending()));
app.post('/api/pending-pricing/:id/resolve', auth, (req, res) => {
  const sellPrice = Number(req.body?.sellPrice);
  const costPrice = req.body?.costPrice != null ? Number(req.body.costPrice) : null;
  const unit = req.body?.unit != null ? String(req.body.unit) : null;
  const pieceWeight = req.body?.pieceWeight != null ? Number(req.body.pieceWeight) : null;
  const priceQty = req.body?.priceQty != null ? Number(req.body.priceQty) : null;
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return res.status(400).json({ error: 'sellPrice (number > 0) required' });
  }
  const result = resolvePendingItem(req.params.id, sellPrice, costPrice, unit, pieceWeight, priceQty);
  if (!result) return res.status(404).json({ error: 'pending item not found' });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`VyaparTrack server on :${PORT}`);
  console.log(`API token (save it!): ${API_TOKEN}`);
  startBot().catch((err) => console.error('[bot] failed to start:', err.message));
});
