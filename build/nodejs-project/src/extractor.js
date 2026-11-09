// Order extraction: the built-in offline parser is the only parser.
// It handles Hinglish, English, spoken fractions, and native scripts with
// no network calls, API keys, or external services.

const { parseOrder } = require('./parser');

async function extract(messageText) {
  return parseOrder(messageText);
}

module.exports = { extract };
