// Poolside AI client - uses poolside/laguna-xs-2.1 to extract structured orders
// from messy natural-language WhatsApp messages. Key is read from .env only,
// never hardcoded or logged.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE_URL = process.env.POOLSIDE_BASE_URL || 'https://api.poolside.ai/v1';
const MODEL = process.env.POOLSIDE_MODEL || 'poolside/laguna-xs-2.1';

const SYSTEM_PROMPT = `You are an order-extraction engine for small Indian businesses.
Extract a JSON object from the message with EXACTLY these fields:
{"customer": string|null, "item": string|null, "quantity": number|null, "unit": "kg"|"g"|"pcs"|"dozen"|"l"|null, "costPrice": number|null, "profitPercent": number|null, "profitAmount": number|null, "totalAmount": number|null}
Rules:
- costPrice = what the shopkeeper paid (cost / CP / base price).
- A message can be a valid order with only customer/item/quantity (price discussed later) - extract what is present, leave the rest null.
- If profit is given as a percent of cost, compute profitAmount = costPrice * pct / 100.
- If profit is given as an amount, compute profitPercent = profitAmount / costPrice * 100 (round to 2 decimals).
- totalAmount = costPrice + profitAmount when not stated.
- Amounts are INR numbers only, no symbols.
- Reply with ONLY the JSON object, no markdown, no explanation.`;

function isConfigured() {
  return Boolean(process.env.POOLSIDE_API_KEY && process.env.POOLSIDE_API_KEY !== 'your_poolside_api_key_here');
}

async function extractOrder(messageText) {
  if (!isConfigured()) return null;

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POOLSIDE_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: messageText },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[poolside] API error ${res.status} - falling back to regex parser`);
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
      raw: messageText,
    };
  } catch (err) {
    console.error('[poolside] request failed - falling back to regex parser:', err.message);
    return null;
  }
}

module.exports = { extractOrder, isConfigured, MODEL };
