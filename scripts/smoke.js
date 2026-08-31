// End-to-end API smoke test: boots the Express app on an ephemeral port and
// exercises all endpoints. Run: node scripts/smoke.js

const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');

const ORDERS_FILE = path.join(__dirname, '..', 'data', 'orders.json');

let pass = 0;
let fail = 0;
function assert(ok, label, extra) {
  if (ok) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

async function main() {
  // start clean
  try { fs.rmSync(ORDERS_FILE); } catch {}

  const app = createApp(() => ({ connected: false, aiConfigured: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = (path_, opts) => fetch(base + path_, opts).then(async (res) => ({ status: res.status, body: await res.json() }));

  console.log('\n[1] GET /api/stats (empty store)');
  let r = await j('/api/stats');
  assert(r.status === 200 && r.body.totalOrders === 0, 'stats empty', r.body);

  console.log('[2] POST /api/orders (flagship Mayank message)');
  r = await j('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees' }),
  });
  assert(r.status === 201 && r.body.customer === 'Mayank', 'customer Mayank', r.body);
  assert(r.body.costPrice === 200 && r.body.profitPercent === 15, 'cost 200, 15%', r.body);
  assert(r.body.profitAmount === 30 && r.body.totalAmount === 230, 'profit 30, total 230', r.body);
  const mayankId = r.body.id;

  console.log('[3] POST /api/orders (non-order message)');
  r = await j('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hey how are you' }),
  });
  assert(r.status === 422, 'non-order rejected with 422', r);

  console.log('[4] POST /api/demo');
  r = await j('/api/demo', { method: 'POST' });
  assert(r.status === 200 && r.body.ok, 'demo seeded', r.body);

  console.log('[5] GET /api/orders');
  r = await j('/api/orders');
  assert(r.status === 200 && r.body.length === 5, '5 orders total', r.body.length);
  assert(r.body.every((o) => o.id && o.timestamp), 'records have id + timestamp');

  console.log('[6] GET /api/stats (with data)');
  r = await j('/api/stats');
  assert(r.body.totalOrders === 5, 'totalOrders 5', r.body);
  // demo seed = 1020+875+472+230 (demo Mayank) + real Mayank order 230
  assert(r.body.revenue === 1020 + 875 + 472 + 230 + 230, 'revenue sum', r.body);
  assert(r.body.profit === 170 + 175 + 72 + 30 + 30, 'profit sum', r.body);

  console.log('[7] DELETE /api/orders/:id');
  r = await j(`/api/orders/${mayankId}`, { method: 'DELETE' });
  assert(r.status === 200 && r.body.deleted === true, 'deleted mayank order', r.body);
  r = await j('/api/stats');
  assert(r.body.totalOrders === 4, 'back to 4 orders', r.body);

  console.log('[8] GET / (dashboard HTML)');
  const html = await fetch(base + '/').then((res) => res.text());
  assert(html.includes('VyaparTrack') && html.includes('app.js'), 'dashboard served');

  console.log('[9] GET /api/status');
  r = await j('/api/status');
  assert(r.status === 200 && 'aiConfigured' in r.body, 'status includes aiConfigured', r.body);

  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => setTimeout(r, 150));
  console.log(`\n=== Smoke test: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Smoke test crashed:', err); process.exit(1); });
