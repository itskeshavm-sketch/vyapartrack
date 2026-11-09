// One-command demo: start the dashboard with WhatsApp disabled and seed
// realistic sample orders on first run. Perfect for a hackathon judging session
// on a laptop that has no API key, no WhatsApp link, and no C++ toolchain.
//
//   npm run start:demo

process.env.NO_BOT = 'true';
process.env.USE_AI_PARSER = process.env.USE_AI_PARSER || 'false';

const store = require('../src/store');

if (store.getOrders().length === 0) {
  store.seedDemo();
  console.log('\n  🌱 Seeded 4 demo orders (marked DEMO in the dashboard).');
}

require('../src/index');
