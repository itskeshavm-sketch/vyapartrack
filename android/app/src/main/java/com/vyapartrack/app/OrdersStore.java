package com.vyapartrack.app;

// JSON file store for orders + item catalog. Mirrors the shapes produced by
// server/server.js so the dashboard app.js works against either backend.

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

final class OrdersStore {

    private static final Object LOCK = new Object();
    private static File dataDir;

    private OrdersStore() {}

    static void init(File dir) {
        synchronized (LOCK) {
            dataDir = dir;
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
    }

    private static File ordersFile() { return new File(dataDir, "orders.json"); }
    private static File catalogFile() { return new File(dataDir, "catalog.json"); }

    private static String read(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int read = in.read(buf);
            return new String(buf, 0, Math.max(read, 0), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private static void write(File f, String content) {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    private static String iso(long millis) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(millis));
    }

    static JSONArray getOrders() {
        synchronized (LOCK) {
            try {
                return new JSONArray(read(ordersFile()));
            } catch (Exception e) {
                return new JSONArray();
            }
        }
    }

    static JSONObject addOrder(JSONObject parsed, String source) {
        applyCatalogPricing(parsed);
        JSONObject rec = new JSONObject();
        synchronized (LOCK) {
            try {
                rec.put("id", UUID.randomUUID().toString());
                rec.put("timestamp", iso(System.currentTimeMillis()));
                rec.put("customer", parsed.optString("customer", "Unknown").isEmpty() ? "Unknown" : parsed.optString("customer", "Unknown"));
                rec.put("item", parsed.optString("item", "Item not specified").isEmpty() ? "Item not specified" : parsed.optString("item", "Item not specified"));
                putNum(rec, "quantity", parsed.opt("quantity"));
                rec.put("unit", parsed.optString("unit", null));
                putNum(rec, "costPrice", parsed.opt("costPrice"));
                putNum(rec, "profitPercent", parsed.opt("profitPercent"));
                putNum(rec, "profitAmount", parsed.opt("profitAmount"));
                putNum(rec, "totalAmount", parsed.opt("totalAmount"));
                if (parsed.has("pricedBy")) rec.put("pricedBy", parsed.optString("pricedBy", null));
                if (parsed.has("pricedTotalBy")) rec.put("pricedTotalBy", parsed.optString("pricedTotalBy", null));
                if (parsed.has("pricedCostBy")) rec.put("pricedCostBy", parsed.optString("pricedCostBy", null));
                rec.put("source", source);
                rec.put("raw", parsed.optString("raw", null));

                JSONArray orders = getOrders();
                JSONArray next = new JSONArray();
                next.put(rec);
                for (int i = 0; i < orders.length(); i++) next.put(orders.get(i));
                write(ordersFile(), next.toString(2));
            } catch (Exception ignored) {}
        }
        return rec;
    }

    static JSONObject findCatalogItem(String name) {
        if (name == null || name.trim().isEmpty()) return null;
        String n = name.trim().toLowerCase();
        JSONArray items = getCatalog();
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            String in2 = it.optString("name", "").trim().toLowerCase();
            if (in2.isEmpty()) continue;
            if (in2.equals(n) || in2.contains(n) || n.contains(in2)) return it;
        }
        return null;
    }

    private static Double convertQty(double qty, String fromUnit, String toUnit, Double pieceWeight) {
        if (fromUnit == null || toUnit == null || fromUnit.equals(toUnit)) return qty;
        double fb = unitBase(fromUnit), tb = unitBase(toUnit);
        String fd = unitDim(fromUnit), td = unitDim(toUnit);
        if (!fd.equals(td)) {
            if (("count".equals(fd) && "mass".equals(td)) || ("mass".equals(fd) && "count".equals(td))) {
                if (pieceWeight == null || pieceWeight <= 0) return null;
                double grams = qty * unitBase(fromUnit) * ("count".equals(fd) ? pieceWeight : 1) / ("count".equals(fd) ? 1 : pieceWeight);
                return round2("kg".equals(td) ? grams / 1000.0 : grams);
            }
            return null;
        }
        return round2(qty * (fb / tb));
    }

    private static double unitBase(String u) {
        switch (u) { case "kg": return 1000; case "l": return 1000; case "dozen": return 12; default: return 1; }
    }

    private static String unitDim(String u) {
        switch (u) { case "kg": case "g": return "mass"; case "l": case "ml": return "volume"; case "pcs": case "dozen": return "count"; default: return ""; }
    }

    private static double priceQtyOf(JSONObject cat) {
        if (cat == null || cat.isNull("priceQty")) return 1;
        double pq = cat.optDouble("priceQty", 1);
        return (Double.isNaN(pq) || pq <= 0) ? 1 : pq;
    }

    static void applyCatalogPricing(JSONObject order) {
        try {
            String item = order.optString("item", "");
            Object qo = order.opt("quantity");
            if (item.isEmpty() || qo == null || qo == JSONObject.NULL) return;
            double qty = order.optDouble("quantity", Double.NaN);
            if (Double.isNaN(qty)) return;
            JSONObject cat = findCatalogItem(item);
            if (cat == null || cat.isNull("sellPrice")) return;
            double sell = cat.optDouble("sellPrice", Double.NaN);
            if (Double.isNaN(sell)) return;
            String oUnit = order.isNull("unit") ? null : order.optString("unit", null);
            String cUnit = cat.isNull("unit") ? null : cat.optString("unit", null);
            Double pw = cat.isNull("pieceWeight") ? null : cat.optDouble("pieceWeight");
            boolean sameUnit = oUnit != null && cUnit != null && oUnit.equals(cUnit);
            boolean agnostic = oUnit == null || cUnit == null || sameUnit;
            Double qtyIn = agnostic ? qty : convertQty(qty, oUnit, cUnit, pw);
            if (qtyIn == null) return;
            double perQty = priceQtyOf(cat);
            boolean filledTotal = order.isNull("totalAmount");
            boolean filledCost = order.isNull("costPrice") && !cat.isNull("costPrice");
            if (filledTotal) order.put("totalAmount", round2(sell * qtyIn / perQty));
            if (filledCost) order.put("costPrice", round2(cat.optDouble("costPrice") * qtyIn / perQty));
            if (!order.isNull("costPrice") && !order.isNull("totalAmount")) {
                double cost = order.optDouble("costPrice");
                double total = order.optDouble("totalAmount");
                double profit = round2(total - cost);
                order.put("profitAmount", profit);
                order.put("profitPercent", cost > 0 ? round2(profit / cost * 100.0) : JSONObject.NULL);
            }
            if (filledTotal || filledCost) {
                order.put("pricedBy", "catalog");
                if (filledTotal) order.put("pricedTotalBy", "catalog");
                if (filledCost) order.put("pricedCostBy", "catalog");
            }
        } catch (Exception ignored) {}
    }

    static int repriceOrdersForItem(JSONObject entry) {
        if (entry == null || entry.isNull("sellPrice")) return 0;
        synchronized (LOCK) {
            try {
                JSONArray orders = getOrders();
                int updated = 0;
                for (int i = 0; i < orders.length(); i++) {
                    JSONObject o = orders.optJSONObject(i);
                    if (o == null || o.isNull("quantity")) continue;
                    if (!"catalog".equals(o.optString("pricedTotalBy", "")) && !o.isNull("totalAmount")) continue;
                    JSONObject match = findCatalogItem(o.optString("item", ""));
                    if (match == null || !match.optString("id", "").equals(entry.optString("id", ""))) continue;
                    double qty = o.optDouble("quantity", Double.NaN);
                    if (Double.isNaN(qty)) continue;
                    String oUnit = o.isNull("unit") ? null : o.optString("unit", null);
                    String cUnit = entry.isNull("unit") ? null : entry.optString("unit", null);
                    Double pw = entry.isNull("pieceWeight") ? null : entry.optDouble("pieceWeight");
                    boolean sameUnit = oUnit != null && cUnit != null && oUnit.equals(cUnit);
                    boolean agnostic = oUnit == null || cUnit == null || sameUnit;
                    Double qtyIn = agnostic ? qty : convertQty(qty, oUnit, cUnit, pw);
                    if (qtyIn == null) continue;
                    double sell = entry.optDouble("sellPrice");
                    double perQty = priceQtyOf(entry);
                    if ("catalog".equals(o.optString("pricedTotalBy", "")) || o.isNull("totalAmount")) {
                        o.put("totalAmount", round2(sell * qtyIn / perQty));
                        o.put("pricedTotalBy", "catalog");
                    }
                    if ("catalog".equals(o.optString("pricedCostBy", ""))) {
                        if (!entry.isNull("costPrice")) o.put("costPrice", round2(entry.optDouble("costPrice") * qtyIn / perQty));
                    } else if (o.isNull("costPrice") && !entry.isNull("costPrice")) {
                        o.put("costPrice", round2(entry.optDouble("costPrice") * qtyIn / perQty));
                        o.put("pricedCostBy", "catalog");
                    }
                    if (!o.isNull("costPrice") && !o.isNull("totalAmount")) {
                        double cost = o.optDouble("costPrice");
                        double total = o.optDouble("totalAmount");
                        double profit = round2(total - cost);
                        o.put("profitAmount", profit);
                        o.put("profitPercent", cost > 0 ? round2(profit / cost * 100.0) : JSONObject.NULL);
                    }
                    o.put("pricedBy", "catalog");
                    updated++;
                }
                if (updated > 0) write(ordersFile(), orders.toString(2));
                return updated;
            } catch (Exception e) {
                return 0;
            }
        }
    }

    private static void putNum(JSONObject rec, String key, Object v) {
        try {
            if (v == null || v == JSONObject.NULL) rec.put(key, JSONObject.NULL);
            else rec.put(key, v);
        } catch (Exception ignored) {}
    }

    static boolean deleteOrder(String id) {
        synchronized (LOCK) {
            try {
                JSONArray orders = getOrders();
                JSONArray next = new JSONArray();
                boolean removed = false;
                for (int i = 0; i < orders.length(); i++) {
                    JSONObject o = orders.getJSONObject(i);
                    if (id.equals(o.optString("id"))) { removed = true; continue; }
                    next.put(o);
                }
                if (removed) write(ordersFile(), next.toString(2));
                return removed;
            } catch (Exception e) {
                return false;
            }
        }
    }

    static JSONObject getStats() {
        JSONArray orders = getOrders();
        double revenue = 0, cost = 0, profit = 0;
        for (int i = 0; i < orders.length(); i++) {
            JSONObject o = orders.optJSONObject(i);
            if (o == null) continue;
            Double rv = optDouble(o, "totalAmount"); if (rv != null) revenue += rv;
            Double v;
            v = optDouble(o, "costPrice"); if (v != null) cost += v;
            v = optDouble(o, "profitAmount"); if (v != null) profit += v;
        }
        JSONObject s = new JSONObject();
        try {
            s.put("totalOrders", orders.length());
            s.put("revenue", round2(revenue));
            s.put("cost", round2(cost));
            s.put("profit", round2(profit));
            s.put("avgMarginPct", revenue > 0 ? round2(profit / revenue * 100.0) : 0);
        } catch (Exception ignored) {}
        return s;
    }

    private static Double optDouble(JSONObject o, String key) {
        if (o.isNull(key)) return null;
        double d = o.optDouble(key, Double.NaN);
        return Double.isNaN(d) ? null : d;
    }

    private static double round2(double n) { return Math.round(n * 100) / 100.0; }

    static int seedDemo() {
        synchronized (LOCK) {
            try {
                JSONArray existing = getOrders();
                long now = System.currentTimeMillis();
                String[][] demo = {
                    {"Mayank", "Ladoo", "500", "g", "200", "15", "30", "230"},
                    {"Sharma Uncle", "Kaju Katli", "1", "kg", "850", "20", "170", "1020"},
                    {"Priya Gupta", "Chocolate Cake", "2", "kg", "700", "25", "175", "875"},
                    {"Ravi Kirana", "Namkeen", "5", "kg", "400", "18", "72", "472"},
                };
                JSONArray next = new JSONArray();
                for (int i = 0; i < demo.length; i++) {
                    JSONObject d = new JSONObject();
                    d.put("id", UUID.randomUUID().toString());
                    d.put("timestamp", iso(now - i * 3600000L));
                    d.put("customer", demo[i][0]);
                    d.put("item", demo[i][1]);
                    d.put("quantity", Double.parseDouble(demo[i][2]));
                    d.put("unit", demo[i][3]);
                    d.put("costPrice", Double.parseDouble(demo[i][4]));
                    d.put("profitPercent", Double.parseDouble(demo[i][5]));
                    d.put("profitAmount", Double.parseDouble(demo[i][6]));
                    d.put("totalAmount", Double.parseDouble(demo[i][7]));
                    d.put("source", "demo");
                    next.put(d);
                }
                for (int i = 0; i < existing.length(); i++) next.put(existing.get(i));
                write(ordersFile(), next.toString(2));
                return demo.length;
            } catch (Exception e) {
                return 0;
            }
        }
    }

    // ---- Item catalog (teach prices; stored, listed, deletable) ----

    static JSONArray getCatalog() {
        synchronized (LOCK) {
            try {
                return new JSONArray(read(catalogFile()));
            } catch (Exception e) {
                return new JSONArray();
            }
        }
    }

    /** Adds or updates a catalog entry by (case-insensitive) name. Returns the entry. */
    static JSONObject upsertCatalog(JSONObject body) {
        synchronized (LOCK) {
            try {
                String name = body.optString("name", "").trim();
                if (name.isEmpty()) return null;
                JSONArray items = getCatalog();
                JSONObject entry = null;
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    if (name.equalsIgnoreCase(it.optString("name"))) { entry = it; break; }
                }
                if (entry == null) {
                    entry = new JSONObject();
                    entry.put("id", UUID.randomUUID().toString());
                    entry.put("name", name);
                    JSONArray next = new JSONArray();
                    next.put(entry);
                    for (int i = 0; i < items.length(); i++) next.put(items.get(i));
                    items = next;
                }
                if (body.has("unit")) entry.put("unit", body.optString("unit", null));
                if (body.has("sellPrice")) putNum(entry, "sellPrice", body.isNull("sellPrice") ? null : body.optDouble("sellPrice"));
                if (body.has("costPrice")) putNum(entry, "costPrice", body.isNull("costPrice") ? null : body.optDouble("costPrice"));
                if (body.has("priceQty")) putNum(entry, "priceQty", body.isNull("priceQty") ? null : body.optDouble("priceQty"));
                if (body.has("pieceWeight")) putNum(entry, "pieceWeight", body.isNull("pieceWeight") ? null : body.optDouble("pieceWeight"));
                write(catalogFile(), items.toString(2));
                return entry;
            } catch (Exception e) {
                return null;
            }
        }
    }

    static boolean deleteCatalog(String id) {
        synchronized (LOCK) {
            try {
                JSONArray items = getCatalog();
                JSONArray next = new JSONArray();
                boolean removed = false;
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    if (id.equals(it.optString("id"))) { removed = true; continue; }
                    next.put(it);
                }
                if (removed) write(catalogFile(), next.toString(2));
                return removed;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
