// Express server + REST API + dashboard.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const store = require('./store');
const { extract } = require('./extractor');
const poolside = require('./poolside');

function createApp(botStatusFn, pairFn) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/orders', (req, res) => res.json(store.getOrders()));

  app.get('/api/stats', (req, res) => res.json(store.getStats()));

  app.get('/api/status', (req, res) =>
    res.json({ ...(botStatusFn ? botStatusFn() : {}), aiConfigured: poolside.isConfigured(), aiModel: poolside.MODEL }));

  app.post('/api/pair', async (req, res) => {
    if (!pairFn) return res.status(501).json({ error: 'WhatsApp bot is not running (NO_BOT mode)' });
    try {
      const code = await pairFn(req.body?.phone);
      res.json({ code });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/orders', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Provide { "text": "order message" }' });
    const order = await extract(text);
    if (!order) return res.status(422).json({ error: 'Could not find an order in that message' });
    const record = store.addOrder(order);
    res.status(201).json(record);
  });

  app.delete('/api/orders/:id', (req, res) => {
    res.json({ deleted: store.deleteOrder(req.params.id) });
  });

  app.post('/api/demo', (req, res) => {
    store.seedDemo();
    res.json({ ok: true });
  });

  return app;
}

function startServer(port, botStatusFn, pairFn) {
  const app = createApp(botStatusFn, pairFn);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  startServer(port, () => ({ connected: false, note: 'dashboard-only mode (run "npm start" to connect WhatsApp)' }))
    .then(() => console.log(`Dashboard running at http://localhost:${port}`))
    .catch((err) => {
      console.error('Server failed to start:', err.message);
      process.exit(1);
    });
}
