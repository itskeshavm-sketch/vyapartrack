// Order extraction orchestrator: Poolside AI first (when configured),
// built-in regex parser as fallback. Validates and fills gaps either way.

const { extractOrder, isConfigured } = require('./poolside');
const { parseOrder } = require('./parser');

async function extract(messageText) {
  let order = null;

  if (process.env.USE_AI_PARSER !== 'false' && isConfigured()) {
    order = await extractOrder(messageText);
    if (order) {
      // Sanity check: an AI result still needs a cost or a total
      if (order.costPrice == null && order.totalAmount == null) order = null;
    }
  }

  if (!order) order = parseOrder(messageText);
  return order;
}

module.exports = { extract };
