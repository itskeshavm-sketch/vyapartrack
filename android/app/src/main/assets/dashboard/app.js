// VyaparTrack — mobile-first client. Onboarding-first flow.

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'vyapartrack.orders.v1';
const DEFAULT_SERVER_URL = 'https://vyapartrack.onrender.com';
const DEFAULT_API_TOKEN = '44fff7e79de139a9e85b0e77c9c5017a0b84dac30978e4f6bf';

let pollTimer = null;
let serverOk = false;
let botConnected = false;

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : '₹' + fmt.format(n));
const round2 = (n) => Math.round(n * 100) / 100;

function loadLocalOrders() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function saveLocalOrders(o) { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); }
function uid() { return 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function getServerConfig() {
  return {
    url: (localStorage.getItem('vyapartrack.server.url') || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    token: localStorage.getItem('vyapartrack.server.token') || DEFAULT_API_TOKEN,
  };
}

// ============ HTTP transport ============
// Native bridge first (WebViews block fetch() from file:// origins), fetch fallback.
let httpCallId = 0;
const httpPending = {};
window.__vyaparHttpResult = function (cb, env) {
  const p = httpPending[cb];
  delete httpPending[cb];
  if (!p) return;
  let data;
  try { data = env.body ? JSON.parse(env.body) : {}; } catch { data = { error: env.body }; }
  if (env.status === 0) p.reject(new Error(env.error || 'Network error'));
  else if (env.status >= 400) p.reject(new Error((data && data.error) || ('HTTP ' + env.status)));
  else p.resolve(data);
};
function nativeHttp(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const cb = '__vyaparHttpCb' + (++httpCallId);
    httpPending[cb] = { resolve, reject };
    try {
      window.Native.http(method, url, body || '', JSON.stringify(headers), cb);
    } catch (e) {
      delete httpPending[cb];
      reject(e);
    }
  });
}
async function serverFetch(path, opts = {}) {
  const { url, token } = getServerConfig();
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body != null ? String(opts.body) : null;
  const headers = Object.assign({}, opts.headers || {}, { 'X-API-Token': token });
  if (window.Native && window.Native.http) {
    return nativeHttp(method, url + path, headers, body);
  }
  // Browser fallback (same as before)
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url + path, Object.assign({}, opts, {
      headers,
      signal: controller.signal,
    }));
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out (25s) — server may be sleeping');
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

// ============ Onboarding flow ============
function showOnboarding() {
  $('onboarding').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  $('ob-step-1').classList.remove('hidden');
  $('ob-step-2').classList.add('hidden');
}
function showDashboard() {
  $('onboarding').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  startPolling();
}
function showObStep2(code) {
  $('ob-step-1').classList.add('hidden');
  $('ob-step-2').classList.remove('hidden');
  $('obCode').textContent = formatCode(code);
  $('obStatus').textContent = 'Waiting for WhatsApp to connect…';
}
function formatCode(c) { return (c || '').match(/.{1,4}/g)?.join(' ') || c; }

$('obGetCodeBtn').addEventListener('click', async () => {
  const phone = $('obPhone').value.replace(/\D/g, '');
  if (phone.length !== 10) { $('obError').textContent = 'Enter a valid 10-digit number.'; return; }
  $('obGetCodeBtn').disabled = true;
  $('obError').textContent = '';
  try {
    const { code } = await serverFetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    showObStep2(code);
  } catch (err) {
    $('obError').textContent = '⚠ ' + err.message;
  } finally {
    $('obGetCodeBtn').disabled = false;
  }
});
$('obCopyBtn').addEventListener('click', async () => {
  const code = $('obCode').textContent.replace(/\s/g, '');
  try { await navigator.clipboard.writeText(code); $('obCopyBtn').textContent = 'Copied ✓'; setTimeout(() => $('obCopyBtn').textContent = 'Copy', 2000); }
  catch { alert('Code: ' + code); }
});
$('obOpenWABtn').addEventListener('click', () => {
  // Try to open WhatsApp directly. If not installed, falls through to app store.
  try { window.Native.openWhatsApp?.(); } catch {}
  window.open('whatsapp://', '_blank');
});

// ============ Dashboard ============
function renderOrders(orders) {
  const list = $('ordersList');
  if (!orders.length) {
    list.innerHTML = '<div class="empty">No orders yet. They\'ll appear here as customers message you on WhatsApp.</div>';
    return;
  }
  list.innerHTML = orders.map((o) => {
    const qty = o.quantity != null ? fmt.format(o.quantity) + (o.unit ? ' ' + o.unit : '') : '';
    return `
      <div class="order" data-id="${o.id}">
        <div class="order-main">
          <div class="order-cust">${escapeHtml(o.customer || 'Unknown')}</div>
          <div class="order-item">${escapeHtml(qty + ' ' + (o.item || '—'))}</div>
          <div class="order-src">${sourceLabel(o.source)}</div>
        </div>
        <div class="order-amt">${money(o.totalAmount)}</div>
        <div class="order-actions">
          <button class="icon-btn" data-act="share" data-id="${o.id}" title="Share on WhatsApp">📤</button>
          <button class="icon-btn" data-act="del" data-id="${o.id}" title="Delete">✕</button>
        </div>
      </div>`;
  }).join('');
}
function sourceLabel(s) {
  return ({ whatsapp: '📱 WhatsApp', manual: '✍ Manual', ai: '🤖 AI', regex: '🧮 regex', demo: '🎁 demo' })[s] || s || '—';
}
function renderStats(orders) {
  let revenue = 0, cost = 0, profit = 0;
  for (const o of orders) {
    if (o.totalAmount != null) revenue += o.totalAmount;
    if (o.costPrice != null) cost += o.costPrice;
    if (o.profitAmount != null) profit += o.profitAmount;
  }
  $('statOrders').textContent = fmt.format(orders.length);
  $('statRevenue').textContent = money(revenue);
  $('statProfit').textContent = money(profit);
  $('statCost').textContent = money(cost);
}
function renderAll() {
  const orders = loadLocalOrders();
  renderOrders(orders);
  renderStats(orders);
}
function setConnStatus(text, ok) {
  const el = $('connStatus');
  el.textContent = text;
  el.classList.toggle('connected', !!ok);
}

async function pollOnce() {
  try {
    const [status, orders] = await Promise.all([
      serverFetch('/api/status'),
      serverFetch('/api/orders'),
    ]);
    serverOk = true;
    botConnected = status.connected;
    if (status.connected) {
      setConnStatus('WhatsApp connected ✓', true);
      // Pairing completed while user sat on the onboarding screen -> switch.
      if (!$('onboarding').classList.contains('hidden')) showDashboard();
    }
    else if (status.connecting) setConnStatus('WhatsApp connecting…', false);
    else if (status.lastError) setConnStatus(status.lastError, false);
    else setConnStatus('Server connected · not yet paired', true);
    saveLocalOrders(orders);
    renderAll();
  } catch (err) {
    serverOk = false;
    const msg = err.message || 'unknown error';
    if (/unauthorized|401/i.test(msg)) setConnStatus('⚠ Wrong API token — tap ⚙ Settings', false);
    else if (/timed?\s*out|timeout/i.test(msg)) setConnStatus('Server waking — retrying…', false);
    else setConnStatus('Server offline (' + msg + ')', false);
  }
}
function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, 4000);
}

// ============ Add order form ============
$('orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('orderText').value.trim();
  if (!text) return;
  const result = $('formResult');
  result.classList.add('hidden');
  try {
    let order;
    if (serverOk) {
      order = await serverFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } else {
      order = localParse(text);
      if (!order) throw new Error('Server is offline and the local parser couldn\'t read this. Try again when connected.');
    }
    const orders = loadLocalOrders();
    orders.unshift(order);
    saveLocalOrders(orders);
    renderAll();
    result.className = 'result ok';
    result.innerHTML = `✓ <b>${escapeHtml(order.customer)}</b> — ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${escapeHtml(order.item)} · Total <b style="color:#f5b642">${money(order.totalAmount)}</b>`;
    $('orderText').value = '';
  } catch (err) {
    result.className = 'result err';
    result.textContent = '⚠ ' + err.message;
  }
});

$('demoBtn').addEventListener('click', () => {
  const now = Date.now();
  const demo = [
    { customer: 'Mayank', item: 'Ladoo', quantity: 500, unit: 'g', costPrice: 200, profitPercent: 15, profitAmount: 30, totalAmount: 230 },
    { customer: 'Sharma Uncle', item: 'Kaju Katli', quantity: 1, unit: 'kg', costPrice: 850, profitPercent: 20, profitAmount: 170, totalAmount: 1020 },
    { customer: 'Priya Gupta', item: 'Chocolate Cake', quantity: 2, unit: 'kg', costPrice: 700, profitPercent: 25, profitAmount: 175, totalAmount: 875 },
    { customer: 'Ravi Kirana', item: 'Namkeen', quantity: 5, unit: 'kg', costPrice: 400, profitPercent: 18, profitAmount: 72, totalAmount: 472 },
  ].map((d, i) => ({ id: uid(), timestamp: new Date(now - i * 3600_000).toISOString(), source: 'demo', ...d }));
  saveLocalOrders(demo);
  renderAll();
});
$('refreshBtn').addEventListener('click', pollOnce);

$('ordersList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'del') {
    saveLocalOrders(loadLocalOrders().filter((o) => o.id !== id));
    if (serverOk) serverFetch('/api/orders/' + id, { method: 'DELETE' }).catch(() => {});
    renderAll();
  } else if (act === 'share') {
    const order = loadLocalOrders().find((o) => o.id === id);
    if (!order) return;
    const text = `✅ Order tracked\n👤 ${order.customer}\n📦 ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${order.item}\n💰 Cost: ₹${order.costPrice ?? '—'} | Profit: ₹${order.profitAmount ?? '—'}${order.profitPercent != null ? ` (${order.profitPercent}%)` : ''}\n🧾 Total: ₹${order.totalAmount ?? '—'}`;
    if (window.Native?.shareOnWhatsApp) window.Native.shareOnWhatsApp(text);
    else { navigator.clipboard?.writeText(text); alert('Copied to clipboard.'); }
  }
});

// ============ Settings ============
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
  localStorage.setItem('vyapartrack.server.url', $('serverUrlInput').value.trim());
  localStorage.setItem('vyapartrack.server.token', $('apiTokenInput').value.trim());
  closeSettings();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  startPolling();
});
$('settingsTestBtn').addEventListener('click', async () => {
  const box = $('settingsTest');
  box.className = 'result';
  box.textContent = 'Testing…';
  box.classList.remove('hidden');
  localStorage.setItem('vyapartrack.server.url', $('serverUrlInput').value.trim());
  localStorage.setItem('vyapartrack.server.token', $('apiTokenInput').value.trim());
  try {
    const s = await serverFetch('/api/status');
    box.className = 'result ok';
    box.textContent = `✅ Connected — WhatsApp: ${s.connected ? 'connected' : (s.lastError || 'waiting')} · AI: ${s.aiConfigured ? 'on' : 'off'}`;
  } catch (err) {
    box.className = 'result err';
    box.textContent = '⚠ ' + err.message;
  }
});
$('settingsDiagnoseBtn')?.addEventListener('click', async () => {
  const box = $('settingsTest');
  box.className = 'result';
  box.textContent = 'Running diagnostics…';
  box.classList.remove('hidden');
  localStorage.setItem('vyapartrack.server.url', $('serverUrlInput').value.trim());
  localStorage.setItem('vyapartrack.server.token', $('apiTokenInput').value.trim());
  const results = await diagnose();
  const lines = results.map((r) => r.ok ? `✅ ${r.label}` : `❌ ${r.label} — ${r.err}`);
  box.className = 'result ' + (results.every((r) => r.ok) ? 'ok' : 'err');
  box.textContent = lines.join('\n');
});

// ============ Local regex parser (offline fallback) ============
const UNITS = 'kg|kgs|kilogram|kilograms|gram|grams|gms|gm|g|dozen|pcs|pieces|piece|litre|litres|liter|liters|l';
const QUANTITY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i');
const COST_RE = /(?:total\s*)?(?:cost|cp|base\s*price|buying\s*price|price)\s*(?:of\s*[a-z ]+)?\s*(?:[=:]|is|are)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)/i;
const PROFIT_PCT_RE = /\+?\s*(\d+(?:\.\d+)?)\s*%/;
const PROFIT_PCT_WORD_RE = /(?:profit|margin)\s*(?:is|=|:|of|@)?\s*(\d+(?:\.\d+)?)\s*%/i;
const PROFIT_AMT_RE = /(?:profit|margin)\s*(?:is|=|:|of)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)\b(?!\s*%)/i;
const TOTAL_RE = /total\s*(?:amount|price|sell(?:ing)?)?\s*(?:[=:]|is)?\s*(?:rs\.?|rupees|inr|₹)?\s*(\d+(?:\.\d+)?)/i;
const ORDER_INTENT_RE = /\b(order|ordered|sold|sale|sell|bill|invoice|mangwaya|mange|mangaye|chahiye|bhejo|bhejna|bhej|karo|krdo|kitna|kitne|mujhe)\b|(?:can|may)\s+i\s+(?:get|have|order)|i\s+(?:want|need)\b/i;
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
function titleCase(name) { return name.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }
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
function localParse(text) {
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
  const tm = text.match(TOTAL_RE); if (tm) totalAmount = toNum(tm[1]);
  if (costPrice == null && totalAmount == null && quantity == null) return null;
  if (costPrice != null && profitPercent != null && profitAmount == null) profitAmount = round2((costPrice * profitPercent) / 100);
  if (costPrice != null && totalAmount == null && profitAmount != null) totalAmount = round2(costPrice + profitAmount);
  if (totalAmount != null && costPrice != null && profitAmount == null) profitAmount = round2(totalAmount - costPrice);
  if (costPrice != null && profitAmount != null && profitPercent == null && costPrice > 0) profitPercent = round2((profitAmount / costPrice) * 100);
  if (totalAmount == null && costPrice != null && profitAmount == null) totalAmount = costPrice;
  return {
    id: uid(), timestamp: new Date().toISOString(),
    customer: customer || 'Unknown', item: item || 'Item not specified',
    quantity, unit, costPrice, profitPercent, profitAmount, totalAmount,
    source: 'manual', raw: text,
  };
}

// ============ Init ============
async function diagnose() {
  const out = [];
  const useNative = window.Native && window.Native.http;
  async function httpGet(u) {
    if (useNative) {
      try { await nativeHttp('GET', u, {}, null); return { ok: true }; }
      catch (e) { return { ok: false, err: e.message }; }
    }
    const c = new AbortController();
    const tid = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(u, { signal: c.signal });
      return { ok: r.ok, err: r.ok ? null : ('HTTP ' + r.status) };
    } catch (e) {
      return { ok: false, err: e.message };
    } finally { clearTimeout(tid); }
  }
  // Test 1: Can we resolve DNS and reach the internet at all?
  {
    const r = await httpGet('https://www.google.com/generate_204');
    out.push({ ok: r.ok, label: 'Internet (Google)', err: r.err });
  }
  // Test 2: Can we reach our Render server?
  const { url } = getServerConfig();
  {
    const r = await httpGet(url + '/api/health');
    out.push({ ok: r.ok, label: 'Server (' + url + ')', err: r.err });
  }
  return out;
}

async function init() {
  renderAll();
  // Show the dashboard immediately — never a blank screen while the
  // (possibly sleeping) server wakes up.
  showDashboard();
  setConnStatus('Connecting…', false);
  let status = null;
  for (let i = 0; i < 3; i++) {
    try { status = await serverFetch('/api/status'); break; }
    catch (e) {
      setConnStatus(`Waking server… (${i + 1}/3)`, false);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (status) {
    serverOk = true;
    if (status.connected) {
      setConnStatus('WhatsApp connected ✓', true);
    } else {
      showOnboarding();
    }
  } else {
    serverOk = false;
    setConnStatus('Server unreachable — tap ⚙ to diagnose', false);
  }
}
init();