// Seeds a few sample orders so the dashboard can be previewed instantly.
const store = require('../src/store');
store.seedDemo();
console.log('Demo orders seeded. Open the dashboard and click Refresh.');
