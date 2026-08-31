// Simple JSON file store for orders. No native deps, survives restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Data dir can be overridden (Android APK stores user data outside the bundled engine)
const DATA_DIR = process.env.VYAPAR_DATA_DIR || path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(orders) {
  ensureDir();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function addOrder(order) {
  const orders = load();
  const record = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    customer: order.customer || 'Unknown',
    item: order.item || 'Item not specified',
    quantity: order.quantity ?? null,
    unit: order.unit ?? null,
    costPrice: order.costPrice ?? null,
    profitPercent: order.profitPercent ?? null,
    profitAmount: order.profitAmount ?? null,
    totalAmount: order.totalAmount ?? null,
    source: order.source || 'manual',
    raw: order.raw || null,
  };
  orders.unshift(record);
  save(orders);
  return record;
}

function getOrders() {
  return load();
}

function deleteOrder(id) {
  const orders = load();
  const next = orders.filter((o) => o.id !== id);
  const removed = next.length !== orders.length;
  if (removed) save(next);
  return removed;
}

function getStats() {
  const orders = load();
  let revenue = 0;
  let cost = 0;
  let profit = 0;
  for (const o of orders) {
    if (o.totalAmount != null) revenue += o.totalAmount;
    if (o.costPrice != null) cost += o.costPrice;
    if (o.profitAmount != null) profit += o.profitAmount;
  }
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  return {
    totalOrders: orders.length,
    revenue: round2(revenue),
    cost: round2(cost),
    profit: round2(profit),
    avgMarginPct: round2(margin),
  };
}

function seedDemo() {
  // Replace previously seeded demo orders, keep real ones (whatsapp / manual / ai)
  const orders = load().filter((o) => o.source !== 'demo');
  const demo = [
    { customer: 'Mayank', item: 'Ladoo', quantity: 500, unit: 'g', costPrice: 200, profitPercent: 15, profitAmount: 30, totalAmount: 230, raw: 'Order from Mayank, 500 grams ladoo, +15% profit, total cost of ladoo=200 rupees' },
    { customer: 'Sharma Uncle', item: 'Kaju Katli', quantity: 1, unit: 'kg', costPrice: 850, profitPercent: 20, profitAmount: 170, totalAmount: 1020, raw: 'sold 1kg kaju katli to sharma uncle, cost 850, profit 20%' },
    { customer: 'Priya Gupta', item: 'Chocolate Cake', quantity: 2, unit: 'kg', costPrice: 700, profitPercent: 25, profitAmount: 175, totalAmount: 875, raw: 'Order from Priya Gupta, 2 kg chocolate cake, cost 700, +25% profit' },
    { customer: 'Ravi Kirana Store', item: 'Namkeen', quantity: 5, unit: 'kg', costPrice: 400, profitPercent: 18, profitAmount: 72, totalAmount: 472, raw: 'ravi kirana ne 5kg namkeen mange, cost 400, profit 18%' },
  ].map((d) => ({ id: crypto.randomUUID(), timestamp: new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(), source: 'demo', ...d }));
  ensureDir();
  save([...demo, ...orders]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { addOrder, getOrders, deleteOrder, getStats, seedDemo };
