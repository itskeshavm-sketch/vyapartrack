// VyaparTrack dashboard — thin client that talks to the VyaparTrack server.
// Server URL + API token are stored in localStorage and entered via Settings.

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : '₹' + fmt.format(n));
const STORAGE_KEY = 'vyapartrack.orders.v1';
const SERVER_URL_KEY = 'vyapartrack.server.url';
const API_TOKEN_KEY = 'vyapartrack.server.token';
// Default server URL baked into the APK. User can override in Settings after deploying their own.
// To set your own default, change this string before building.
const DEFAULT_SERVER_URL = 'https://vyapartrack.onrender.com';
const DEFAULT_API_TOKEN = ''; // user enters after deploy

let pollTimer = null;

function loadLocalOrders() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function saveLocalOrders(o) { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); }
function uid() { return 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============ Server API ============
function getServerConfig() {
  const url = (localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const token = localStorage.getItem(API_TOKEN_KEY) || DEFAULT_API_TOKEN;
  return { url, token };
}
function serverConfigured() {
  const c = getServerConfig();
  return Boolean(c.url) && Boolean(c.token);
}

// ============ Direct Poolside API (used when no server is configured) ============
// Lets the app parse orders with AI even before deploying the server.
const POOLSIDE_DIRECT_KEY = ''; // paste your Poolside key here to enable direct AI parsing without a server
const POOLSIDE_DIRECT_MODEL = 'poolside/laguna-xs-2.1';
const POOLSIDE_DIRECT_URL = 'https://inference.poolside.ai/v1';
const POOLSIDE_SYSTEM_PROMPT = `You are an order-extraction engine for small Indian businesses.
Extract a JSON object from the message with EXACTLY these fields:
{"customer": string|null, "item": string|null, "quantity": number|null, "unit": "kg"|"g"|"pcs"|"dozen"|"l"|null, "costPrice": number|null, "profitPercent": number|null, "profitAmount": number|null, "totalAmount": number|null}
Rules:
- costPrice = what the shopkeeper paid (cost / CP / base price).
- If profit is given as a percent of cost, compute profitAmount = costPrice * pct / 100.
- If profit is given as an amount, compute profitPercent = profitAmount / costPrice * 100 (round to 2 decimals).
- totalAmount = costPrice + profitAmount when not stated.
- Amounts are INR numbers only, no symbols.
- Reply with ONLY the JSON object, no markdown, no explanation.`;
async function parseWithPoolsideDirect(text) {
  if (!POOLSIDE_DIRECT_KEY) return null;
  try {
    const res = await fetch(POOLSIDE_DIRECT_URL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + POOLSIDE_DIRECT_KEY },
      body: JSON.stringify({
        model: POOLSIDE_DIRECT_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: POOLSIDE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
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
  } catch (e) { return null; }
}
async function serverFetch(path, opts = {}) {
  const c = getServerConfig();
  if (!c.url) throw new Error('Server not configured. Open Settings.');
  const headers = Object.assign({}, opts.headers || {}, { 'X-API-Token': c.token });
  const res = await fetch(c.url + path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ============ Local regex parser (used as fallback when server is offline) ============
const UNITS = 'kg|kgs|kilogram|kilograms|gram|grams|gms|gm|g|dozen|pcs|pieces|piece|litre|litres|liter|liters|l';
const QUANTITY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i');
const UNIT_NOT_AFTER = new RegExp(`(?!\\s*(?:${UNITS})\\b)`, 'i');
const COST_RE = /(?:total\s*)?(?:cost|cp|base\s*price|buying\s*price|price)\s*(?:of\s*[a-z ]+)?\s*(?:[=:]|is|are)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)/i;
const SOLD_FOR_RE = new RegExp(`\\b(?:sold|sell|selling)\\b\\s*(?:it\\s*)?(?:at|for|in|to\\s+\\w+)?\\s*(?:rs\\.?|rupees|inr|₹)?\\s*(\\d+(?:\\.\\d+)?)\\b${UNIT_NOT_AFTER.source}`, 'i');
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
const UNIT_NORMALIZE = { kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', gram: 'g', grams: 'g', gms: 'g', gm: 'g', g: 'g', dozen: 'dozen', pcs: 'pcs', pieces: 'pcs', piece: 'pcs', litre: 'l', litres: 'l', liter: 'l', liters: 'l', l: 'l' };
const ITEM_TAIL_STOP = /\s+(?:mange|mangwaya|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|please|ke\s+liye)\b.*$/i;
const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
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
function parseOrderLocal(text) {
  if (!text || !ORDER_INTENT_RE.test(text)) return null;
  const customer = extractCustomer(text);
  const qtyMatch = text.match(QUANTITY_RE);
  const quantity = qtyMatch ? toNum(qtyMatch[1]) : null;
  const unit = qtyMatch ? UNIT_NORMALIZE[qtyMatch[2].toLowerCase()] : null;
  const item = extractItem(text, qtyMatch);
  let costPrice = null, totalAmount = null, profitPercent = null, profitAmount = null;
  const cm = text.match(COST_RE); if (cm) costPrice = toNum(cm[1]);
  const pd = text.match(PROFIT_PCT_RE); const pw = text.match(PROFIT_PCT_WORD_RE);
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

// ============ Rendering ============
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function sourceLabel(s) {
  return { whatsapp: '📱 WA', manual: '✍ You', ai: '🤖 AI', regex: '🧮 regex', demo: '🎁 demo' }[s] || s || '—';
}
function renderOrders(orders) {
  const body = $('ordersBody');
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">No orders yet. Connect WhatsApp, type one above, or load demo data.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((o) => `
    <tr data-id="${o.id}">
      <td class="cust">${escapeHtml(o.customer || 'Unknown')}</td>
      <td><span class="item-tag">${escapeHtml(o.item || '—')}</span></td>
      <td class="qty">${o.quantity != null ? fmt.format(o.quantity) + (o.unit ? ' ' + o.unit : '') : '—'}</td>
      <td class="money">${money(o.costPrice)}</td>
      <td>${o.profitPercent != null ? `<span class="profit-pct">+${o.profitPercent}%</span>` : '—'}</td>
      <td class="money profit-amt">${money(o.profitAmount)}</td>
      <td class="money total-amt">${money(o.totalAmount)}</td>
      <td><span class="src-tag src-${escapeHtml(o.source || 'manual')}">${escapeHtml(sourceLabel(o.source))}</span></td>
      <td class="time-cell" title="${new Date(o.timestamp).toLocaleString('en-IN')}">${timeAgo(o.timestamp)}</td>
      <td><button class="share-btn" data-id="${o.id}" title="Share on WhatsApp">📤</button></td>
      <td><button class="del-btn" data-id="${o.id}" title="Delete">✕</button></td>
    </tr>`).join('');
}
function refreshStats(orders) {
  let revenue = 0, cost = 0, profit = 0;
  for (const o of orders) {
    if (o.totalAmount != null) revenue += o.totalAmount;
    if (o.costPrice != null) cost += o.costPrice;
    if (o.profitAmount != null) profit += o.profitAmount;
  }
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  $('statOrders').textContent = fmt.format(orders.length);
  $('statRevenue').textContent = money(revenue);
  $('statProfit').textContent = money(profit);
  $('statCost').textContent = money(cost);
  $('statMargin').textContent = `${round2(margin)}% avg margin`;
}
function renderAll() {
  const orders = loadLocalOrders();
  renderOrders(orders);
  refreshStats(orders);
}

async function refreshFromServer() {
  if (!serverConfigured()) return;
  try {
    const orders = await serverFetch('/api/orders');
    saveLocalOrders(orders);
    renderAll();
    updateAIStatus(orders.length > 0 ? 'AI on (server)' : 'Connected');
  } catch (err) {
    updateAIStatus('Server offline');
  }
}

function updateAIStatus(text) {
  $('aiStatusText').textContent = text;
  $('aiStatus').className = 'status-pill ai ' + (text.toLowerCase().includes('offline') || text.toLowerCase().includes('off') ? 'off' : 'on');
}

// ============ Event handlers ============
$('orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('orderText');
  const btn = e.target.querySelector('button');
  const result = $('formResult');
  const text = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  result.classList.add('hidden');
  try {
    let order;
    let usedSource = 'manual';
    if (serverConfigured()) {
      order = await serverFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      usedSource = order.source || 'ai';
    } else {
      // No server — try direct Poolside, then local regex
      const ai = await parseWithPoolsideDirect(text);
      const parsed = ai || parseOrderLocal(text);
      if (!parsed) throw new Error('Could not find an order in that message');
      order = {
        id: uid(),
        timestamp: new Date().toISOString(),
        customer: parsed.customer || 'Unknown',
        item: parsed.item || 'Item not specified',
        quantity: parsed.quantity ?? null,
        unit: parsed.unit ?? null,
        costPrice: parsed.costPrice ?? null,
        profitPercent: parsed.profitPercent ?? null,
        profitAmount: parsed.profitAmount ?? null,
        totalAmount: parsed.totalAmount ?? null,
        source: parsed.source || 'manual',
        raw: text,
      };
      usedSource = order.source;
    }
    const orders = loadLocalOrders();
    orders.unshift(order);
    saveLocalOrders(orders);
    renderAll();
    result.className = 'form-result ok';
    const tag = usedSource === 'ai' ? '<span class="src-tag src-ai">🤖 AI</span> ' : (usedSource === 'regex' ? '<span class="src-tag src-regex">🧮 regex</span> ' : '');
    result.innerHTML =
      `${tag}✅ <b>${escapeHtml(order.customer)}</b> — ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${escapeHtml(order.item)} · ` +
      `Cost <b>${money(order.costPrice)}</b> · Profit <b style="color:#25d366">${money(order.profitAmount)}</b> (${order.profitPercent ?? '—'}%) · ` +
      `Total <b style="color:#f5b642">${money(order.totalAmount)}</b>`;
    input.value = '';
  } catch (err) {
    result.className = 'form-result err';
    result.textContent = '⚠ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('demoBtn').addEventListener('click', async () => {
  if (serverConfigured()) {
    try { await serverFetch('/api/demo', { method: 'POST' }); } catch (e) { /* ignore */ }
  }
  const now = Date.now();
  const demo = [
    { customer: 'Mayank', item: 'Ladoo', quantity: 500, unit: 'g', costPrice: 200, profitPercent: 15, profitAmount: 30, totalAmount: 230, raw: 'Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees' },
    { customer: 'Sharma Uncle', item: 'Kaju Katli', quantity: 1, unit: 'kg', costPrice: 850, profitPercent: 20, profitAmount: 170, totalAmount: 1020, raw: 'sold 1kg kaju katli to sharma uncle, cost 850, profit 20%' },
    { customer: 'Priya Gupta', item: 'Chocolate Cake', quantity: 2, unit: 'kg', costPrice: 700, profitPercent: 25, profitAmount: 175, totalAmount: 875, raw: 'Order from Priya Gupta, 2 kg chocolate cake, cost 700, +25% profit' },
    { customer: 'Ravi Kirana', item: 'Namkeen', quantity: 5, unit: 'kg', costPrice: 400, profitPercent: 18, profitAmount: 72, totalAmount: 472, raw: 'ravi kirana ne 5kg namkeen mange, cost 400, profit 18%' },
  ].map((d, i) => ({ id: uid(), timestamp: new Date(now - i * 3600_000).toISOString(), source: 'demo', ...d }));
  saveLocalOrders(demo);
  renderAll();
});

$('clearBtn').addEventListener('click', () => {
  if (confirm('Delete local orders? Server-side orders stay on the server.')) {
    saveLocalOrders([]);
    renderAll();
  }
});

$('refreshBtn').addEventListener('click', refreshFromServer);

$('ordersBody').addEventListener('click', (e) => {
  const del = e.target.closest('.del-btn');
  if (del) {
    const id = del.dataset.id;
    saveLocalOrders(loadLocalOrders().filter((o) => o.id !== id));
    if (serverConfigured()) serverFetch('/api/orders/' + id, { method: 'DELETE' }).catch(() => {});
    renderAll();
    return;
  }
  const share = e.target.closest('.share-btn');
  if (share) {
    const order = loadLocalOrders().find((o) => o.id === share.dataset.id);
    if (!order) return;
    const lines = [
      `✅ *Order tracked*`,
      `👤 ${order.customer}`,
      `📦 ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${order.item}`,
      `💰 Cost: ₹${order.costPrice ?? '—'} | Profit: ₹${order.profitAmount ?? '—'}${order.profitPercent != null ? ` (${order.profitPercent}%)` : ''}`,
      `🧾 Total: ₹${order.totalAmount ?? '—'}`,
    ];
    if (window.Native && window.Native.shareOnWhatsApp) {
      window.Native.shareOnWhatsApp(lines.join('\n'));
    } else {
      navigator.clipboard?.writeText(lines.join('\n'));
      alert('Order text copied. Open WhatsApp and paste.');
    }
  }
});

// ============ Settings modal ============
function openSettings() {
  const c = getServerConfig();
  $('serverUrlInput').value = c.url;
  $('apiTokenInput').value = c.token;
  $('settingsTest').classList.add('hidden');
  $('settingsModal').classList.remove('hidden');
}
function closeSettings() { $('settingsModal').classList.add('hidden'); }
$('settingsBtn').addEventListener('click', openSettings);
$('settingsCloseBtn').addEventListener('click', closeSettings);
$('settingsSaveBtn').addEventListener('click', () => {
  localStorage.setItem(SERVER_URL_KEY, $('serverUrlInput').value.trim());
  localStorage.setItem(API_TOKEN_KEY, $('apiTokenInput').value.trim());
  closeSettings();
  refreshFromServer();
});
$('settingsTestBtn').addEventListener('click', async () => {
  const box = $('settingsTest');
  box.className = 'form-result';
  box.textContent = 'Testing…';
  box.classList.remove('hidden');
  // Temporarily save so the fetch uses the new values
  localStorage.setItem(SERVER_URL_KEY, $('serverUrlInput').value.trim());
  localStorage.setItem(API_TOKEN_KEY, $('apiTokenInput').value.trim());
  try {
    const status = await serverFetch('/api/status');
    box.className = 'form-result ok';
    box.textContent = `✅ Connected — WhatsApp: ${status.connected ? 'connected ✓' : (status.lastError || 'waiting')} · AI: ${status.aiConfigured ? 'on' : 'off'}`;
  } catch (err) {
    box.className = 'form-result err';
    box.textContent = '⚠ ' + err.message;
  }
});

// ============ Init ============
renderAll();
if (serverConfigured()) {
  refreshFromServer();
  pollTimer = setInterval(refreshFromServer, 5000);
} else if (POOLSIDE_DIRECT_KEY) {
  updateAIStatus('Poolside AI · direct');
} else {
  updateAIStatus('Offline mode');
  // First-launch: pop settings so user can either deploy a server or see how it works offline
  setTimeout(openSettings, 400);
}