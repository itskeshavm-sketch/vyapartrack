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

/** Convert a quantity between compatible units (kg<->g, l<->ml, dozen<->pcs). */
const UNIT_DIMENSION = { kg: 'mass', g: 'mass', ml: 'volume', l: 'volume', pcs: 'count', dozen: 'count' };
const UNIT_TO_BASE = { kg: 1000, g: 1, ml: 1, l: 1000, pcs: 1, dozen: 12 };
function convertQty(qty, fromUnit, toUnit) {
  if (qty == null) return null;
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
  if (UNIT_DIMENSION[fromUnit] !== UNIT_DIMENSION[toUnit]) return null;
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
  // Convert when the order unit differs but is compatible ("500 ml" vs catalog per "l")
  const qtyInItemUnits = unitAgnostic ? qty : convertQty(qty, order.unit, item.unit);
  if (qtyInItemUnits == null) return order;
  const priced = { ...order };
  if (priced.totalAmount == null) priced.totalAmount = round2(item.sellPrice * qtyInItemUnits);
  if (priced.costPrice == null && item.costPrice != null) priced.costPrice = round2(item.costPrice * qtyInItemUnits);
  if (priced.costPrice != null && priced.totalAmount != null) {
    priced.profitAmount = round2(priced.totalAmount - priced.costPrice);
    priced.profitPercent = priced.costPrice > 0 ? round2((priced.profitAmount / priced.costPrice) * 100) : null;
  }
  priced.pricedBy = 'catalog';
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
const NATIVE_DIGITS = '०१२३४५६७८९০১২৩৪৫৬৭৮৯௦௧௨௩௪௫௬௭௮௯౦౧౨౩౪౫౬౭౮౯೦೧೨೩೪೫೬೭೮೯൦൧൨൩൪൫൬൭൮൯੦੧੨੩੪੫੬੭੮੯۰۱۲۳۴۵۶۷۸۹';
const DIGIT_MAP = (() => {
  const m = {};
  for (let c = 0; c < NATIVE_DIGITS.length; c += 10) {
    for (let i = 0; i < 10; i++) m[NATIVE_DIGITS[c + i]] = String(i);
  }
  return m;
})();
function normalizeDigits(s) { return String(s).replace(/./g, (ch) => DIGIT_MAP[ch] || ch); }

const NATIVE_INTENT = [
  'चाहिए', 'भेज दो', 'भेज देना', 'भेजो', 'बना दो', 'बना देना', 'दे दो', 'दे देना',
  'तैयार कर दो', 'तैयार कर देना', 'पैक कर दो', 'पैक कर देना', 'पैक करके भेज दो',
  'रख देना', 'डिलीवर कर दो', 'घर भेज', 'कितने का', 'कितने में', 'कितना लगेगा',
  'भाव बताओ', 'रेट क्या', 'प्राइस बताओ', 'टोटल कितना', 'ऑर्डर',
  'بھیج دو', 'بھیج دیں', 'بنا دو', 'بنا دیں', 'تیار کر دو', 'پیک کر دو', 'گھر بھیج',
  'کتنے کا', 'کتنے میں', 'کتنا لگے گا', 'قیمت کیا', 'بھاؤ کیا', 'ٹوٹل کتنا', 'آرڈر', 'چاہیے',
  'पाहिजे', 'पाठवा', 'पाठवून द्या', 'बनवून द्या', 'तयार करून', 'पॅक करून',
  'किती पडेल', 'किती होईल', 'भाव काय', 'रेट सांगा', 'किंमत सांगा', 'टोटल किती',
  'চাই', 'অর্ডার', 'পাঠিয়ে দিন', 'বানিয়ে দিন', 'তৈরি করে দিন',
  'রেখে দিন', 'প্যাক করে দিন', 'কত পড়বে', 'কত হবে', 'দাম কত', 'কত টাকা', 'টোটাল কত',
  'வேண்டும்', 'ஆர்டர்', 'அனுப்புங்க', 'அனுப்பி விடுங்க', 'செஞ்சு குடுங்க',
  'ரெடி பண்ணுங்க', 'பேக் பண்ணுங்க', 'வீட்டுக்கு அனுப்புங்க',
  'எவ்வளவு ஆகும்', 'எவ்வளவு வரும்', 'ரேட் என்ன', 'விலை என்ன', 'டோட்டல் எவ்வளவு',
  'కావాలి', 'ఆర్డర్', 'పంపండి', 'పంపించేయండి', 'ఇవ్వండి', 'ఇచ్చేయండి',
  'తయారు చేయండి', 'రెడీ చేయండి', 'ప్యాక్ చేయండి',
  'ఎంత అవుతుంది', 'ఎంత పడుతుంది', 'రేట్ ఎంత', 'ధర ఎంత', 'టోటల్ ఎంత',
  'ಬೇಕು', 'ಆರ್ಡರ್', 'ಕಳಿಸಿ', 'ಕಳುಹಿಸಿ', 'ಮನೆಗೆ ಕಳಿಸಿ', 'ತಯಾರಿಸಿ ಕೊಡಿ',
  'ಇಟ್ಟು ಕೊಡಿ', 'ರೆಡಿ ಮಾಡಿ', 'ಪ್ಯಾಕ್ ಮಾಡಿ',
  'ಎಷ್ಟು ಆಗುತ್ತೆ', 'ಎಷ್ಟು ಬರುತ್ತೆ', 'ಬೆಲೆ ಎಷ್ಟು', 'ರೇಟ್ ಎಷ್ಟು', 'ಟೋಟಲ್ ಎಷ್ಟು',
  'വേണം', 'ഓർഡർ', 'അയച്ചു തരൂ', 'അയക്കൂ', 'ചെയ്ത് തരൂ', 'ഉണ്ടാക്കി തരൂ',
  'പാക്ക് ചെയ്ത് തരൂ', 'വീട്ടിൽ അയക്കൂ',
  'എത്ര ആകും', 'എത്ര വരും', 'വില എത്ര', 'റേറ്റ് എത്ര', 'ടോട്ടൽ എത്ര',
  'જોઈએ', 'ઓર્ડર', 'મોકલી દો', 'મોકલી આપો', 'આપી દો', 'આપી આપો', 'બનાવી આપો',
  'તૈયાર કરી', 'રેડી કરી', 'પેક કરી', 'રાખી દો',
  'કેટલા થશે', 'કેટલું પડશે', 'ભાવ કેટલો', 'રેટ કેટલો', 'ટોટલ કેટલું',
  'ਚਾਹੀਦਾ', 'ਆਰਡਰ', 'ਭੇਜ ਦਿਓ', 'ਬਣਾ ਦਿਓ', 'ਤਿਆਰ ਕਰ ਦਿਓ', 'ਰੈਡੀ ਕਰ ਦਿਓ',
  'ਪੈਕ ਕਰ ਦਿਓ', 'ਰੱਖ ਦਿਓ', 'ਕਿੰਨੇ ਦਾ', 'ਕਿੰਨੇ ਪੈਸੇ', 'ਰੇਟ ਕੀ', 'ਭਾਅ ਕੀ', 'ਟੋਟਲ ਕਿੰਨਾ',
];
const NATIVE_UNITS = [
  'किलो', 'केजी', 'किलोग्राम', 'किलोग्रॅम', 'কিলো', 'কেজি', 'কিলোগ্রাম', 'கிலோ', 'கிலோகிராம்',
  'కిలో', 'కిలోగ్రామ్', 'కేజీ', 'ಕಿಲೋ', 'ಕಿಲೋಗ್ರಾಂ', 'ಕೆಜಿ', 'കിലോ', 'കിലോഗ്രാം',
  'કિલો', 'કિલોગ્રામ', 'ਕਿਲੋ', 'ਕਿਲੋਗ੍ਰਾਮ', 'ਕੇਜੀ', 'کلو', 'کلوگرام',
  'ग्राम', 'ग्रॅम', 'গ্রাম', 'கிராம்', 'గ్రాము', 'ಗ್ರಾಂ', 'ಗ್ರಾಮ', 'ഗ്രാം', 'ગ્રામ', 'ਗ੍ਰਾਮ', 'گرام',
  'तोला', 'तोळा', 'तोळ', 'रत्ती', 'छटांक', 'চটক', 'ভরি', 'তোলা', 'தோலா', 'தோலை',
  'తులం', 'తులా', 'ತೊಲ', 'ತೊಲೆ', 'ರತ್ತಿ', 'തൊല', 'രത്തി', 'તોલા', 'તોલ', 'રતી',
  'ਤੋਲਾ', 'ਤੋਲ', 'ਰੱਤੀ', 'تولہ', 'تول', 'رتی', 'ماشہ',
  'लिटर', 'লিটার', 'லிட்டர்', 'లీటర్', 'ಲೀಟರ್', 'ലിറ്റർ', 'લીટર', 'ਲੀਟਰ', 'لیٹر',
  'मिलीलीटर', 'मिली',
  'पीस', 'नग', 'পিস', 'টা', 'பீஸ்', 'పీస్', 'ముక్క', 'ಪೀಸ್', 'ಐಟಂ', 'എണ്ണം', 'પીસ', 'નંગ', 'ਪੀਸ', 'ਨਗ', 'پیس', 'عدد',
  'दर्जन', 'डझन', 'ডজন', 'டஜன்', 'డజన్', 'ಡಜನ್', 'ഡസൻ', 'ડઝન', 'ਦਰਜਨ', 'درجن',
  'కిలోలు', 'కిలోల', 'గ్రాములు', 'గ్రాముల', 'లీటర్లు', 'డజన్లు',
  'सेर', 'शेर', 'সের', 'পোয়া', 'சேர்', 'படி', 'సేరు', 'ಸೇರು', 'സേർ', 'શેર', 'ਸੇਰ', 'سیر',
  'पाव', 'பாவு', 'పావు', 'ಪಾವು', 'പാവ്', 'પાવ', 'ਪਾਵ', 'پاؤ',
];
const NATIVE_UNIT_MAP = (() => {
  const groups = [
    ['किलो केजी किलोग्राम किलोग्रॅম কিলো কেজি কিলোগ্রাম கிலோ கிலோகிராம் కిలో కిలోగ్రామ్ కేజీ ಕಿಲೋ ಕಿಲೋಗ್ರಾಂ ಕೆಜಿ കിലോ കിലോഗ്രാം કિલો કિલોગ્રામ ਕਿਲੋ ਕਿਲੋਗ੍ਰਾਮ ਕੇਜੀ کلو کلوگرام', 'kg'],
    ['ग्राम ग्रॅम গ্রাম கிராம் గ్రాము ಗ್ರಾಂ ಗ್ರಾಮ ഗ്രാം ગ્રામ ਗ੍ਰਾਮ گرام तोला तोळा तोळ रत्ती छटांक ভরি তোলা தோலா தோலை తులం తులా ತೊಲ ತೊಲೆ ರತ್ತಿ തൊല രത്തિ તોલા તોલ રતી ਤੋਲਾ ਤੋਲ ਰੱਤੀ تولہ تول رتی ماشہ', 'g'],
    ['लीटर লিটার லிட்டர் లీటర్ ಲೀಟರ್ ലിറ്റർ લીટર ਲੀટર لیٹر', 'l'],
  ['मिलीलीटर मिली', 'ml'],
    ['पीस नग পিস টা பீஸ் పీస్ ముక్క ಪೀಸ್ ಐಟಂ എണ്ണം પીસ નંગ ਪੀਸ ਨਗ پیس عدد', 'pcs'],
    ['दर्जन डझन ডজন டஜன் డజನ್ ಡಜನ್ ഡസൻ ડઝન ਦર்ஜન درجن', 'dozen'],
    ['కిలోలు కిలోల గ్రాములు గ్రాముల లీటర్లు డజన్లు', 'dozen'],
    ['सेर शेर সের পোয়া சேர் படி సేరు ಸೇರು സേർ શેર ਸੇਰ سیر पाव பாவு పావు ಪಾವು പാവ് પાવ ਪাাਵ پاؤ', 'kg'],
  ];
  const m = {};
  for (const [words, c] of groups) for (const w of words.split(' ')) if (w) m[w] = c;
  return m;
})();

const B = '(?<![\\p{L}\\p{M}])';
const A = '(?![\\p{L}\\p{M}])';
const NATIVE_INTENT_RE = new RegExp(`${B}(?:${NATIVE_INTENT.join('|')})${A}`, 'u');
const NATIVE_QUANTITY_RE = new RegExp(`${B}([${NATIVE_DIGITS}]+)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// The most common real-world mix: ASCII digits + native unit ("500 கிராம்", "2 किलो")
const MIXED_QUANTITY_RE = new RegExp(`${B}(\\d+(?:\\.\\d+)?)\\s*(${NATIVE_UNITS.join('|')})${A}`, 'u');
// Devanagari spoken fractions: "आधा किलो", "डेढ़ किलो"...
const NATIVE_FRACTION_RE = new RegExp(`${B}(आधा|अर्धा|आर्धा|सवा|डेढ़|ढाई)\\s*(किलो|केजी|ग्राम|लीटर)${A}`, 'u');
const NATIVE_FRACTION_VALUES = { 'आधा': 0.5, 'अर्धा': 0.5, 'आर्धा': 0.5, 'सवा': 1.25, 'डेढ़': 1.5, 'ढाई': 2.5 };
const NATIVE_ITEM_TAIL_RE = new RegExp(
  `\\s*(?:${['चाहिए', 'भेज दो', 'भेज देना', 'दे दो', 'दे देना', 'बना दो', 'बना देना', 'रख दो', 'पैक कर दो', 'तैयार कर दो', 'घर भेज', 'डिलीवर कर दो', 'पाहिजे', 'पाठवा', 'पाठवून द्या', 'বানিয়ে দিন', 'তৈরি করে দিন', 'রেখে দিন', 'প্যাক করে দিন', 'পাঠিয়ে দিন', 'வேண்டும்', 'அனுப்புங்க', 'குடுங்க', 'செஞ்சு குடுங்க', 'ரெடி பண்ணுங்க', 'பேக் பண்ணுங்க', 'కావాలి', 'పంపండి', 'ఇవ్వండి', 'తయారు చేయండి', 'రెడీ చేయండి', 'ప్యాక్ చేయండి', 'ಬೇಕು', 'ಕಳಿಸಿ', 'ಕೊಡಿ', 'ತಯಾರಿಸಿ ಕೊಡಿ', 'ರೆಡಿ ಮಾಡಿ', 'ಪ್ಯಾಕ್ ಮಾಡಿ', 'വേണം', 'തരൂ', 'അയക്കൂ', 'ചെയ്ത് തരൂ', 'ഉണ്ടാക്കി തരൂ', 'പാക്ക് ചെയ്ത് തരൂ', 'જોઈએ', 'મોકલી દો', 'આપી દો', 'બનાવી આપો', 'તૈયાર કરી આપો', 'રેડી કરી દો', 'પેક કરી દો', 'રાખી દો', 'ਚਾਹੀਦਾ', 'ਭੇਜ ਦਿਓ', 'ਦੇ ਦਿਓ', 'ਬਣਾ ਦਿਓ', 'ਤਿਆਰ ਕਰ ਦਿਓ', 'ਪੈਕ ਕਰ ਦਿਓ', 'ਰੱਖ ਦਿਓ', 'چاہیے', 'بھیج دو', 'دے دو', 'بنا دو', 'تیار کر دو', 'پیک کر دو', 'گھر بھیج دو'].join('|')})${A}.*$`,
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
    if (fresh && sock && sock.user) {
      try {
        await sock.sendMessage(jidNormalizedUser(sock), { text: pricingQuestionText(fresh) });
      } catch {}
    }
  }
  return rec;
}

// ============ WhatsApp bot ============
let sock = null;

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
function rememberContact(c) {
  if (!c || !c.id || !c.name) return;
  contactNames.set(c.id, c.name);
  if (c.lid) contactNames.set(c.lid, c.name);
  saveContacts();
  flushPendingNames();
}
function rememberLidMapping(m) {
  if (!m || !m.lid || !m.pn) return;
  lidToPn.set(m.lid, m.pn);
  const name = contactNames.get(m.lid) || contactNames.get(m.pn);
  if (name) { contactNames.set(m.lid, name); contactNames.set(m.pn, name); }
  saveContacts();
  flushPendingNames();
}

/** Saved address-book name for a jid (LID or phone), or null. */
function savedNameFor(jid) {
  const pn = lidToPn.get(jid);
  return contactNames.get(jid) || (pn && contactNames.get(pn)) || null;
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

/** Resolve sender: saved contact name (via jid or linked phone jid) -> pushName -> +number. */
async function resolveSenderName(jid, pushName) {
  const pn = lidToPn.get(jid);
  const saved = contactNames.get(jid) || (pn && contactNames.get(pn)) || null;
  if (saved) return saved;
  if (pushName) return pushName;
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
  startedAt: null,
};

// Pairing codes die ~2-3 minutes after issuance on WhatsApp's side. We treat
// them as valid for 100s, reuse a still-fresh code for the same number, and
// regenerate automatically (keeper below) so the on-screen code never goes stale.
const PAIRING_CODE_TTL_MS = 100000;
let pairingPhone = null;
let pairingCodeAt = 0;
let pairingKeeperRunning = false;
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

/** Keep a live pairing code on screen: re-mint it whenever it expires while unlinked. */
function startPairingKeeper() {
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
  // Saved contact names arrive here on first connect (full address book sync)
  sock.ev.on('messaging-history.set', ({ contacts = [], chats = [] } = {}) => {
    contacts.forEach(rememberContact);
    chats.forEach((ch) => { if (ch.name && ch.id) contactNames.set(ch.id, ch.name); });
    console.log(`[contacts] history sync: ${contacts.length} contacts, map now has ${contactNames.size} names`);
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
        botStatus.startedAt = new Date().toISOString();
        console.log('[bot] QR ready');
      } catch (err) {
        console.error('[bot] QR render failed:', err.message);
      }
    }
    if (connection === 'connecting') botStatus.connecting = true;
    if (connection === 'open') {
      botStatus = { ...botStatus, connected: true, connecting: false, qrDataUrl: null, pairingCode: null, pairingExpiresAt: null, lastError: null };
      pairingPhone = null;
      console.log('[bot] WhatsApp connected');
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
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (e) { console.error('[bot] auth reset failed:', e.message); }
      }
      // Always come back up - logged-out or not, the vendor must be able to re-link.
      setTimeout(() => startBot().catch((e) => console.error(e)), loggedOut ? 2000 : 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      // Ignore newsletters/channels and broadcast statuses - marketing posts
      // there were being parsed as phantom orders.
      const jid = String(msg.key.remoteJid);
      if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
      const senderJid = msg.key.participant || msg.key.remoteJid; // handles groups too
      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || '';
      if (!text) return;
      // Ignore messages that are mostly links (spam/marketing)
      const linkCount = (text.match(/https?:\/\//gi) || []).length;
      if (linkCount >= 1 && text.replace(/https?:\/\/\S+/gi, '').trim().length < 20) return;

      const senderName = await resolveSenderName(senderJid, msg.pushName);

      const order = await parseOrder(text);
      if (!order) return;

      // Catalog pricing + pending queue (shared with the REST API)
      const rec = await recordParsedOrder(order, senderName, senderJid);
      console.log(`[bot] Order: ${rec.customer} | from ${senderJid} pushName=${msg.pushName || 'none'} | ${rec.quantity ?? ''}${rec.unit ?? ''} ${rec.item} | total ${rec.totalAmount ?? '-'}`);

      if (process.env.AUTO_REPLY !== 'false') {
        const pricedReply = rec.totalAmount != null;
        await sock.sendMessage(msg.key.remoteJid, {
          text: pricedReply
            ? `✅ *ऑर्डर मिल गया!*\n` +
              `👤 ${rec.customer}\n` +
              `📦 ${rec.quantity ?? '—'}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
              `💰 लागत: ₹${rec.costPrice ?? '—'} | मुनाफ़ा: ₹${rec.profitAmount ?? '—'}${rec.profitPercent != null ? ` (${rec.profitPercent}%)` : ''}\n` +
              `🧾 कुल: ₹${rec.totalAmount ?? '—'}\n\nधन्यवाद! 🙏`
            : `✅ *आपका ऑर्डर मिल गया!* ${rec.quantity ?? ''}${rec.unit ? ' ' + rec.unit : ''} ${rec.item}\n` +
              `🧾 कीमत जल्द ही कन्फर्म होगी। धन्यवाद! 🙏`,
        }, { quoted: msg });
      }
    } catch (err) {
      console.error('[bot] handler error:', err.message);
    }
  });
}

/** Vendor's own jid ("Message yourself") for price questions and notices. */
function jidNormalizedUser(sock) {
  const raw = String(sock?.user?.id || '');
  return raw.includes('@') ? raw : raw.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

/** Vendor fills prices for a pending item -> save to catalog, re-price open orders. */
function resolvePendingItem(pendingId, sellPrice, costPrice, unit) {
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
  if (!existing) items.unshift(entry);
  saveCatalog(items);
  savePending(list.filter((x) => x.id !== pendingId));

  // Re-price older orders of the same item (incl. synonyms: "tel", "mustard tel"...)
  const pTerms = nameTerms(p.item);
  const orders = loadOrders();
  let updated = 0;
  for (const o of orders) {
    if (!o.item) continue;
    const oTerms = nameTerms(o.item);
    const sameItem = oTerms.size > 0 && pTerms.size > 0
      ? [...pTerms].some((t) => oTerms.has(t))
      : o.item.toLowerCase() === p.item.toLowerCase();
    if (!sameItem) continue;
    if (o.totalAmount != null && o.costPrice != null) continue;
    if (o.quantity == null) continue;
    const qtyIn = o.unit && entry.unit && o.unit !== entry.unit
      ? convertQty(o.quantity, o.unit, entry.unit)
      : o.quantity;
    if (qtyIn == null) continue; // incompatible units (kg vs l), skip
    if (o.totalAmount == null) o.totalAmount = round2(entry.sellPrice * qtyIn);
    if (o.costPrice == null && entry.costPrice != null) o.costPrice = round2(entry.costPrice * qtyIn);
    if (o.costPrice != null && o.totalAmount != null) {
      o.profitAmount = round2(o.totalAmount - o.costPrice);
      o.profitPercent = o.costPrice > 0 ? round2((o.profitAmount / o.costPrice) * 100) : null;
    }
    updated++;
  }
  if (updated) saveOrders(orders);
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

app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: Boolean(POOLSIDE_API_KEY), aiModel: POOLSIDE_MODEL, botStarted: Boolean(sock) }));
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
  if (!existing) items.unshift(entry);
  saveCatalog(items);
  res.json(entry);
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
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return res.status(400).json({ error: 'sellPrice (number > 0) required' });
  }
  const result = resolvePendingItem(req.params.id, sellPrice, costPrice, unit);
  if (!result) return res.status(404).json({ error: 'pending item not found' });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`VyaparTrack server on :${PORT}`);
  console.log(`API token (save it!): ${API_TOKEN}`);
  startPairingKeeper();
  startBot().catch((err) => console.error('[bot] failed to start:', err.message));
});