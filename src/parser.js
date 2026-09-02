// Regex-based order parser. Works fully offline - no API key needed.
// Handles messy Hinglish / informal messages like:
//   "Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees"
//   "sold 1kg kaju katli to sharma uncle, cost 850, profit 20%"
//   "ravi kirana ne 5kg namkeen mange, cost 400, profit 18%"

const UNITS = 'kg|kgs|kilogram|kilograms|gram|grams|gms|gm|g|dozen|pcs|pieces|piece|litre|litres|liter|liters|l';

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
const ORDER_INTENT_RE = /\b(order|ordered|sold|sale|sell|bill|invoice|mangwaya|mange|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|kitna|kitne|mujhe)\b|(?:can|may)\s+i\s+(?:get|have|order)|i\s+(?:want|need)\b/i;

// Customer name: tried in priority order, first match wins
const CUSTOMER_RES = [
  /order\s*from\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+\+)/i,
  /(?:customer|client)\s*[:\-]\s*([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bsold\b[^,.]*?\bto\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\bfor\s+([A-Za-z][A-Za-z .]{1,30}?)(?=\s*[,.!]|$|\s+\d|\s+cost|\s+price|\s+profit)/i,
  /\b([A-Za-z][A-Za-z ]{1,30}?)\s+ne\b/i, // Hinglish: "ravi kirana ne 5kg namkeen mange"
];

const UNIT_NORMALIZE = {
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  gram: 'g', grams: 'g', gms: 'g', gm: 'g', g: 'g',
  dozen: 'dozen', pcs: 'pcs', pieces: 'pcs', piece: 'pcs',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', l: 'l',
};

const ITEM_TAIL_STOP = /\s+(?:mange|mangwaya|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|please|ke\s+liye)\b.*$/i;

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function titleCase(name) {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
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
  // item right after the unit: "500 grams ladoo", "2kg ke laddu"
  let m = after.match(/^\s*(?:ke\s+|ka\s+|ki\s+|of\s+)?([a-z][a-z ]{1,25}?)(?=\s*[,.!=]|$|\s+\d|\s+cost|\s+price|\s+profit|\s+for|\s+sold|\s+to\b|\s+ne\b)/i);
  if (m && m[1].trim()) {
    return m[1].trim().replace(ITEM_TAIL_STOP, '').replace(/\s+/g, ' ');
  }
  // item before the qty: "ladoo 500 grams", "chocolate cake 2kg"
  m = before.match(/([a-z][a-z]{2,24})\s*(?:ke|ka|ki|of)?\s*$/i);
  if (m && !/^(from|order|total|cost|price|profit|for|sold|sell)$/i.test(m[1])) return m[1].trim();
  return null;
}

/**
 * Parse a WhatsApp message into a structured order.
 * Returns null when the message does not look like an order.
 */
function parseOrder(text) {
  if (!text || !ORDER_INTENT_RE.test(text)) return null;

  const customer = extractCustomer(text);

  const qtyMatch = text.match(QUANTITY_RE);
  const quantity = qtyMatch ? toNum(qtyMatch[1]) : null;
  const unit = qtyMatch ? UNIT_NORMALIZE[qtyMatch[2].toLowerCase()] : null;
  const item = extractItem(text, qtyMatch);

  let costPrice = null;
  let totalAmount = null;
  let profitPercent = null;
  let profitAmount = null;

  const costMatch = text.match(COST_RE);
  if (costMatch) costPrice = toNum(costMatch[1]);

  const pctDirect = text.match(PROFIT_PCT_RE);
  const pctWord = text.match(PROFIT_PCT_WORD_RE);
  if (pctDirect) profitPercent = toNum(pctDirect[1]);
  else if (pctWord) profitPercent = toNum(pctWord[1]);

  const profitAmtMatch = text.match(PROFIT_AMT_RE);
  if (profitAmtMatch) profitAmount = toNum(profitAmtMatch[1]);

  // "sold ... for 800" -> selling price (total), but never the quantity itself
  const soldMatch = text.match(SOLD_FOR_RE);
  if (soldMatch) totalAmount = toNum(soldMatch[1]);

  // explicit "total = 230" / "total amount 230"
  const totalMatch = text.match(TOTAL_RE);
  if (totalMatch) totalAmount = toNum(totalMatch[1]);

  // Need a cost, a total, or a quantity to be a real order record.
  // Price-less inquiries like "can i get 500 grams laddu" are orders too.
  if (costPrice == null && totalAmount == null && quantity == null) return null;

  // Derive missing values
  if (costPrice != null && profitPercent != null && profitAmount == null) {
    profitAmount = round2((costPrice * profitPercent) / 100);
  }
  if (costPrice != null && totalAmount == null && profitAmount != null) {
    totalAmount = round2(costPrice + profitAmount);
  }
  if (totalAmount != null && costPrice != null && profitAmount == null) {
    profitAmount = round2(totalAmount - costPrice);
  }
  if (costPrice != null && profitAmount != null && profitPercent == null && costPrice > 0) {
    profitPercent = round2((profitAmount / costPrice) * 100);
  }
  if (totalAmount == null && costPrice != null && profitAmount == null) {
    totalAmount = costPrice; // break-even / unknown margin
  }

  return {
    customer,
    item,
    quantity,
    unit,
    costPrice,
    profitPercent,
    profitAmount,
    totalAmount,
    source: 'regex',
    raw: text,
  };
}

module.exports = { parseOrder };
