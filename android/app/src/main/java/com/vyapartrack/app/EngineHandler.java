package com.vyapartrack.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import wabridge.Handler;
import wabridge.Wabridge;

/**
 * Receives events from the Go WhatsApp engine (wabridge.Handler) and runs the
 * order pipeline: filter -> parse -> store -> auto-reply. The dashboard picks
 * orders up by polling the LocalApi like it polls the Render server.
 */
public class EngineHandler implements Handler {

    private static final String TAG = "VyaparEngine";
    // Latest OnStatus payload; served by LocalApi under /api/status.
    volatile static String lastStatus = "{\"linked\":false,\"connected\":false,\"connecting\":false,\"pairing\":false,\"lastError\":\"\"}";

    // Single worker so a slow SendMessage never blocks whatsmeow's event loop.
    private final ExecutorService replyExecutor = Executors.newSingleThreadExecutor();
    private final Context ctx;

    public EngineHandler(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    @Override
    public void onMessage(String jsonPayload) {
        try {
            JSONObject msg = new JSONObject(jsonPayload);
            String chatJid = msg.optString("chatJid", "");
            String sender = msg.optString("sender", "");
            String text = msg.optString("text", "");
            boolean isGroup = msg.optBoolean("isGroup", false);

            if (chatJid.isEmpty() || text.isEmpty()) return;
            // Groups/broadcasts/newsletters: parse nothing, reply nothing.
            if (isGroup || chatJid.contains("@g.us") || chatJid.contains("@broadcast")
                    || chatJid.contains("@newsletter") || chatJid.equals("status@broadcast")) return;

            // Ignore messages that are mostly links (spam/marketing), same as the server.
            java.util.regex.Matcher link = java.util.regex.Pattern.compile("https?://", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(text);
            int linkCount = 0;
            while (link.find()) linkCount++;
            String stripped = text.replaceAll("https?://\\S+", "").trim();
            if (linkCount >= 1 && stripped.length() < 20) return;

            EngineLog.write("[MSG] in: chat=" + chatJid + " sender=" + sender + " text=\"" + text.replace("\n", " ") + "\"");
            JSONObject parsed = JavaParser.parse(text);
            if (parsed == null) { EngineLog.write("[MSG] not parsed as order, ignored"); return; }

            // Customer: saved phone-contact name -> sender number -> message name.
            // (was: computed but never stored, so every WhatsApp order said Unknown)
            String name = ContactNames.lookup(ctx, sender);
            if (name == null && !sender.isEmpty()) {
                EngineLog.write("[CONTACT] no saved-name for " + sender + " (" + ContactNames.status() + ")");
            }
            String customer = name != null ? name : (!sender.isEmpty() ? sender : parsed.optString("customer", "Unknown"));
            parsed.put("customer", customer);
            JSONObject rec = OrdersStore.addOrder(parsed, "whatsapp");
            EngineLog.write("[ORDER] " + rec.optString("customer") + " | " + rec.optDouble("quantity", 0)
                    + rec.optString("unit", "") + " " + rec.optString("item") + " | total " + rec.opt("totalAmount"));
            Log.i(TAG, "Order: " + rec.optString("customer") + " | " + rec.optDouble("quantity", 0) + rec.optString("unit", "")
                    + " " + rec.optString("item") + " | total " + rec.opt("totalAmount"));

            replyExecutor.execute(() -> {
                try {
                    Double total = rec.isNull("totalAmount") ? null : rec.optDouble("totalAmount");
                    String reply;
                    if (total != null) {
                        // Customer-facing: NEVER include cost/profit/margin (seller-confidential).
                        // Only confirmation + item + price the customer pays.
                        StringBuilder sb = new StringBuilder();
                        sb.append("✅ *ऑर्डर मिल गया!*\n");
                        sb.append("📦 ");
                        if (!rec.isNull("quantity")) sb.append(trimNum(rec.optDouble("quantity", 0)));
                        String du = displayUnit(rec.optString("unit", ""));
                        if (!du.isEmpty()) sb.append(' ').append(du);
                        sb.append(' ').append(rec.optString("item")).append('\n');
                        sb.append("🧾 कीमत: ₹").append(trimNum(total)).append("\n\nधन्यवाद! 🙏");
                        reply = sb.toString();
                    } else {
                        // No price yet (item not in catalog). Confirm what we
                        // understood; ask "how much?" ONLY when the quantity
                        // itself wasn't in the message — never parrot back a
                        // qty the customer already gave (e.g. "500g sugar").
                        StringBuilder sb = new StringBuilder();
                        sb.append("✅ *आपका ऑर्डर मिल गया!* ");
                        boolean hasQty = !rec.isNull("quantity");
                        if (hasQty) sb.append(trimNum(rec.optDouble("quantity", 0)));
                        String unitHi = unitHindi(rec.optString("unit", ""));
                        if (!unitHi.isEmpty()) sb.append(' ').append(unitHi);
                        else if (!rec.isNull("unit") && !rec.optString("unit").isEmpty()) sb.append(' ').append(rec.optString("unit"));
                        sb.append(' ').append(rec.optString("item")).append('\n');
                        if (!hasQty && !unitHi.isEmpty()) {
                            String kitna = ("pcs".equals(rec.optString("unit", "")) || "dozen".equals(rec.optString("unit", ""))) ? "कितने" : "कितना";
                            sb.append("🧾 ").append(kitna).append(" ").append(unitHi).append(" ").append(rec.optString("item")).append(" चाहिए? कीमत जल्द ही कन्फर्म होगी। धन्यवाद! 🙏");
                        } else {
                            sb.append("🧾 कीमत जल्द ही कन्फर्म होगी। धन्यवाद! 🙏");
                        }
                        reply = sb.toString();
                    }
                    Wabridge.sendText(chatJid, reply);
                } catch (Exception e) {
                    Log.w(TAG, "auto-reply failed: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "onMessage error: " + e.getMessage());
        }
    }

    private static String trimNum(double d) {
        if (d == Math.floor(d) && !Double.isInfinite(d)) return String.valueOf((long) d);
        return String.valueOf(Math.round(d * 100) / 100.0);
    }

    private static String displayUnit(String unit) {
        String hi = unitHindi(unit);
        if (!hi.isEmpty()) return hi;
        return unit == null ? "" : unit;
    }

    private static String unitHindi(String unit) {
        if (unit == null) return "";
        switch (unit) {
            case "kg": return "किलो";
            case "g": return "ग्राम";
            case "l": return "लीटर";
            case "ml": return "मिली";
            case "pcs": return "पीस";
            case "dozen": return "दर्जन";
            default: return "";
        }
    }

    @Override
    public void onStatus(String jsonStatus) {
        lastStatus = jsonStatus;
        EngineLog.write("[STATUS] " + jsonStatus);
        Log.i(TAG, "status: " + jsonStatus);
    }

    @Override
    public void onLog(String line) {
        if (line == null || line.isEmpty()) return;
        EngineLog.write(line);
        if (line.startsWith("[ERROR")) Log.e("GoLog", line);
        else if (line.startsWith("[WARN")) Log.w("GoLog", line);
        else Log.d("GoLog", line);
    }
}
