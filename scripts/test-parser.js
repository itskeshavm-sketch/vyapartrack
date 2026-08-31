// Verifies the regex parser against typical order messages, including the
// original example. Run: npm run test:parser

const { parseOrder } = require('../src/parser');

const cases = [
  'Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees',
  'sold 1kg kaju katli to sharma uncle, cost 850, profit 20%',
  'Order from Priya Gupta, 2 kg chocolate cake, cost 700, +25% profit',
  'ravi kirana ne 5kg namkeen mange, cost 400, profit 18%',
  'hey how are you', // should be rejected
  'order from Aman, 12 pcs samosa, cost 60, profit 10', // profit as bare number without % -> may be treated as amount
];

let pass = 0;
let fail = 0;

function assert(ok, label) {
  if (ok) pass++;
  else { fail++; console.log('   ✗ FAIL:', label); }
}

for (const text of cases) {
  const r = parseOrder(text);
  console.log('\nMSG :', text);
  if (!r) {
    console.log('->  rejected (not an order)');
    continue;
  }
  console.log('->  ', JSON.stringify(
    { customer: r.customer, item: r.item, quantity: r.quantity, unit: r.unit, costPrice: r.costPrice, profitPercent: r.profitPercent, profitAmount: r.profitAmount, totalAmount: r.totalAmount },
    null, 2
  ));

  // Core assertions on the flagship example
  if (text.startsWith('Order from Mayank')) {
    assert(r.customer === 'Mayank', 'customer is Mayank');
    assert(r.quantity === 500 && r.unit === 'g', 'qty 500 g');
    assert(r.item === 'ladoo', 'item is ladoo');
    assert(r.costPrice === 200, 'cost 200');
    assert(r.profitPercent === 15, 'profit 15%');
    assert(r.profitAmount === 30, 'profit 30');
    assert(r.totalAmount === 230, 'total 230');
  }
  if (text.startsWith('sold 1kg')) {
    assert(r.customer === 'Sharma Uncle', 'customer Sharma Uncle');
    assert(r.item === 'kaju katli', 'item kaju katli');
    assert(r.costPrice === 850 && r.profitPercent === 20, 'cost 850, 20%');
    assert(r.profitAmount === 170, 'profit 170');
    assert(r.totalAmount === 1020, 'total 1020');
  }
  if (text.startsWith('ravi kirana')) {
    assert(r.customer === 'Ravi Kirana', 'customer Ravi Kirana');
    assert(r.quantity === 5 && r.unit === 'kg' && r.item === 'namkeen', '5kg namkeen');
    assert(r.profitAmount === 72 && r.totalAmount === 472, 'profit 72, total 472');
  }
}

console.log(`\n=== Parser checks: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
