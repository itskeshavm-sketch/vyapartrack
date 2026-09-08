// VyaparTrack server: WhatsApp (zapo-js) + Poolside AI parsing + REST API for the Android client.
// Deploy to Render/Railway/Fly.io free tier. See README.md.

const fs = require('fs');
const path = require('path');
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
    if (o.pricedTotalBy === 'catalog' || o.totalAmount == null) {
      o.totalAmount = round2(entry.sellPrice * qtyIn);
      o.pricedTotalBy = 'catalog';
    }
    if (o.pricedCostBy === 'catalog') {
      if (entry.costPrice != null) o.costPrice = round2(entry.costPrice * qtyIn);
    } else if (o.costPrice == null && entry.costPrice != null) {
      o.costPrice = round2(entry.costPrice * qtyIn);
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
  if (filledTotal) priced.totalAmount = round2(item.sellPrice * qtyInItemUnits);
  if (filledCost) priced.costPrice = round2(item.costPrice * qtyInItemUnits);
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
    `ðŸ›’ à¤¨à¤¯à¤¾ à¤†à¤‡à¤Ÿà¤® à¤®à¤¿à¤²à¤¾: *${itemLabel}*\n\n` +
    `1ï¸âƒ£ à¤†à¤ª à¤‡à¤¸à¥‡ à¤•à¤¿à¤¤à¤¨à¥‡ à¤®à¥‡à¤‚ à¤¬à¥‡à¤šà¤¤à¥‡ à¤¹à¥ˆà¤‚? (â‚¹ à¤ªà¥à¤°à¤¤à¤¿ ${p.unit || 'à¤¯à¥‚à¤¨à¤¿à¤Ÿ'})\n` +
    `2ï¸âƒ£ à¤‡à¤¸à¤®à¥‡à¤‚ à¤†à¤ªà¤•à¤¾ à¤–à¤°à¥à¤šà¤¾ à¤•à¤¿à¤¤à¤¨à¤¾ à¤¹à¥ˆ? (â‚¹ à¤ªà¥à¤°à¤¤à¤¿ ${p.unit || 'à¤¯à¥‚à¤¨à¤¿à¤Ÿ'})\n\n` +
    `à¤à¤ª à¤®à¥‡à¤‚ à¤–à¥‹à¤²à¤•à¤° à¤­à¤°à¥‡à¤‚: Settings â†’ Pricing`
  );
}

// ============ Poolside AI parser ============
const SYSTEM_PROMPT = `You are an order-extraction engine for small Indian businesses.
Extract a JSON object from the message with EXACTLY these fields:
{"customer": string|null, "item": string|null, "quantity": number|null, "unit": "kg"|"g"|"ml"|"l"|"pcs"|"dozen"|null, "costPrice": number|null, "profitPercent": number|null, "profitAmount": number|null, "totalAmount": number|null}
Rules:
- costPrice = what the shopkeeper paid (cost / CP / base price).
- A message can be a valid order with only customer/item/quantity (price discussed later) - extract what is present, leave the rest null.
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
const UNITS = 'kg|kgs|kilogram|kilograms|kilo|kilos|keji|gram|grams|graam|gms|gm|g|dozen|darjan|pcs|pieces|piece|pees|pis|nag|ml|millilitre|millilitres|milliliter|milliliters|litre|litres|liter|liters|l|ser|seer|sher|pav|paav|poa|tola|thola|tol|ratti|chatak|chhatank|masha|vori|ennam|ennikkai|mukka|item|ta';

const QUANTITY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i');
const UNIT_NOT_AFTER = new RegExp(`(?!\\s*(?:${UNITS})\\b)`, 'i');
const COST_RE = /(?:total\s*)?(?:cost|cp|base\s*price|buying\s*price|price)\s*(?:of\s*[a-z ]+)?\s*(?:[=:]|is|are)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)/i;
const SOLD_FOR_RE = new RegExp(
  `\\b(?:sold|sell|selling)\\b\\s*(?:it\\s*)?(?:at|for|in|to\\s+\\w+)?\\s*(?:rs\\.?|rupees|inr|\\u20B9)?\\s*(\\d+(?:\\.\\d+)?)\\b${UNIT_NOT_AFTER.source}`,
  'i'
);
const PROFIT_PCT_RE = /\+?\s*(\d+(?:\.\d+)?)\s*%/;
const PROFIT_PCT_WORD_RE = /(?:profit|margin)\s*(?:is|=|:|of|@)?\s*(\d+(?:\.\d+)?)\s*%/i;
const PROFIT_AMT_RE = /(?:profit|margin)\s*(?:is|=|:|of)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)\b(?!\s*%)/i;
const TOTAL_RE = /total\s*(?:amount|price|sell(?:ing)?)?\s*(?:[=:]|is)?\s*(?:rs\.?|rupees|inr|\u20B9)?\s*(\d+(?:\.\d+)?)/i;

// Fractional spoken quantities: "aadha kilo besan", "dedh kg doodh"...
const FRACTION_QTY_RE = /\b(aadha|adha|ardha|half|dedh|dhai|sava|savva)\s*(kilo|kilos|kg|keji|gram|litre|liter)\b/i;
const FRACTION_VALUES = { aadha: 0.5, adha: 0.5, ardha: 0.5, half: 0.5, dedh: 1.5, dhai: 1.5, sava: 1.25, savva: 1.25 };

// Order intent, Roman script: safe single words + distinctive phrases.
const ROMAN_INTENT_RE = new RegExp(
  '\\b(?:order(?:ed|s)?|sold|sale|sell|bill|invoice|mangwaya|mange|mangaye|chahiye|bhejo|bhejna|bhej|kitna|kitne|mujhe|pahije|chai|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi)\\b' +
  '|\\b(?:bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|tayar kar do|pack kar do|pack kar dena|ghar bhej|kitne ka|kitne mein|kitna lagega|rate kya|bhav batao|price batao|bhao kya|qeemat kya|total kitna|kiti padel|kiti hoil|kiti rupayala|bhav kay|rate sanga|kimmat sanga|total kiti|pathavun dya|banvun dya|tayar karun|pack karun|ghari pathva|koto porbe|koto hobe|dam koto|rate koto|total koto|koto taka|pathiye din|baniye din|toiri kore din|ready kore din|pack kore din|rekhe din|senju kudunga|ready pannunga|pack pannunga|veetukku anuppunga|evlo aagum|evlo varum|rate enna|price enna|vilai enna|total evlo|pampincheyandi|ivvandi|ichcheyandi|chesi ivvandi|tayaru cheyandi|ready cheyandi|pack cheyandi|entha avutundi|entha padutundi|rate entha|price entha|dhara entha|total entha|manege kalisi|tayarisi kodi|ittu kodi|madi kodi|ready madi|pack madi|eshtu agutte|eshtu barutte|bele eshtu|rate eshtu|price eshtu|total eshtu|ayachu tharu|ayach tharu|veettil ayakku|cheithu tharu|undakki tharu|ready aakki|pack cheythu|ethra aakum|ethra varum|vila ethra|rate ethra|price ethra|total ethra|ethra roopa|mokli do|mokli aapo|aapi do|aapi aapo|banavi aapo|taiyar kari aapo|ready kari do|pack kari do|rakhi do|ghare mokli|ketla thashe|ketlama malse|bhav ketlo|rate ketlo|ketlu padse|total ketlu|ketla rupiya|bhej deo|de deo|bana deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|kinne da pavega|kinne nu milega|rate ki aa|bhav ki aa|price kinne di|kinne da aa|total kinna|kinne paise|bhej dein|de dein|bana dein|tayyar kar dein|kitne ka hoga|delivery kar do|delivery kore din|delivery pannunga|delivery cheyandi|delivery madi|delivery kari do)\\b' +
  '|(?:can|may)\\s+i\\s+(?:get|have|order)|i\\s+(?:want|need)\\b',
  'i'
);

// ---- Native-script support (u-flag, \p{L}/\p{M} lookarounds) ----
const NATIVE_DIGITS = 'à¥¦à¥§à¥¨à¥©à¥ªà¥«à¥¬à¥­à¥®à¥¯à§¦à§§à§¨à§©à§ªà§«à§¬à§­à§®à§¯à¯¦à¯§à¯¨à¯©à¯ªà¯«à¯¬à¯­à¯®à¯¯à±¦à±§à±¨à±©à±ªà±«à±¬à±­à±®à±¯à³¦à³§à³¨à³©à³ªà³«à³¬à³­à³®à³¯àµ¦àµ§àµ¨àµ©àµªàµ«àµ¬àµ­àµ®àµ¯à©¦à©§à©¨à©©à©ªà©«à©¬à©­à©®à©¯Û°Û±Û²Û³Û´ÛµÛ¶Û·Û¸Û¹';
const DIGIT_MAP = (() => {
  const m = {};
  for (let c = 0; c < NATIVE_DIGITS.length; c += 10) {
    for (let i = 0; i < 10; i++) m[NATIVE_DIGITS[c + i]] = String(i);
  }
  return m;
})();
function normalizeDigits(s) { return String(s).replace(/./g, (ch) => DIGIT_MAP[ch] || ch); }

const NATIVE_INTENT = [
  'à¤šà¤¾à¤¹à¤¿à¤', 'à¤­à¥‡à¤œ à¤¦à¥‹', 'à¤­à¥‡à¤œ à¤¦à¥‡à¤¨à¤¾', 'à¤­à¥‡à¤œà¥‹', 'à¤¬à¤¨à¤¾ à¤¦à¥‹', 'à¤¬à¤¨à¤¾ à¤¦à¥‡à¤¨à¤¾', 'à¤¦à¥‡ à¤¦à¥‹', 'à¤¦à¥‡ à¤¦à¥‡à¤¨à¤¾',
  'à¤¤à¥ˆà¤¯à¤¾à¤° à¤•à¤° à¤¦à¥‹', 'à¤¤à¥ˆà¤¯à¤¾à¤° à¤•à¤° à¤¦à¥‡à¤¨à¤¾', 'à¤ªà¥ˆà¤• à¤•à¤° à¤¦à¥‹', 'à¤ªà¥ˆà¤• à¤•à¤° à¤¦à¥‡à¤¨à¤¾', 'à¤ªà¥ˆà¤• à¤•à¤°à¤•à¥‡ à¤­à¥‡à¤œ à¤¦à¥‹',
  'à¤°à¤– à¤¦à¥‡à¤¨à¤¾', 'à¤¡à¤¿à¤²à¥€à¤µà¤° à¤•à¤° à¤¦à¥‹', 'à¤˜à¤° à¤­à¥‡à¤œ', 'à¤•à¤¿à¤¤à¤¨à¥‡ à¤•à¤¾', 'à¤•à¤¿à¤¤à¤¨à¥‡ à¤®à¥‡à¤‚', 'à¤•à¤¿à¤¤à¤¨à¤¾ à¤²à¤—à¥‡à¤—à¤¾',
  'à¤­à¤¾à¤µ à¤¬à¤¤à¤¾à¤“', 'à¤°à¥‡à¤Ÿ à¤•à¥à¤¯à¤¾', 'à¤ªà¥à¤°à¤¾à¤‡à¤¸ à¤¬à¤¤à¤¾à¤“', 'à¤Ÿà¥‹à¤Ÿà¤² à¤•à¤¿à¤¤à¤¨à¤¾', 'à¤‘à¤°à¥à¤¡à¤°',
  'Ø¨Ú¾ÛŒØ¬ Ø¯Ùˆ', 'Ø¨Ú¾ÛŒØ¬ Ø¯ÛŒÚº', 'Ø¨Ù†Ø§ Ø¯Ùˆ', 'Ø¨Ù†Ø§ Ø¯ÛŒÚº', 'ØªÛŒØ§Ø± Ú©Ø± Ø¯Ùˆ', 'Ù¾ÛŒÚ© Ú©Ø± Ø¯Ùˆ', 'Ú¯Ú¾Ø± Ø¨Ú¾ÛŒØ¬',
  'Ú©ØªÙ†Û’ Ú©Ø§', 'Ú©ØªÙ†Û’ Ù…ÛŒÚº', 'Ú©ØªÙ†Ø§ Ù„Ú¯Û’ Ú¯Ø§', 'Ù‚ÛŒÙ…Øª Ú©ÛŒØ§', 'Ø¨Ú¾Ø§Ø¤ Ú©ÛŒØ§', 'Ù¹ÙˆÙ¹Ù„ Ú©ØªÙ†Ø§', 'Ø¢Ø±ÚˆØ±', 'Ú†Ø§ÛÛŒÛ’',
  'à¤ªà¤¾à¤¹à¤¿à¤œà¥‡', 'à¤ªà¤¾à¤ à¤µà¤¾', 'à¤ªà¤¾à¤ à¤µà¥‚à¤¨ à¤¦à¥à¤¯à¤¾', 'à¤¬à¤¨à¤µà¥‚à¤¨ à¤¦à¥à¤¯à¤¾', 'à¤¤à¤¯à¤¾à¤° à¤•à¤°à¥‚à¤¨', 'à¤ªà¥…à¤• à¤•à¤°à¥‚à¤¨',
  'à¤•à¤¿à¤¤à¥€ à¤ªà¤¡à¥‡à¤²', 'à¤•à¤¿à¤¤à¥€ à¤¹à¥‹à¤ˆà¤²', 'à¤­à¤¾à¤µ à¤•à¤¾à¤¯', 'à¤°à¥‡à¤Ÿ à¤¸à¤¾à¤‚à¤—à¤¾', 'à¤•à¤¿à¤‚à¤®à¤¤ à¤¸à¤¾à¤‚à¤—à¤¾', 'à¤Ÿà¥‹à¤Ÿà¤² à¤•à¤¿à¤¤à¥€',
  'à¦šà¦¾à¦‡', 'à¦…à¦°à§à¦¡à¦¾à¦°', 'à¦ªà¦¾à¦ à¦¿à¦¯à¦¼à§‡ à¦¦à¦¿à¦¨', 'à¦¬à¦¾à¦¨à¦¿à¦¯à¦¼à§‡ à¦¦à¦¿à¦¨', 'à¦¤à§ˆà¦°à¦¿ à¦•à¦°à§‡ à¦¦à¦¿à¦¨',
  'à¦°à§‡à¦–à§‡ à¦¦à¦¿à¦¨', 'à¦ªà§à¦¯à¦¾à¦• à¦•à¦°à§‡ à¦¦à¦¿à¦¨', 'à¦•à¦¤ à¦ªà¦¡à¦¼à¦¬à§‡', 'à¦•à¦¤ à¦¹à¦¬à§‡', 'à¦¦à¦¾à¦® à¦•à¦¤', 'à¦•à¦¤ à¦Ÿà¦¾à¦•à¦¾', 'à¦Ÿà§‹à¦Ÿà¦¾à¦² à¦•à¦¤',
  'à®µà¯‡à®£à¯à®Ÿà¯à®®à¯', 'à®†à®°à¯à®Ÿà®°à¯', 'à®…à®©à¯à®ªà¯à®ªà¯à®™à¯à®•', 'à®…à®©à¯à®ªà¯à®ªà®¿ à®µà®¿à®Ÿà¯à®™à¯à®•', 'à®šà¯†à®žà¯à®šà¯ à®•à¯à®Ÿà¯à®™à¯à®•',
  'à®°à¯†à®Ÿà®¿ à®ªà®£à¯à®£à¯à®™à¯à®•', 'à®ªà¯‡à®•à¯ à®ªà®£à¯à®£à¯à®™à¯à®•', 'à®µà¯€à®Ÿà¯à®Ÿà¯à®•à¯à®•à¯ à®…à®©à¯à®ªà¯à®ªà¯à®™à¯à®•',
  'à®Žà®µà¯à®µà®³à®µà¯ à®†à®•à¯à®®à¯', 'à®Žà®µà¯à®µà®³à®µà¯ à®µà®°à¯à®®à¯', 'à®°à¯‡à®Ÿà¯ à®Žà®©à¯à®©', 'à®µà®¿à®²à¯ˆ à®Žà®©à¯à®©', 'à®Ÿà¯‹à®Ÿà¯à®Ÿà®²à¯ à®Žà®µà¯à®µà®³à®µà¯',
  'à°•à°¾à°µà°¾à°²à°¿', 'à°†à°°à±à°¡à°°à±', 'à°ªà°‚à°ªà°‚à°¡à°¿', 'à°ªà°‚à°ªà°¿à°‚à°šà±‡à°¯à°‚à°¡à°¿', 'à°‡à°µà±à°µà°‚à°¡à°¿', 'à°‡à°šà±à°šà±‡à°¯à°‚à°¡à°¿',
  'à°¤à°¯à°¾à°°à± à°šà±‡à°¯à°‚à°¡à°¿', 'à°°à±†à°¡à±€ à°šà±‡à°¯à°‚à°¡à°¿', 'à°ªà±à°¯à°¾à°•à± à°šà±‡à°¯à°‚à°¡à°¿',
  'à°Žà°‚à°¤ à°…à°µà±à°¤à±à°‚à°¦à°¿', 'à°Žà°‚à°¤ à°ªà°¡à±à°¤à±à°‚à°¦à°¿', 'à°°à±‡à°Ÿà± à°Žà°‚à°¤', 'à°§à°° à°Žà°‚à°¤', 'à°Ÿà±‹à°Ÿà°²à± à°Žà°‚à°¤',
  'à²¬à³‡à²•à³', 'à²†à²°à³à²¡à²°à³', 'à²•à²³à²¿à²¸à²¿', 'à²•à²³à³à²¹à²¿à²¸à²¿', 'à²®à²¨à³†à²—à³† à²•à²³à²¿à²¸à²¿', 'à²¤à²¯à²¾à²°à²¿à²¸à²¿ à²•à³Šà²¡à²¿',
  'à²‡à²Ÿà³à²Ÿà³ à²•à³Šà²¡à²¿', 'à²°à³†à²¡à²¿ à²®à²¾à²¡à²¿', 'à²ªà³à²¯à²¾à²•à³ à²®à²¾à²¡à²¿',
  'à²Žà²·à³à²Ÿà³ à²†à²—à³à²¤à³à²¤à³†', 'à²Žà²·à³à²Ÿà³ à²¬à²°à³à²¤à³à²¤à³†', 'à²¬à³†à²²à³† à²Žà²·à³à²Ÿà³', 'à²°à³‡à²Ÿà³ à²Žà²·à³à²Ÿà³', 'à²Ÿà³‹à²Ÿà²²à³ à²Žà²·à³à²Ÿà³',
  'à´µàµ‡à´£à´‚', 'à´“àµ¼à´¡àµ¼', 'à´…à´¯à´šàµà´šàµ à´¤à´°àµ‚', 'à´…à´¯à´•àµà´•àµ‚', 'à´šàµ†à´¯àµà´¤àµ à´¤à´°àµ‚', 'à´‰à´£àµà´Ÿà´¾à´•àµà´•à´¿ à´¤à´°àµ‚',
  'à´ªà´¾à´•àµà´•àµ à´šàµ†à´¯àµà´¤àµ à´¤à´°àµ‚', 'à´µàµ€à´Ÿàµà´Ÿà´¿àµ½ à´…à´¯à´•àµà´•àµ‚',
  'à´Žà´¤àµà´° à´†à´•àµà´‚', 'à´Žà´¤àµà´° à´µà´°àµà´‚', 'à´µà´¿à´² à´Žà´¤àµà´°', 'à´±àµ‡à´±àµà´±àµ à´Žà´¤àµà´°', 'à´Ÿàµ‹à´Ÿàµà´Ÿàµ½ à´Žà´¤àµà´°',
  'àªœà«‹àªˆàª', 'àª“àª°à«àª¡àª°', 'àª®à«‹àª•àª²à«€ àª¦à«‹', 'àª®à«‹àª•àª²à«€ àª†àªªà«‹', 'àª†àªªà«€ àª¦à«‹', 'àª†àªªà«€ àª†àªªà«‹', 'àª¬àª¨àª¾àªµà«€ àª†àªªà«‹',
  'àª¤à«ˆàª¯àª¾àª° àª•àª°à«€', 'àª°à«‡àª¡à«€ àª•àª°à«€', 'àªªà«‡àª• àª•àª°à«€', 'àª°àª¾àª–à«€ àª¦à«‹',
  'àª•à«‡àªŸàª²àª¾ àª¥àª¶à«‡', 'àª•à«‡àªŸàª²à«àª‚ àªªàª¡àª¶à«‡', 'àª­àª¾àªµ àª•à«‡àªŸàª²à«‹', 'àª°à«‡àªŸ àª•à«‡àªŸàª²à«‹', 'àªŸà«‹àªŸàª² àª•à«‡àªŸàª²à«àª‚',
  'à¨šà¨¾à¨¹à©€à¨¦à¨¾', 'à¨†à¨°à¨¡à¨°', 'à¨­à©‡à¨œ à¨¦à¨¿à¨“', 'à¨¬à¨£à¨¾ à¨¦à¨¿à¨“', 'à¨¤à¨¿à¨†à¨° à¨•à¨° à¨¦à¨¿à¨“', 'à¨°à©ˆà¨¡à©€ à¨•à¨° à¨¦à¨¿à¨“',
  'à¨ªà©ˆà¨• à¨•à¨° à¨¦à¨¿à¨“', 'à¨°à©±à¨– à¨¦à¨¿à¨“', 'à¨•à¨¿à©°à¨¨à©‡ à¨¦à¨¾', 'à¨•à¨¿à©°à¨¨à©‡ à¨ªà©ˆà¨¸à©‡', 'à¨°à©‡à¨Ÿ à¨•à©€', 'à¨­à¨¾à¨… à¨•à©€', 'à¨Ÿà©‹à¨Ÿà¨² à¨•à¨¿à©°à¨¨à¨¾',
];
const NATIVE_UNITS = [
  'à¤•à¤¿à¤²à¥‹', 'à¤•à¥‡à¤œà¥€', 'à¤•à¤¿à¤²à¥‹à¤—à¥à¤°à¤¾à¤®', 'à¤•à¤¿à¤²à¥‹à¤—à¥à¤°à¥…à¤®', 'à¦•à¦¿à¦²à§‹', 'à¦•à§‡à¦œà¦¿', 'à¦•à¦¿à¦²à§‹à¦—à§à¦°à¦¾à¦®', 'à®•à®¿à®²à¯‹', 'à®•à®¿à®²à¯‹à®•à®¿à®°à®¾à®®à¯',
  'à°•à°¿à°²à±‹', 'à°•à°¿à°²à±‹à°—à±à°°à°¾à°®à±', 'à°•à±‡à°œà±€', 'à²•à²¿à²²à³‹', 'à²•à²¿à²²à³‹à²—à³à²°à²¾à²‚', 'à²•à³†à²œà²¿', 'à´•à´¿à´²àµ‹', 'à´•à´¿à´²àµ‹à´—àµà´°à´¾à´‚',
  'àª•àª¿àª²à«‹', 'àª•àª¿àª²à«‹àª—à«àª°àª¾àª®', 'à¨•à¨¿à¨²à©‹', 'à¨•à¨¿à¨²à©‹à¨—à©à¨°à¨¾à¨®', 'à¨•à©‡à¨œà©€', 'Ú©Ù„Ùˆ', 'Ú©Ù„ÙˆÚ¯Ø±Ø§Ù…',
  'à¤—à¥à¤°à¤¾à¤®', 'à¤—à¥à¤°à¥…à¤®', 'à¦—à§à¦°à¦¾à¦®', 'à®•à®¿à®°à®¾à®®à¯', 'à°—à±à°°à°¾à°®à±', 'à²—à³à²°à²¾à²‚', 'à²—à³à²°à²¾à²®', 'à´—àµà´°à´¾à´‚', 'àª—à«àª°àª¾àª®', 'à¨—à©à¨°à¨¾à¨®', 'Ú¯Ø±Ø§Ù…',
  'à¤¤à¥‹à¤²à¤¾', 'à¤¤à¥‹à¤³à¤¾', 'à¤¤à¥‹à¤³', 'à¤°à¤¤à¥à¤¤à¥€', 'à¤›à¤Ÿà¤¾à¤‚à¤•', 'à¦šà¦Ÿà¦•', 'à¦­à¦°à¦¿', 'à¦¤à§‹à¦²à¦¾', 'à®¤à¯‹à®²à®¾', 'à®¤à¯‹à®²à¯ˆ',
  'à°¤à±à°²à°‚', 'à°¤à±à°²à°¾', 'à²¤à³Šà²²', 'à²¤à³Šà²²à³†', 'à²°à²¤à³à²¤à²¿', 'à´¤àµŠà´²', 'à´°à´¤àµà´¤à´¿', 'àª¤à«‹àª²àª¾', 'àª¤à«‹àª²', 'àª°àª¤à«€',
  'à¨¤à©‹à¨²à¨¾', 'à¨¤à©‹à¨²', 'à¨°à©±à¨¤à©€', 'ØªÙˆÙ„Û', 'ØªÙˆÙ„', 'Ø±ØªÛŒ', 'Ù…Ø§Ø´Û',
  'à¤²à¤¿à¤Ÿà¤°', 'à¦²à¦¿à¦Ÿà¦¾à¦°', 'à®²à®¿à®Ÿà¯à®Ÿà®°à¯', 'à°²à±€à°Ÿà°°à±', 'à²²à³€à²Ÿà²°à³', 'à´²à´¿à´±àµà´±àµ¼', 'àª²à«€àªŸàª°', 'à¨²à©€à¨Ÿà¨°', 'Ù„ÛŒÙ¹Ø±',
  'à¤®à¤¿à¤²à¥€à¤²à¥€à¤Ÿà¤°', 'à¤®à¤¿à¤²à¥€',
  'à¤ªà¥€à¤¸', 'à¤¨à¤—', 'à¦ªà¦¿à¦¸', 'à¦Ÿà¦¾', 'à®ªà¯€à®¸à¯', 'à°ªà±€à°¸à±', 'à°®à±à°•à±à°•', 'à²ªà³€à²¸à³', 'à²à²Ÿà²‚', 'à´Žà´£àµà´£à´‚', 'àªªà«€àª¸', 'àª¨àª‚àª—', 'à¨ªà©€à¨¸', 'à¨¨à¨—', 'Ù¾ÛŒØ³', 'Ø¹Ø¯Ø¯',
  'à¤¦à¤°à¥à¤œà¤¨', 'à¤¡à¤à¤¨', 'à¦¡à¦œà¦¨', 'à®Ÿà®œà®©à¯', 'à°¡à°œà°¨à±', 'à²¡à²œà²¨à³', 'à´¡à´¸àµ»', 'àª¡àªàª¨', 'à¨¦à¨°à¨œà¨¨', 'Ø¯Ø±Ø¬Ù†',
  'à°•à°¿à°²à±‹à°²à±', 'à°•à°¿à°²à±‹à°²', 'à°—à±à°°à°¾à°®à±à°²à±', 'à°—à±à°°à°¾à°®à±à°²', 'à°²à±€à°Ÿà°°à±à°²à±', 'à°¡à°œà°¨à±à°²à±',
  'à¤¸à¥‡à¤°', 'à¤¶à¥‡à¤°', 'à¦¸à§‡à¦°', 'à¦ªà§‹à¦¯à¦¼à¦¾', 'à®šà¯‡à®°à¯', 'à®ªà®Ÿà®¿', 'à°¸à±‡à°°à±', 'à²¸à³‡à²°à³', 'à´¸àµ‡àµ¼', 'àª¶à«‡àª°', 'à¨¸à©‡à¨°', 'Ø³ÛŒØ±',
  'à¤ªà¤¾à¤µ', 'à®ªà®¾à®µà¯', 'à°ªà°¾à°µà±', 'à²ªà²¾à²µà³', 'à´ªà´¾à´µàµ', 'àªªàª¾àªµ', 'à¨ªà¨¾à¨µ', 'Ù¾Ø§Ø¤',
];
const NATIVE_UNIT_MAP = (() => {
  const groups = [
    ['à¤•à¤¿à¤²à¥‹ à¤•à¥‡à¤œà¥€ à¤•à¤¿à¤²à¥‹à¤—à¥à¤°à¤¾à¤® à¤•à¤¿à¤²à¥‹à¤—à¥à¤°à¥…à¦® à¦•à¦¿à¦²à§‹ à¦•à§‡à¦œà¦¿ à¦•à¦¿à¦²à§‹à¦—à§à¦°à¦¾à¦® à®•à®¿à®²à¯‹ à®•à®¿à®²à¯‹à®•à®¿à®°à®¾à®®à¯ à°•à°¿à°²à±‹ à°•à°¿à°²à±‹à°—à±à°°à°¾à°®à± à°•à±‡à°œà±€ à²•à²¿à²²à³‹ à²•à²¿à²²à³‹à²—à³à²°à²¾à²‚ à²•à³†à²œà²¿ à´•à´¿à´²àµ‹ à´•à´¿à´²àµ‹à´—àµà´°à´¾à´‚ àª•àª¿àª²à«‹ àª•àª¿àª²à«‹àª—à«àª°àª¾àª® à¨•à¨¿à¨²à©‹ à¨•à¨¿à¨²à©‹à¨—à©à¨°à¨¾à¨® à¨•à©‡à¨œà©€ Ú©Ù„Ùˆ Ú©Ù„ÙˆÚ¯Ø±Ø§Ù…', 'kg'],
    ['à¤—à¥à¤°à¤¾à¤® à¤—à¥à¤°à¥…à¤® à¦—à§à¦°à¦¾à¦® à®•à®¿à®°à®¾à®®à¯ à°—à±à°°à°¾à°®à± à²—à³à²°à²¾à²‚ à²—à³à²°à²¾à²® à´—àµà´°à´¾à´‚ àª—à«àª°àª¾àª® à¨—à©à¨°à¨¾à¨® Ú¯Ø±Ø§Ù… à¤¤à¥‹à¤²à¤¾ à¤¤à¥‹à¤³à¤¾ à¤¤à¥‹à¤³ à¤°à¤¤à¥à¤¤à¥€ à¤›à¤Ÿà¤¾à¤‚à¤• à¦­à¦°à¦¿ à¦¤à§‹à¦²à¦¾ à®¤à¯‹à®²à®¾ à®¤à¯‹à®²à¯ˆ à°¤à±à°²à°‚ à°¤à±à°²à°¾ à²¤à³Šà²² à²¤à³Šà²²à³† à²°à²¤à³à²¤à²¿ à´¤àµŠà´² à´°à´¤àµà´¤àª¿ àª¤à«‹àª²àª¾ àª¤à«‹àª² àª°àª¤à«€ à¨¤à©‹à¨²à¨¾ à¨¤à©‹à¨² à¨°à©±à¨¤à©€ ØªÙˆÙ„Û ØªÙˆÙ„ Ø±ØªÛŒ Ù…Ø§Ø´Û', 'g'],
    ['à¤²à¥€à¤Ÿà¤° à¦²à¦¿à¦Ÿà¦¾à¦° à®²à®¿à®Ÿà¯à®Ÿà®°à¯ à°²à±€à°Ÿà°°à± à²²à³€à²Ÿà²°à³ à´²à´¿à´±àµà´±àµ¼ àª²à«€àªŸàª° à¨²à©€àªŸàª° Ù„ÛŒÙ¹Ø±', 'l'],
  ['à¤®à¤¿à¤²à¥€à¤²à¥€à¤Ÿà¤° à¤®à¤¿à¤²à¥€', 'ml'],
    ['à¤ªà¥€à¤¸ à¤¨à¤— à¦ªà¦¿à¦¸ à¦Ÿà¦¾ à®ªà¯€à®¸à¯ à°ªà±€à°¸à± à°®à±à°•à±à°• à²ªà³€à²¸à³ à²à²Ÿà²‚ à´Žà´£àµà´£à´‚ àªªà«€àª¸ àª¨àª‚àª— à¨ªà©€à¨¸ à¨¨à¨— Ù¾ÛŒØ³ Ø¹Ø¯Ø¯', 'pcs'],
    ['à¤¦à¤°à¥à¤œà¤¨ à¤¡à¤à¤¨ à¦¡à¦œà¦¨ à®Ÿà®œà®©à¯ à°¡à°œà²¨à³ à²¡à²œà²¨à³ à´¡à´¸àµ» àª¡àªàª¨ à¨¦àª°à¯à®œàª¨ Ø¯Ø±Ø¬Ù†', 'dozen'],
    ['à°•à°¿à°²à±‹à°²à± à°•à°¿à°²à±‹à°² à°—à±à°°à°¾à°®à±à°²à± à°—à±à°°à°¾à°®à±à°² à°²à±€à°Ÿà°°à±à°²à± à°¡à°œà°¨à±à°²à±', 'dozen'],
    ['à¤¸à¥‡à¤° à¤¶à¥‡à¤° à¦¸à§‡à¦° à¦ªà§‹à¦¯à¦¼à¦¾ à®šà¯‡à®°à¯ à®ªà®Ÿà®¿ à°¸à±‡à°°à± à²¸à³‡à²°à³ à´¸àµ‡àµ¼ àª¶à«‡àª° à¨¸à©‡à¨° Ø³ÛŒØ± à¤ªà¤¾à¤µ à®ªà®¾à®µà¯ à°ªà°¾à°µà± à²ªà²¾à²µà³ à´ªà´¾à´µàµ àªªàª¾àªµ à¨ªà¦¾à¦¾à¨µ Ù¾Ø§Ø¤', 'kg'],
  ];
  const m = {};
  for (const [words, c] of groups) for (const w of words.split(' ')) if (w) m[w] = c;
  return m;
})();

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';
const NATIVE_INTENT_RE = new RegExp(`${B}(?:${NATIVE_INTENT.join('|')})${A}`, 'u');
const NATIVE_QUANTITY_RE = new RegExp(`${B}([${NATIVE_DIGITS}]+)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// The most common real-world mix: ASCII digits + native unit ("500 à®•à®¿à®°à®¾à®®à¯", "2 à¤•à¤¿à¤²à¥‹")
const MIXED_QUANTITY_RE = new RegExp(`${B}(\\d+(?:\\.\\d+)?)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// Devanagari spoken fractions: "à¤†à¤§à¤¾ à¤•à¤¿à¤²à¥‹", "à¤¡à¥‡à¤¢à¤¼ à¤•à¤¿à¤²à¥‹"...
const NATIVE_FRACTION_RE = new RegExp(`${B}(à¤†à¤§à¤¾|à¤…à¤°à¥à¤§à¤¾|à¤†à¤°à¥à¤§à¤¾|à¤¸à¤µà¤¾|à¤¡à¥‡à¤¢à¤¼|à¤¢à¤¾à¤ˆ)\\s*(à¤•à¤¿à¤²à¥‹|à¤•à¥‡à¤œà¥€|à¤—à¥à¤°à¤¾à¤®|à¤²à¥€à¤Ÿà¤°)${A}`, 'u');
const NATIVE_FRACTION_VALUES = { 'à¤†à¤§à¤¾': 0.5, 'à¤…à¤°à¥à¤§à¤¾': 0.5, 'à¤†à¤°à¥à¤§à¤¾': 0.5, 'à¤¸à¤µà¤¾': 1.25, 'à¤¡à¥‡à¤¢à¤¼': 1.5, 'à¤¢à¤¾à¤ˆ': 2.5 };
const NATIVE_ITEM_TAIL_RE = new RegExp(
  `\\s*(?:${['à¤šà¤¾à¤¹à¤¿à¤', 'à¤­à¥‡à¤œ à¤¦à¥‹', 'à¤­à¥‡à¤œ à¤¦à¥‡à¤¨à¤¾', 'à¤¦à¥‡ à¤¦à¥‹', 'à¤¦à¥‡ à¤¦à¥‡à¤¨à¤¾', 'à¤¬à¤¨à¤¾ à¤¦à¥‹', 'à¤¬à¤¨à¤¾ à¤¦à¥‡à¤¨à¤¾', 'à¤°à¤– à¤¦à¥‹', 'à¤ªà¥ˆà¤• à¤•à¤° à¤¦à¥‹', 'à¤¤à¥ˆà¤¯à¤¾à¤° à¤•à¤° à¤¦à¥‹', 'à¤˜à¤° à¤­à¥‡à¤œ', 'à¤¡à¤¿à¤²à¥€à¤µà¤° à¤•à¤° à¤¦à¥‹', 'à¤ªà¤¾à¤¹à¤¿à¤œà¥‡', 'à¤ªà¤¾à¤ à¤µà¤¾', 'à¤ªà¤¾à¤ à¤µà¥‚à¤¨ à¤¦à¥à¤¯à¤¾', 'à¦¬à¦¾à¦¨à¦¿à¦¯à¦¼à§‡ à¦¦à¦¿à¦¨', 'à¦¤à§ˆà¦°à¦¿ à¦•à¦°à§‡ à¦¦à¦¿à¦¨', 'à¦°à§‡à¦–à§‡ à¦¦à¦¿à¦¨', 'à¦ªà§à¦¯à¦¾à¦• à¦•à¦°à§‡ à¦¦à¦¿à¦¨', 'à¦ªà¦¾à¦ à¦¿à¦¯à¦¼à§‡ à¦¦à¦¿à¦¨', 'à®µà¯‡à®£à¯à®Ÿà¯à®®à¯', 'à®…à®©à¯à®ªà¯à®ªà¯à®™à¯à®•', 'à®•à¯à®Ÿà¯à®™à¯à®•', 'à®šà¯†à®žà¯à®šà¯ à®•à¯à®Ÿà¯à®™à¯à®•', 'à®°à¯†à®Ÿà®¿ à®ªà®£à¯à®£à¯à®™à¯à®•', 'à®ªà¯‡à®•à¯ à®ªà®£à¯à®£à¯à®™à¯à®•', 'à°•à°¾à°µà°¾à°²à°¿', 'à°ªà°‚à°ªà°‚à°¡à°¿', 'à°‡à°µà±à°µà°‚à°¡à°¿', 'à°¤à°¯à°¾à°°à± à°šà±‡à°¯à°‚à°¡à°¿', 'à°°à±†à°¡à±€ à°šà±‡à°¯à°‚à°¡à°¿', 'à°ªà±à°¯à°¾à°•à± à°šà±‡à°¯à°‚à°¡à°¿', 'à²¬à³‡à²•à³', 'à²•à²³à²¿à²¸à²¿', 'à²•à³Šà²¡à²¿', 'à²¤à²¯à²¾à²°à²¿à²¸à²¿ à²•à³Šà²¡à²¿', 'à²°à³†à²¡à²¿ à²®à²¾à²¡à²¿', 'à²ªà³à²¯à²¾à²•à³ à²®à²¾à²¡à²¿', 'à´µàµ‡à´£à´‚', 'à´¤à´°àµ‚', 'à´…à´¯à´•àµà´•àµ‚', 'à´šàµ†à´¯àµà´¤àµ à´¤à´°àµ‚', 'à´‰à´£àµà´Ÿà´¾à´•àµà´•à´¿ à´¤à´°àµ‚', 'à´ªà´¾à´•àµà´•àµ à´šàµ†à´¯àµà´¤àµ à´¤à´°àµ‚', 'àªœà«‹àªˆàª', 'àª®à«‹àª•àª²à«€ àª¦à«‹', 'àª†àªªà«€ àª¦à«‹', 'àª¬àª¨àª¾àªµà«€ àª†àªªà«‹', 'àª¤à«ˆàª¯àª¾àª° àª•àª°à«€ àª†àªªà«‹', 'àª°à«‡àª¡à«€ àª•àª°à«€ àª¦à«‹', 'àªªà«‡àª• àª•àª°à«€ àª¦à«‹', 'àª°àª¾àª–à«€ àª¦à«‹', 'à¨šà¨¾à¨¹à©€à¨¦à¨¾', 'à¨­à©‡à¨œ à¨¦à¨¿à¨“', 'à¨¦à©‡ à¨¦à¨¿à¨“', 'à¨¬à¨£à¨¾ à¨¦à¨¿à¨“', 'à¨¤à¨¿à¨†à¨° à¨•à¨° à¨¦à¨¿à¨“', 'à¨ªà©ˆà¨• à¨•à¨° à¨¦à¨¿à¨“', 'à¨°à©±à¨– à¨¦à¨¿à¨“', 'Ú†Ø§ÛÛŒÛ’', 'Ø¨Ú¾ÛŒØ¬ Ø¯Ùˆ', 'Ø¯Û’ Ø¯Ùˆ', 'Ø¨Ù†Ø§ Ø¯Ùˆ', 'ØªÛŒØ§Ø± Ú©Ø± Ø¯Ùˆ', 'Ù¾ÛŒÚ© Ú©Ø± Ø¯Ùˆ', 'Ú¯Ú¾Ø± Ø¨Ú¾ÛŒØ¬ Ø¯Ùˆ'].join('|')})${A}.*$`,
  'u'
);

// Customer name: tried in priority order, first match wins
const CUSTOMER_RES = [
  /order\s*from\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+\+)/i,
  /(?:customer|client)\s*[:\-]\s*([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bsold\b[^,.]*?\bto\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bfor\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\b([A-Za-z][A-Za-z ]{1,30}?)\s+ne\b/i, // Hinglish: "ravi kirana ne 5kg namkeen mange"
];

const UNIT_NORMALIZE = {
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', keji: 'kg',
  gram: 'g', grams: 'g', graam: 'g', gms: 'g', gm: 'g', g: 'g',
  dozen: 'dozen', darjan: 'dozen',
  pcs: 'pcs', pieces: 'pcs', piece: 'pcs', pees: 'pcs', pis: 'pcs', nag: 'pcs',
  ennam: 'pcs', ennikkai: 'pcs', mukka: 'pcs', item: 'pcs', ta: 'pcs',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', l: 'l',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  ser: 'kg', seer: 'kg', sher: 'kg', pav: 'kg', paav: 'kg', poa: 'kg',
  tola: 'g', thola: 'g', tol: 'g', ratti: 'g', chatak: 'g', chhatank: 'g', masha: 'g', vori: 'g',
};

const ITEM_TAIL_STOP = /\s+(?:mange|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|please|ke\s+liye|pahije|pathva|banvun|kavali|beku|venam|venum|chahida|joie|kalisi|kaluhisi|anuppunga|pampandi|kudunga|tharu|pathan|din|dya|venam|bana do|bana dena|de do|de dena|bhej do|bhej dena|taiyar kar do|pack kar do|pathavun dya|banvun dya|pathiye din|baniye din|pack kore din|rekhe din|ready pannunga|pack pannunga|pampincheyandi|ivvandi|ready cheyandi|pack cheyandi|ready madi|pack madi|ittu kodi|madi kodi|ayachu tharu|ayach tharu|cheithu tharu|undakki tharu|pack cheythu|mokli do|mokli aapo|aapi do|banavi aapo|ready kari do|pack kari do|rakhi do|bhej deo|bana deo|de deo|tyaar kar deo|ready kar deo|pack kar deo|rakh deo|bhej dein|de dein|bana dein|tayyar kar dein|delivery kar do)\b.*$/i;

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
  if (m && m[1].trim()) return m[1].trim().replace(ITEM_TAIL_STOP, '').replace(NATIVE_ITEM_TAIL_RE, '').replace(/\s+/g, ' ');
  m = before.match(/([a-z][a-z]{2,24})\s*(?:ke|ka|ki|of)?\s*$/i);
  if (m && !/^(from|order|total|cost|price|profit|for|sold|sell)$/i.test(m[1])) return m[1].trim();
  return null;
}
function matchQuantity(text) {
  const qtyMatch = text.match(QUANTITY_RE);
  if (qtyMatch) {
    return {
      quantity: toNum(qtyMatch[1]),
      unit: UNIT_NORMALIZE[qtyMatch[2].toLowerCase()] || null,
      match: qtyMatch,
    };
  }
  const nq = text.match(NATIVE_QUANTITY_RE);
  if (nq) {
    return {
      quantity: toNum(normalizeDigits(nq[1])),
      unit: NATIVE_UNIT_MAP[nq[2]] || null,
      match: nq,
    };
  }
  const mq = text.match(MIXED_QUANTITY_RE);
  if (mq) {
    return {
      quantity: toNum(mq[1]),
      unit: NATIVE_UNIT_MAP[mq[2]] || null,
      match: mq,
    };
  }
  const nfq = text.match(NATIVE_FRACTION_RE);
  if (nfq) {
    return {
      quantity: NATIVE_FRACTION_VALUES[nfq[1]] || null,
      unit: NATIVE_UNIT_MAP[nfq[2]] || null,
      match: nfq,
    };
  }
  const fq = text.match(FRACTION_QTY_RE);
  if (fq) {
    return {
      quantity: FRACTION_VALUES[fq[1].toLowerCase()] || null,
      unit: UNIT_NORMALIZE[fq[2].toLowerCase()] || null,
      match: fq,
    };
  }
  return null;
}

function parseWithRegex(text) {
  if (!text || !(ROMAN_INTENT_RE.test(text) || NATIVE_INTENT_RE.test(text))) return null;
  const customer = extractCustomer(text);
  const qty = matchQuantity(text);
  const quantity = qty ? qty.quantity : null;
  const unit = qty ? qty.unit : null;
  const item = extractItem(text, qty ? qty.match : null);
  let costPrice = null, totalAmount = null, profitPercent = null, profitAmount = null;
  const cm = text.match(COST_RE); if (cm) costPrice = toNum(cm[1]);
  const pd = text.match(PROFIT_PCT_RE);
  const pw = text.match(PROFIT_PCT_WORD_RE);
  if (pd) profitPercent = toNum(pd[1]); else if (pw) profitPercent = toNum(pw[1]);
  const pa = text.match(PROFIT_AMT_RE); if (pa) profitAmount = toNum(pa[1]);
  const sm = text.match(SOLD_FOR_RE); if (sm) totalAmount = toNum(sm[1]);
  const tm = text.match(TOTAL_RE); if (tm) totalAmount = toNum(tm[1]);
  if (costPrice == null && totalAmount == null && quantity == null) return null;
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
    if (ai && (ai.costPrice != null || ai.totalAmount != null || ai.quantity != null)) return ai;
  }
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
/** WhatsApp reports masked phones ("+91â€¦â€¦â€¦39") as chat/profile display names - never treat those as names. */
function isMaskedName(name) { return /[â€¢â€¦]/.test(String(name || '')); }
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
 * profile/display name (it's often a masked "+91â€¦â€¦â€¦39" or a random nickname).
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
  // The SQLite store requires the parent directory to exist at open time.
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

      if (process.env.AUTO_REPLY !== 'false') {
        const pricedReply = rec.totalAmount != null;
        await client.message.send(chatJid, {
          type: 'text',
          text: pricedReply
            ? `✅ *ऑर्डर मिल गया!*\n` +
              `📦 ${rec.quantity ?? '—'}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
              `💰 लागत: ₹${rec.costPrice ?? '—'} | मुनाफ़ा: ₹${rec.profitAmount ?? '—'}${rec.profitPercent != null ? ` (${rec.profitPercent}%)` : ''}\n` +
              `🧾 कुल: ₹${rec.totalAmount ?? '—'}\n\nधन्यवाद! 🙏`
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
function resolvePendingItem(pendingId, sellPrice, costPrice, unit, pieceWeight) {
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

app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: Boolean(POOLSIDE_API_KEY), aiModel: POOLSIDE_MODEL, botStarted: Boolean(client) }));
app.get('/api/status', auth, (req, res) =>
  res.json({ ...botStatus, aiConfigured: Boolean(POOLSIDE_API_KEY), aiModel: POOLSIDE_MODEL })
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
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return res.status(400).json({ error: 'sellPrice (number > 0) required' });
  }
  const result = resolvePendingItem(req.params.id, sellPrice, costPrice, unit, pieceWeight);
  if (!result) return res.status(404).json({ error: 'pending item not found' });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`VyaparTrack server on :${PORT}`);
  console.log(`API token (save it!): ${API_TOKEN}`);
  startBot().catch((err) => console.error('[bot] failed to start:', err.message));
});
