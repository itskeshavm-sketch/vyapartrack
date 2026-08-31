// Entry point: dashboard + WhatsApp bot together.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { startServer } = require('./server');
const { startBot, getStatus, requestPairingCode } = require('./bot');

const PORT = parseInt(process.env.PORT || '3000', 10);
const NO_BOT = process.env.NO_BOT === 'true';

async function main() {
  await startServer(PORT, getStatus, requestPairingCode);
  console.log(`\n  📊 Dashboard : http://localhost:${PORT}`);
  console.log(`  🔗 Poolside  : ${process.env.POOLSIDE_API_KEY ? 'configured' : 'not configured (regex parser only)'}`);
  console.log(`  🤖 Model     : ${process.env.POOLSIDE_MODEL || 'poolside/laguna-xs-2.1'}\n`);

  if (NO_BOT) {
    console.log('  NO_BOT=true -> dashboard-only mode, skipping WhatsApp connection.\n');
    return;
  }
  startBot().catch((err) => console.error('[bot] failed to start:', err.message));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
