const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : '₹' + fmt.format(n));

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function refreshStats() {
  const s = await fetchJSON('/api/stats');
  $('statOrders').textContent = fmt.format(s.totalOrders);
  $('statRevenue').textContent = money(s.revenue);
  $('statProfit').textContent = money(s.profit);
  $('statCost').textContent = money(s.cost);
  $('statMargin').textContent = `${s.avgMarginPct}% avg margin`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function renderOrders(orders) {
  const body = $('ordersBody');
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">No orders yet. Connect WhatsApp or load demo data.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((o) => `
    <tr>
      <td class="cust">${escapeHtml(o.customer)}</td>
      <td><span class="item-tag">${escapeHtml(o.item)}</span></td>
      <td class="qty">${o.quantity != null ? fmt.format(o.quantity) + (o.unit ? ' ' + o.unit : '') : '—'}</td>
      <td class="money">${money(o.costPrice)}</td>
      <td>${o.profitPercent != null ? `<span class="profit-pct">+${o.profitPercent}%</span>` : '—'}</td>
      <td class="money profit-amt">${money(o.profitAmount)}</td>
      <td class="money total-amt">${money(o.totalAmount)}</td>
      <td class="time-cell" title="${new Date(o.timestamp).toLocaleString('en-IN')}">${timeAgo(o.timestamp)}</td>
      <td><button class="del-btn" data-id="${o.id}" title="Delete">✕</button></td>
    </tr>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshOrders() {
  const orders = await fetchJSON('/api/orders');
  renderOrders(orders);
}

async function refreshStatus() {
  try {
    const st = await fetchJSON('/api/status');
    const pill = $('botStatus');
    const setup = $('setupPanel');
    if (st.connected) {
      pill.className = 'status-pill online';
      $('botStatusText').textContent = 'WhatsApp connected';
      setup.classList.add('hidden');
    } else {
      pill.className = 'status-pill offline';
      $('botStatusText').textContent = st.lastError || 'WhatsApp not connected';
      setup.classList.remove('hidden');
      if (st.qrDataUrl) {
        $('qrImage').src = st.qrDataUrl;
        $('qrImage').classList.remove('hidden');
        $('qrWait').classList.add('hidden');
      } else {
        $('qrImage').classList.add('hidden');
        $('qrWait').classList.remove('hidden');
      }
      if (st.pairingCode && $('pairCode').textContent !== st.pairingCode) {
        $('pairCode').textContent = st.pairingCode;
        $('pairResult').classList.remove('hidden');
      }
    }
  } catch { /* ignore */ }
}

$('pairBtn').addEventListener('click', async () => {
  const phone = $('phoneInput').value.trim();
  const errBox = $('pairError');
  errBox.classList.add('hidden');
  if (!phone) return;
  $('pairBtn').disabled = true;
  try {
    const { code } = await fetchJSON('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    $('pairCode').textContent = code;
    $('pairResult').classList.remove('hidden');
  } catch (err) {
    errBox.textContent = '⚠ ' + err.message;
    errBox.classList.remove('hidden');
  } finally {
    $('pairBtn').disabled = false;
  }
});

async function refreshAIStatus() {
  try {
    const st = await fetchJSON('/api/status');
    const ai = $('aiStatus');
    if (st.aiConfigured) {
      ai.className = 'status-pill ai on';
      ai.innerHTML = '<span class="dot"></span><span>AI parser on</span>';
    } else {
      ai.className = 'status-pill ai';
      ai.innerHTML = '<span class="dot"></span><span>AI parser off (regex mode)</span>';
    }
  } catch { /* ignore */ }
}

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
    const order = await fetchJSON('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    result.className = 'form-result ok';
    result.innerHTML =
      `✅ <b>${escapeHtml(order.customer)}</b> — ${order.quantity ?? '—'}${order.unit ? ' ' + order.unit : ''} ${escapeHtml(order.item)} · ` +
      `Cost <b>${money(order.costPrice)}</b> · Profit <b style="color:#25d366">${money(order.profitAmount)}</b> (${order.profitPercent ?? '—'}%) · ` +
      `Total <b style="color:#f5b642">${money(order.totalAmount)}</b>`;
    input.value = '';
    await Promise.all([refreshOrders(), refreshStats()]);
  } catch (err) {
    result.className = 'form-result err';
    result.textContent = '⚠ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('demoBtn').addEventListener('click', async () => {
  await fetchJSON('/api/demo', { method: 'POST' });
  await Promise.all([refreshOrders(), refreshStats()]);
});

$('refreshBtn').addEventListener('click', () => Promise.all([refreshOrders(), refreshStats(), refreshStatus()]));

$('ordersBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.del-btn');
  if (!btn) return;
  await fetchJSON('/api/orders/' + btn.dataset.id, { method: 'DELETE' });
  await Promise.all([refreshOrders(), refreshStats()]);
});

refreshOrders().catch(() => {});
refreshStats().catch(() => {});
refreshStatus();
refreshAIStatus();
setInterval(refreshStatus, 5000);
setInterval(() => { refreshOrders().catch(() => {}); refreshStats().catch(() => {}); }, 10000);
