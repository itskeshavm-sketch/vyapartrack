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
  '10 piece laddu',
  '5pc laddu',
  'bhai 10 laddu chahiye',
  'bhai 500g sugar dena',
  'I have 10 laddu at home', // bare number, no intent -> rejected
  'samosa 12 rupees', // price only, no qty -> rejected
  // Native-script coverage (Devanagari + Telugu)
  '500 ग्राम लड्डू चाहिए',
  '2 किलो चीनी भेज दो, cost 80, profit 20%',
  'लड्डू 500 ग्राम',
  '2 కిలోలు బియ్యం కావాలి',
  '500 గ్రాములు పప్పు కావాలి',
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
  if (text === '10 piece laddu') {
    assert(r.quantity === 10 && r.unit === 'pcs' && r.item === 'laddu', '10 piece laddu');
  }
  if (text === '5pc laddu') {
    assert(r.quantity === 5 && r.unit === 'pcs' && r.item === 'laddu', '5pc laddu');
  }
  if (text === 'bhai 10 laddu chahiye') {
    assert(r.quantity === 10 && (r.unit == null) && r.item === 'laddu', 'bare 10 laddu + intent');
  }
  if (text === 'bhai 500g sugar dena') {
    assert(r.quantity === 500 && r.unit === 'g' && r.item === 'sugar', '500g sugar');
  }
  if (text === '500 ग्राम लड्डू चाहिए') {
    assert(r.quantity === 500 && r.unit === 'g' && r.item === 'लड्डू', 'Devanagari 500 g laddu');
  }
  if (text.startsWith('2 किलो चीनी')) {
    assert(r.quantity === 2 && r.unit === 'kg' && r.item === 'चीनी', 'Devanagari 2 kg cheeni');
    assert(r.costPrice === 80 && r.profitAmount === 16 && r.totalAmount === 96, 'Devanagari cost/profit math');
  }
  if (text === 'लड्डू 500 ग्राम') {
    assert(r.quantity === 500 && r.unit === 'g' && r.item === 'लड्डू', 'Devanagari item before qty');
  }
  if (text.startsWith('2 కిలోలు')) {
    assert(r.quantity === 2 && r.unit === 'kg' && r.item === 'బియ్యం', 'Telugu 2 kg rice');
  }
  if (text.startsWith('500 గ్రాములు')) {
    assert(r.quantity === 500 && r.unit === 'g' && r.item === 'పప్పు', 'Telugu 500 g dal');
  }
}

const mustReject = ['hey how are you', 'I have 10 laddu at home', 'samosa 12 rupees'];
for (const text of mustReject) {
  const r = parseOrder(text);
  console.log('\nMSG :', text);
  console.log(r ? '->  PARSED (unexpected!)' : '->  rejected (not an order)');
  assert(!r, `rejected: "${text}"`);
}

// ---- False-positive guards -------------------------------------------------
// These messages contain a number but are NOT orders. A number-blind parser
// used to record them as sales.
const notOrders = [
  'I need 5 minutes',                   // the 5 is a duration, not a quantity
  'sold my bike for 40000',             // a number with no product at all
  'kitne ka hai ye 1kg wala?',          // a price question, not an order
  'meeting at 5, I want 2 chairs ready', // a time, not an order
];
for (const text of notOrders) {
  const r = parseOrder(text);
  console.log('\nMSG :', text);
  console.log(r ? '->  PARSED (unexpected!)' : '->  rejected (not an order)');
  assert(!r, `rejected (false positive): "${text}"`);
}

// ...and real orders that look similar must still be recorded.
const realOrders = [
  ['bhai 10 laddu chahiye', { quantity: 10, item: 'laddu' }],
  ['500g ladoo bhejo, cost 200, profit 15%', { quantity: 500, unit: 'g', item: 'ladoo', costPrice: 200, profitPercent: 15 }],
  ['aadha kilo besan chahiye', { quantity: 0.5, unit: 'kg', item: 'besan' }],
  ['500 ग्राम लड्डू चाहिए', { quantity: 500, unit: 'g', item: 'लड्डू' }],
];
for (const [text, want] of realOrders) {
  const r = parseOrder(text);
  console.log('\nMSG :', text);
  console.log(r
    ? '->  ' + JSON.stringify({ item: r.item, quantity: r.quantity, unit: r.unit, costPrice: r.costPrice, profitPercent: r.profitPercent })
    : '->  REJECTED (unexpected!)');
  assert(!!r, `accepted: "${text}"`);
  if (r) {
    for (const [key, value] of Object.entries(want)) {
      assert(r[key] === value, `"${text}": ${key} is ${JSON.stringify(r[key])}, expected ${JSON.stringify(value)}`);
    }
  }
}

console.log(`\n=== Parser checks: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
