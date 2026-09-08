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
  const [s, orders] = await Promise.all([
    fetchJSON('/api/stats'),
    fetchJSON('/api/orders').catch(() => []),
  ]);
  // Split totals by source so demo/fake money doesn't blend in with real.
  let fake = 0;
  let realRev = 0, realCost = 0, realProfit = 0;
  let fakeRev = 0, fakeCost = 0, fakeProfit = 0;
  for (const o of orders) {
    const isFake = o.source === 'demo';
    if (isFake) {
      fake++;
      if (o.totalAmount != null) fakeRev += o.totalAmount;
      if (o.costPrice != null) fakeCost += o.costPrice;
      if (o.profitAmount != null) fakeProfit += o.profitAmount;
    } else {
      if (o.totalAmount != null) realRev += o.totalAmount;
      if (o.costPrice != null) realCost += o.costPrice;
      if (o.profitAmount != null) realProfit += o.profitAmount;
    }
  }
  $('statOrders').textContent = fmt.format(s.totalOrders);
  // Show a FAKE badge on the Total Orders card so demo-seeded data can't be
  // mistaken for real revenue at a glance.
  const card = $('statOrders').closest('.stat-card');
  let badge = $('statOrdersFake');
  if (fake > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'statOrdersFake';
      badge.className = 'stat-fake-badge';
      $('statOrders').insertAdjacentElement('afterend', badge);
    }
    badge.textContent = `${fake} FAKE`;
    badge.title = `${fake} of ${s.totalOrders} orders are demo-seeded and not real revenue`;
    card.classList.add('has-fake');
  } else if (badge) {
    badge.remove();
    card.classList.remove('has-fake');
  }
  $('statRevenue').textContent = money(s.revenue);
  $('statProfit').textContent = money(s.profit);
  $('statCost').textContent = money(s.cost);
  $('statMargin').textContent = `${s.avgMarginPct}% avg margin`;

  // Per-card "fake vs real" breakdown on the three money cards.
  setFakeBreakdown('statRevenue', fakeRev, realRev);
  setFakeBreakdown('statProfit', fakeProfit, realProfit);
  setFakeBreakdown('statCost', fakeCost, realCost);
}

/** Append a small "(₹X fake · real ₹Y)" line under a money stat card. */
function setFakeBreakdown(valueId, fakeAmt, realAmt) {
  const card = $(valueId).closest('.stat-card');
  if (!card) return;
  let line = card.querySelector('.stat-fake-line');
  if (fakeAmt > 0) {
    if (!line) {
      line = document.createElement('div');
      line.className = 'stat-fake-line';
      card.appendChild(line);
    }
    line.innerHTML = `<span class="fake-amt">${money(fakeAmt)} fake</span> · real <span class="real-amt">${money(realAmt)}</span>`;
    card.classList.add('has-fake');
  } else if (line) {
    line.remove();
    card.classList.remove('has-fake');
  }
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

function sourceLabel(s) {
  return ({ whatsapp: 'WhatsApp', manual: 'Manual', ai: 'AI', regex: 'Parser', demo: 'FAKE' })[s] || s || '';
}

function renderOrders(orders) {
  const body = $('ordersBody');
  if (!orders.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">No orders yet. Connect WhatsApp or load demo data.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((o) => `
    <tr>
      <td class="cust">${escapeHtml(o.customer)}${o.source ? ` <span class="source-tag source-${o.source}" title="${escapeHtml(o.source)} order">${sourceLabel(o.source)}</span>` : ''}</td>
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
