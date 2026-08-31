// VyaparTrack server: WhatsApp Baileys + Poolside AI parsing + REST API for the Android client.
// Deploy to Render/Railway/Fly.io free tier. See README.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.VYAPAR_DATA_DIR || path.join(__dirname, 'data');
const AUTH_DIR = process.env.VYAPAR_AUTH_DIR || path.join(__dirname, 'auth');
const POOLSIDE_API_KEY = process.env.POOLSIDE_API_KEY || '';
const POOLSIDE_MODEL = process.env.POOLSIDE_MODEL || 'poolside/laguna-xs-2.1';
const POOLSIDE_BASE_URL = process.env.POOLSIDE_BASE_URL || 'https://inference.poolside.ai/v1';
const API_TOKEN = process.env.API_TOKEN || crypto.randomBytes(24).toString('hex');

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
    raw: o.raw || null,
  };
  orders.unshift(rec);
  saveOrders(orders);
  return rec;
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

// ============ Poolside AI parser ============
const SYSTEM_PROMPT = `You are an order-extraction engine for small Indian businesses.
Extract a JSON object from the message with EXACTLY these fields:
{"customer": string|null, "item": string|null, "quantity": number|null, "unit": "kg"|"g"|"pcs"|"dozen"|"l"|null, "costPrice": number|null, "profitPercent": number|null, "profitAmount": number|null, "totalAmount": number|null}
Rules:
- costPrice = what the shopkeeper paid (cost / CP / base price).
- If profit is given as a percent of cost, compute profitAmount = costPrice * pct / 100.
- If profit is given as an amount, compute profitPercent = profitAmount / costPrice * 100 (round to 2 decimals).
- totalAmount = costPrice + profitAmount when not stated.
- Amounts are INR numbers only, no symbols.
- Reply with ONLY the JSON object, no markdown, no explanation.`;

async function parseWithAI(text) {
  if (!POOLSIDE_API_KEY) return null;
  try {
    const res = await fetch(`${POOLSIDE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POOLSIDE_API_KEY}`,
      },
      body: JSON.stringify({
        model: POOLSIDE_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) {
      console.error('[poolside]', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const jsonText = content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(jsonText);
    const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
    return {
      customer: parsed.customer || null,
      item: parsed.item || null,
      quantity: num(parsed.quantity),
      unit: parsed.unit || null,
      costPrice: num(parsed.costPrice),
      profitPercent: num(parsed.profitPercent),
      profitAmount: num(parsed.profitAmount),
      totalAmount: num(parsed.totalAmount),
      source: 'ai',
      raw: text,
    };
  } catch (err) {
    console.error('[poolside] failed:', err.message);
    return null;
  }
}

// ============ Regex parser (offline fallback) ============
const UNITS = 'kg|kgs|kilogram|kilograms|gram|grams|gms|gm|g|dozen|pcs|pieces|piece|litre|litres|liter|liters|l';
const QUANTITY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i');
const UNIT_NOT_AFTER = new RegExp(`(?!\\s*(?:${UNITS})\\b)`, 'i');
const COST_RE = /(?:total\s*)?(?:cost|cp|base\s*price|buying\s*price|price)\s*(?:of\s*[a-z ]+)?\s*(?:[=:]|is|are)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)/i;
const SOLD_FOR_RE = new RegExp(
  `\\b(?:sold|sell|selling)\\b\\s*(?:it\\s*)?(?:at|for|in|to\\s+\\w+)?\\s*(?:rs\\.?|rupees|inr|₹)?\\s*(\\d+(?:\\.\\d+)?)\\b${UNIT_NOT_AFTER.source}`,
  'i'
);
const PROFIT_PCT_RE = /\+?\s*(\d+(?:\.\d+)?)\s*%/;
const PROFIT_PCT_WORD_RE = /(?:profit|margin)\s*(?:is|=|:|of|@)?\s*(\d+(?:\.\d+)?)\s*%/i;
const PROFIT_AMT_RE = /(?:profit|margin)\s*(?:is|=|:|of)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)\b(?!\s*%)/i;
const TOTAL_RE = /total\s*(?:amount|price|sell(?:ing)?)?\s*(?:[=:]|is)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)/i;
const ORDER_INTENT_RE = /\b(order|ordered|sold|sale|sell|order aaya|bill|invoice|mangwaya|mange|mangaye|chahiye)\b/i;
const CUSTOMER_RES = [
  /order\s*from\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+\+)/i,
  /(?:customer|client)\s*[:\-]\s*([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bsold\b[^,.]*?\bto\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bfor\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\b([A-Za-z][A-Za-z ]{1,30}?)\s+ne\b/i,
];
const UNIT_NORMALIZE = {
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  gram: 'g', grams: 'g', gms: 'g', gm: 'g', g: 'g',
  dozen: 'dozen', pcs: 'pcs', pieces: 'pcs', piece: 'pcs',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', l: 'l',
};
const ITEM_TAIL_STOP = /\s+(?:mange|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|please|ke\s+liye)\b.*$/i;
const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function titleCase(name) {
  return name.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function extractCustomer(text) {
  for (const re of CUSTOMER_RES) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/\b(cost|price|profit|rs|rupees|total|ne)\b\s*$/i, '').trim();
      if (name) return titleCase(name);
    }
  }
  return null;
}
function extractItem(text, qtyMatch) {
  if (!qtyMatch) return null;
  const before = text.slice(Math.max(0, qtyMatch.index - 40), qtyMatch.index);
  const after = text.slice(qtyMatch.index + qtyMatch[0].length, qtyMatch.index + qtyMatch[0].length + 40);
  let m = after.match(/^\s*(?:ke\s+|ka\s+|ki\s+|of\s+)?([a-z][a-z ]{1,25}?)(?=\s*[,.!=]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+for|\s+sold|\s+to\b|\s+ne\b)/i);
  if (m && m[1].trim()) return m[1].trim().replace(ITEM_TAIL_STOP, '').replace(/\s+/g, ' ');
  m = before.match(/([a-z][a-z]{2,24})\s*(?:ke|ka|ki|of)?\s*$/i);
  if (m && !/^(from|order|total|cost|price|profit|for|sold|sell)$/i.test(m[1])) return m[1].trim();
  return null;
}
function parseWithRegex(text) {
  if (!text || !ORDER_INTENT_RE.test(text)) return null;
  const customer = extractCustomer(text);
  const qtyMatch = text.match(QUANTITY_RE);
  const quantity = qtyMatch ? toNum(qtyMatch[1]) : null;
  const unit = qtyMatch ? UNIT_NORMALIZE[qtyMatch[2].toLowerCase()] : null;
  const item = extractItem(text, qtyMatch);
  let costPrice = null, totalAmount = null, profitPercent = null, profitAmount = null;
  const cm = text.match(COST_RE); if (cm) costPrice = toNum(cm[1]);
  const pd = text.match(PROFIT_PCT_RE);
  const pw = text.match(PROFIT_PCT_WORD_RE);
  if (pd) profitPercent = toNum(pd[1]); else if (pw) profitPercent = toNum(pw[1]);
  const pa = text.match(PROFIT_AMT_RE); if (pa) profitAmount = toNum(pa[1]);
  const sm = text.match(SOLD_FOR_RE); if (sm) totalAmount = toNum(sm[1]);
  const tm = text.match(TOTAL_RE); if (tm) totalAmount = toNum(tm[1]);
  if (costPrice == null && totalAmount == null) return null;
  if (costPrice != null && profitPercent != null && profitAmount == null) profitAmount = round2((costPrice * profitPercent) / 100);
  if (costPrice != null && totalAmount == null && profitAmount != null) totalAmount = round2(costPrice + profitAmount);
  if (totalAmount != null && costPrice != null && profitAmount == null) profitAmount = round2(totalAmount - costPrice);
  if (costPrice != null && profitAmount != null && profitPercent == null && costPrice > 0) profitPercent = round2((profitAmount / costPrice) * 100);
  if (totalAmount == null && costPrice != null && profitAmount == null) totalAmount = costPrice;
  return { customer, item, quantity, unit, costPrice, profitPercent, profitAmount, totalAmount, source: 'regex', raw: text };
}

async function parseOrder(text) {
  if (POOLSIDE_API_KEY) {
    const ai = await parseWithAI(text);
    if (ai && (ai.costPrice != null || ai.totalAmount != null)) return ai;
  }
  return parseWithRegex(text);
}

// ============ WhatsApp bot ============
let sock = null;
let botStatus = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  pairingCode: null,
  lastError: null,
  startedAt: null,
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }

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
        botStatus.startedAt = new Date().toISOString();
        console.log('[bot] QR ready');
      } catch (err) {
        console.error('[bot] QR render failed:', err.message);
      }
    }
    if (connection === 'connecting') botStatus.connecting = true;
    if (connection === 'open') {
      botStatus = { ...botStatus, connected: true, connecting: false, qrDataUrl: null, pairingCode: null, lastError: null };
      console.log('[bot] WhatsApp connected');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      botStatus.connected = false;
      botStatus.connecting = false;
      botStatus.lastError = loggedOut ? 'Logged out - link again' : 'Connection lost - reconnecting...';
      console.warn('[bot] closed:', code, loggedOut ? '(logged out)' : '');
      if (!loggedOut) setTimeout(() => startBot().catch((e) => console.error(e)), 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || '';
      if (!text) return;

      const order = await parseOrder(text);
      if (!order) return;

      const rec = addOrder({ ...order, source: 'whatsapp' });
      console.log(`[bot] Order: ${rec.customer} | ${rec.quantity ?? ''}${rec.unit ?? ''} ${rec.item} | total ${rec.totalAmount ?? '-'}`);

      if (process.env.AUTO_REPLY !== 'false') {
        await sock.sendMessage(msg.key.remoteJid, {
          text:
            `✅ *Order tracked*\n` +
            `👤 ${rec.customer}\n` +
            `📦 ${rec.quantity ?? '—'}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
            `💰 Cost: ₹${rec.costPrice ?? '—'} | Profit: ₹${rec.profitAmount ?? '—'}${rec.profitPercent != null ? ` (${rec.profitPercent}%)` : ''}\n` +
            `🧾 Total: ₹${rec.totalAmount ?? '—'}`,
        }, { quoted: msg });
      }
    } catch (err) {
      console.error('[bot] handler error:', err.message);
    }
  });
}

async function requestPairingCode(phoneRaw) {
  if (!sock) throw new Error('Bot not started yet');
  let phone = String(phoneRaw).replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;
  if (phone.length < 11) throw new Error('Invalid phone number');
  const code = await sock.requestPairingCode(phone);
  botStatus.pairingCode = code;
  return code;
}

// ============ Express API ============
const app = express();
app.use(express.json());

function auth(req, res, next) {
  const tok = req.headers['x-api-token'];
  if (tok !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: Boolean(POOLSIDE_API_KEY), aiModel: POOLSIDE_MODEL, botStarted: Boolean(sock) }));
app.get('/api/status', auth, (req, res) =>
  res.json({ ...botStatus, aiConfigured: Boolean(POOLSIDE_API_KEY), aiModel: POOLSIDE_MODEL })
);
app.post('/api/pair', auth, async (req, res) => {
  try { res.json({ code: await requestPairingCode(req.body?.phone) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/orders', auth, (req, res) => res.json(loadOrders()));
app.post('/api/orders', auth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Provide { "text": "..." }' });
  const parsed = await parseOrder(text);
  if (!parsed) return res.status(422).json({ error: 'Could not find an order in that message' });
  res.status(201).json(addOrder(parsed));
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

app.listen(PORT, () => {
  console.log(`VyaparTrack server on :${PORT}`);
  console.log(`API token (save it!): ${API_TOKEN}`);
  startBot().catch((err) => console.error('[bot] failed to start:', err.message));
});