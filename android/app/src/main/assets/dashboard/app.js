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
  stopCodeCountdown();
  startPolling();
}
function showObStep2(code, expiresIn) {
  $('ob-step-1').classList.add('hidden');
  $('ob-step-2').classList.remove('hidden');
  currentObCode = code;
  $('obCode').textContent = formatCode(code);
  setObStatus('Waiting for WhatsApp to connect…');
  startCodeCountdown(expiresIn != null ? expiresIn : 100);
}
function formatCode(c) { return (c || '').match(/.{1,4}/g)?.join(' ') || c; }

// WhatsApp expires pairing codes in ~2-3 min. The server re-mints them
// automatically; here we show the countdown and pick up the new code.
let obCountdownTimer = null;
let currentObCode = null;
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function setObStatus(text, secsLeft) {
  $('obStatus').textContent = secsLeft != null ? `${text} · कोड ${fmtClock(secsLeft)} में नया होगा` : text;
}
function startCodeCountdown(secs) {
  stopCodeCountdown();
  let left = Math.max(0, Math.floor(secs));
  setObStatus('Waiting for WhatsApp to connect…', left);
  obCountdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      stopCodeCountdown();
      setObStatus('कोड रिन्यू हो रहा है…'); // new code arrives via /api/status sync
    } else {
      setObStatus('Waiting for WhatsApp to connect…', left);
    }
  }, 1000);
}
function stopCodeCountdown() {
  if (obCountdownTimer) { clearInterval(obCountdownTimer); obCountdownTimer = null; }
}
/** Onboarding is visible: reflect the freshest server-side code (auto-rotated). */
function syncPairingCode(status) {
  if (!status.pairingCode || status.pairingCode === currentObCode) return;
  const onStep2 = !$('ob-step-2').classList.contains('hidden');
  currentObCode = status.pairingCode;
  $('obCode').textContent = formatCode(status.pairingCode);
  const expiresIn = status.pairingExpiresAt
    ? Math.max(0, Math.round((new Date(status.pairingExpiresAt).getTime() - Date.now()) / 1000))
    : 100;
  if (onStep2) startCodeCountdown(expiresIn);
}

$('obGetCodeBtn').addEventListener('click', async () => {
  const phone = $('obPhone').value.replace(/\D/g, '');
  if (phone.length !== 10) { $('obError').textContent = 'Enter a valid 10-digit number.'; return; }
  $('obGetCodeBtn').disabled = true;
  $('obError').textContent = '';
  try {
    const { code, expiresIn } = await serverFetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    showObStep2(code, expiresIn);
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
    list.innerHTML = '<div class="empty">अभी कोई ऑर्डर नहीं। ग्राहक WhatsApp पर मैसेज करें तो यहाँ दिखेगा।</div>';
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
        <div class="order-amt">${o.totalAmount != null ? money(o.totalAmount) : '⏳'}</div>
        <div class="order-actions">
          <button class="icon-btn" data-act="share" data-id="${o.id}" title="WhatsApp पर भेजें">📤</button>
          <button class="icon-btn" data-act="del" data-id="${o.id}" title="हटाएं">✕</button>
        </div>
      </div>`;
  }).join('');
}
function sourceLabel(s) {
  return ({ whatsapp: '📱 WhatsApp', manual: '✍ खुद डाला', ai: '🤖 AI', regex: '🧮 parser', demo: '🎁 डेमो' })[s] || s || '—';
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
    // Onboarding screens must always show the freshest (auto-rotated) pairing code
    if (!$('onboarding').classList.contains('hidden')) syncPairingCode(status);
    if (status.connected) {
      setConnStatus('WhatsApp जुड़ा ✓', true);
      stopCodeCountdown();
      if (!$('onboarding').classList.contains('hidden')) showDashboard();
    }
    else if (status.connecting) setConnStatus('WhatsApp जुड़ रहा है…', false);
    else if (status.lastError) setConnStatus(status.lastError, false);
    else setConnStatus('सर्वर जुड़ा · WhatsApp बाकी', true);
    saveLocalOrders(orders);
    renderAll();
    refreshPending(); // async, fire and forget
  } catch (err) {
    serverOk = false;
    const msg = err.message || 'unknown error';
    if (/unauthorized|401/i.test(msg)) setConnStatus('⚠ गलत API token — ⚙ खोलें', false);
    else if (/timed?\s*out|timeout/i.test(msg)) setConnStatus('सर्वर जग रहा है…', false);
    else setConnStatus('सर्वर बंद (' + msg + ')', false);
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
      if (!order) throw new Error('सर्वर बंद है और लोकल parser यह पढ़ नहीं सका। सर्वर जुड़ने के बाद कोशिश करें।');
    }
    const orders = loadLocalOrders();
    orders.unshift(order);
    saveLocalOrders(orders);
    renderAll();
    result.className = 'result ok';
    result.innerHTML = `✓ <b>${escapeHtml(order.customer)}</b> — ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${escapeHtml(order.item)} · कुल <b style="color:#f5c66b">${money(order.totalAmount)}</b>`;
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

// ============ Catalog (मेरे आइटम) ============
function openCatalog() { renderCatalog(); $('catalogModal').classList.remove('hidden'); }
function closeCatalog() { $('catalogModal').classList.add('hidden'); }
$('catalogBtn').addEventListener('click', openCatalog);
$('catalogCloseBtn').addEventListener('click', closeCatalog);

async function renderCatalog() {
  const list = $('catalogList');
  list.innerHTML = '<div class="empty">लोड हो रहा है…</div>';
  let items = [];
  try { items = await serverFetch('/api/catalog'); }
  catch { list.innerHTML = '<div class="empty">सर्वर से नहीं मिला।</div>'; return; }
  if (!items.length) {
    list.innerHTML = '<div class="empty">अभी कोई आइटम नहीं। नीचे से जोड़ें।</div>';
    return;
  }
  const unitHi = { kg: 'किलो', g: 'ग्राम', ml: 'मिली', l: 'लीटर', pcs: 'पीस', dozen: 'दर्जन' };
  list.innerHTML = items.map((it) => `
    <div class="catalog-row">
      <div class="c-info">
        <div class="c-name">${escapeHtml(it.name)} <span class="muted small">(${unitHi[it.unit] || it.unit || '—'})</span></div>
        <div class="c-prices">बिक्री ₹${it.sellPrice ?? '—'} · खर्चा ₹${it.costPrice ?? '—'} → मुनाफ़ा ₹${(it.sellPrice != null && it.costPrice != null) ? fmt.format(round2(it.sellPrice - it.costPrice)) : '—'}</div>
      </div>
      <button class="c-del" data-id="${it.id}" title="हटाएं">✕</button>
    </div>`).join('');
}
$('catalogList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.c-del');
  if (!btn) return;
  try { await serverFetch('/api/catalog/' + btn.dataset.id, { method: 'DELETE' }); } catch {}
  renderCatalog();
});
$('catalogForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('catalogName').value.trim();
  const unit = $('catalogUnit').value;
  const sellPrice = parseFloat($('catalogSell').value);
  const costPrice = $('catalogCost').value ? parseFloat($('catalogCost').value) : null;
  if (!name || !Number.isFinite(sellPrice)) return;
  try {
    await serverFetch('/api/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, unit, sellPrice, costPrice }),
    });
    $('catalogName').value = ''; $('catalogSell').value = ''; $('catalogCost').value = '';
    renderCatalog();
    refreshPending();
  } catch (err) { alert('⚠ ' + err.message); }
});

// ============ Pending pricing (कीमत बतानी है) ============
let pendingRefreshTimer = null;
async function refreshPending() {
  if (!serverOk) return;
  let items = [];
  try { items = await serverFetch('/api/pending-pricing'); } catch { return; }
  const card = $('pendingCard');
  if (!items.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('pendingCount').textContent = items.length + ' आइटम';
  const unitHi = { kg: 'किलो', g: 'ग्राम', ml: 'मिली', l: 'लीटर', pcs: 'पीस', dozen: 'दर्जन' };
  $('pendingList').innerHTML = items.map((p) => `
    <div class="pending-item" data-id="${p.id}">
      <div class="pi-info">
        <div class="pi-name">${escapeHtml(p.item)}</div>
        <div class="pi-sub">${p.unit ? unitHi[p.unit] || p.unit : 'यूनिट'} प्रति · ${p.examples.length} ऑर्डर रुके हैं</div>
      </div>
      <input class="pi-sell" type="number" inputmode="decimal" min="0" placeholder="बिक्री ₹" />
      <input class="pi-cost" type="number" inputmode="decimal" min="0" placeholder="खर्चा ₹" />
      <button class="pi-save">सेव</button>
    </div>`).join('');
}
$('pendingList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.pi-save');
  if (!btn) return;
  const row = btn.closest('.pending-item');
  const sellPrice = parseFloat(row.querySelector('.pi-sell').value);
  const costRaw = row.querySelector('.pi-cost').value;
  const costPrice = costRaw ? parseFloat(costRaw) : null;
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) { alert('पहले बिक्री कीमत भरें'); return; }
  btn.disabled = true;
  try {
    await serverFetch('/api/pending-pricing/' + row.dataset.id + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sellPrice, costPrice }),
    });
    await pollOnce();
  } catch (err) { alert('⚠ ' + err.message); }
  finally { btn.disabled = false; }
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
    box.textContent = `✅ जुड़ा — WhatsApp: ${s.connected ? 'जुड़ा' : (s.lastError || 'इंतज़ार')} · AI: ${s.aiConfigured ? 'चालू' : 'बंद'}`;
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

function localParse(text) {
  if (!text || !(ROMAN_INTENT_RE.test(text) || NATIVE_INTENT_RE.test(text))) return null;
  const customer = extractCustomer(text);
  const qty = matchQuantity(text);
  const quantity = qty ? qty.quantity : null;
  const unit = qty ? qty.unit : null;
  const item = extractItem(text, qty ? qty.match : null);
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
  setConnStatus('जुड़ रहे हैं…', false);
  let status = null;
  for (let i = 0; i < 3; i++) {
    try { status = await serverFetch('/api/status'); break; }
    catch (e) {
      setConnStatus(`सर्वर जगा रहे हैं… (${i + 1}/3)`, false);
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
    setConnStatus('सर्वर नहीं मिला — ⚙ दबाएँ', false);
  }
}
init();