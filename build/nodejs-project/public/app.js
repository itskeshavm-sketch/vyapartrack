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
  // Show a DEMO badge on the Total Orders card so sample data can't be
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
    badge.textContent = `${fake} DEMO`;
    badge.title = `${fake} of ${s.totalOrders} orders are demo-seeded and not real revenue`;
    card.classList.add('has-fake');
  } else if (badge) {
    badge.remove();
    card.classList.remove('has-fake');
  }
  const ordersSub = card.querySelector('.stat-sub');
  if (ordersSub) {
    ordersSub.textContent = s.totalOrders > 0 && fake === s.totalOrders
      ? 'demo sample data'
      : 'tracked automatically';
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
    line.innerHTML = `<span class="fake-amt">${money(fakeAmt)} demo</span> · real <span class="real-amt">${money(realAmt)}</span>`;
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
  return ({ whatsapp: 'WhatsApp', manual: 'Manual', parser: 'Parser', regex: 'Parser', demo: 'Demo' })[s] || s || '';
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
    } else if (st.botEnabled === false) {
      // Dashboard/demo mode: there is no WhatsApp process to pair with, so
      // don't show a scary red error or a setup form that cannot work.
      pill.className = 'status-pill demo';
      $('botStatusText').textContent = 'Dashboard mode · offline parser';
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

function refreshParserStatus() {
  const pill = $('parserStatus');
  if (pill) pill.className = 'status-pill parser on';
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
      `Cost <b>${money(order.costPrice)}</b> · Profit <b style="color:#c9f24d">${money(order.profitAmount)}</b> (${order.profitPercent ?? '—'}%) · ` +
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

document.querySelectorAll('.sample-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('orderText').value = btn.dataset.text;
    $('orderForm').requestSubmit();
  });
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
refreshParserStatus();
setInterval(refreshStatus, 5000);
setInterval(() => { refreshOrders().catch(() => {}); refreshStats().catch(() => {}); }, 10000);

/* ============================================================
   Liquid glass layer - pointer specular + animated counters
   ============================================================ */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var GLASS = '.stat, .card, .ob-step, .order, .code-card, .modal-card, .panel, .stat-card, .setup-panel, .table-wrap';

  document.addEventListener('pointermove', function (e) {
    var el = e.target && e.target.closest ? e.target.closest(GLASS) : null;
    if (!el) return;
    var r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  var parseNum = function (txt) {
    var n = parseFloat(String(txt || '').replace(/[^0-9.-]/g, ''));
    return isFinite(n) ? n : null;
  };
  var fmt = window.fmt || (typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }) : null);
  var money = window.money || function (n) { return '₹' + (fmt ? fmt.format(n) : n); };

  ['statOrders', 'statRevenue', 'statProfit', 'statCost'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    var shown = parseNum(el.textContent) || 0;
    var painting = false;
    var raf = null;

    var paint = function (v) {
      painting = true;
      el.textContent = id === 'statOrders' ? fmt.format(Math.round(v)) : money(v);
      painting = false;
    };

    new MutationObserver(function () {
      if (painting) return;
      var next = parseNum(el.textContent);
      if (next == null || next === shown) return;
      var from = shown;
      shown = next;

      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');

      if (reduce) { paint(next); return; }
      if (raf) cancelAnimationFrame(raf);
      var t0 = performance.now();
      var dur = 550;
      painting = true;
      var step = function (t) {
        var k = Math.min(1, (t - t0) / dur);
        var e = 1 - Math.pow(1 - k, 3);
        el.textContent = id === 'statOrders' ? fmt.format(Math.round(from + (next - from) * e)) : money(from + (next - from) * e);
        if (k < 1) { raf = requestAnimationFrame(step); }
        else { painting = false; }
      };
      raf = requestAnimationFrame(step);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
})();
