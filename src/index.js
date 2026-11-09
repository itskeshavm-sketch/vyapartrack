// Entry point: dashboard + optional WhatsApp bot.
//
// The dashboard and the offline order parser have no native dependencies, so
// they always run. The WhatsApp engine (zapo-js + SQLite session store) is
// loaded lazily: a clean machine without a C++ toolchain still gets a working
// dashboard instead of failing at require() time.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { startServer } = require('./server');

const PORT = parseInt(process.env.PORT || '3000', 10);
const NO_BOT = process.env.NO_BOT === 'true';

function loadBot() {
  if (NO_BOT) return null;
  try {
    return require('./bot');
  } catch (err) {
    console.warn('\n  ⚠ WhatsApp engine could not load:', err.message);
    console.warn('  → Dashboard-only mode is still available.');
    console.warn('  → Run "npm install" again, or use "npm run start:demo".\n');
    return null;
  }
}

const bot = loadBot();

async function main() {
  const statusFn = bot ? () => ({ ...bot.getStatus(), botEnabled: true }) : () => ({
    connected: false,
    connecting: false,
    qrDataUrl: null,
    pairingCode: null,
    pairingExpiresAt: null,
    lastError: null,
    botEnabled: false,
  });
  const pairFn = bot ? bot.requestPairingCode : null;

  await startServer(PORT, statusFn, pairFn);

  console.log(`\n  📊 Dashboard : http://localhost:${PORT}`);
  console.log(`  🧮 Parser    : offline (Hinglish + native scripts)`);
  console.log(`  💬 WhatsApp  : ${NO_BOT ? 'disabled (NO_BOT=true)' : bot ? 'starting…' : 'unavailable'}\n`);

  if (!bot) return;
  bot.startBot().catch((err) => console.error('[bot] failed to start:', err.message));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
