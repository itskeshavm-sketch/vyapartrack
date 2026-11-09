package com.vyapartrack.app;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;
import wabridge.Wabridge;

/**
 * Localhost REST API with the same surface as the Render server (server.js),
 * so the existing dashboard assets work unchanged against the on-phone engine.
 * Binds to 127.0.0.1 only - nothing off-device can reach it.
 */
public class LocalApi extends NanoHTTPD {

    private static final String TAG = "VyaparApi";
    // Must match DEFAULT_API_TOKEN in dashboard/app.js. /api/health is open;
    // other endpoints accept this token or a missing header (localhost only).
    static final String DEFAULT_TOKEN = "44fff7e79de139a9e85b0e77c9c5017a0b84dac30978e4f6bf";

    // Last minted pairing code, echoed via /api/status for the onboarding screen.
    private volatile String pairingCode = null;
    private volatile long pairingCodeAt = 0;
    private static final long PAIRING_TTL_MS = 150000;

    private volatile boolean started = false;

    public LocalApi(int port) {
        super("127.0.0.1", port);
    }

    public boolean isListening() {
        return started;
    }

    @Override
    public void start(int timeout, boolean daemon) throws IOException {
        super.start(timeout, daemon);
        started = true;
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();

        if (Method.OPTIONS == method) {
            Response r = newFixedLengthResponse("");
            addCors(r);
            return r;
        }

        try {
            JSONObject body = readBody(session);
            String token = session.getHeaders().get("x-api-token");
            boolean authed = token == null || token.isEmpty() || DEFAULT_TOKEN.equals(token);

            Response resp;
            if (!authed) {
                resp = json(401, err("Unauthorized"));
            } else {
                resp = route(method, uri, body);
            }
            addCors(resp);
            return resp;
        } catch (Exception e) {
            Log.w(TAG, "serve error: " + e.getMessage());
            Response r = json(500, err(e.getMessage() == null ? "internal error" : e.getMessage()));
            addCors(r);
            return r;
        }
    }

    private Response route(Method method, String uri, JSONObject body) throws Exception {
        switch (method) {
            case GET: {
                switch (uri) {
                    case "/api/health": {
                        JSONObject h = new JSONObject();
                        h.put("ok", true);
                        h.put("parser", "offline");
                        h.put("botStarted", true);
                        h.put("engine", "on-phone");
                        return json(200, h);
                    }
                    case "/api/status": {
                        JSONObject s = new JSONObject(EngineHandler.lastStatus);
                        s.put("parser", "offline");
                        if (pairingCode != null && System.currentTimeMillis() - pairingCodeAt < PAIRING_TTL_MS) {
                            s.put("pairingCode", pairingCode);
                            s.put("pairingExpiresAt", pairingCodeAt + PAIRING_TTL_MS);
                        } else {
                            s.put("pairingCode", JSONObject.NULL);
                            s.put("pairingExpiresAt", JSONObject.NULL);
                        }
                        return json(200, s);
                    }
                    case "/api/orders":
                        return json(200, OrdersStore.getOrders());
                    case "/api/stats":
                        return json(200, OrdersStore.getStats());
                    case "/api/catalog":
                        return json(200, OrdersStore.getCatalog());
                    case "/api/pending-pricing":
                        return json(200, new JSONArray());
                    case "/api/contacts": {
                        JSONObject c = new JSONObject();
                        c.put("savedNames", new JSONObject());
                        c.put("lidToPn", new JSONObject());
                        return json(200, c);
                    }
                    case "/api/engine-log": {
                        JSONObject l = new JSONObject();
                        l.put("log", EngineLog.tail(500));
                        l.put("path", EngineLog.path() == null ? "" : EngineLog.path());
                        return json(200, l);
                    }
                }
                break;
            }
            case POST: {
                switch (uri) {
                    case "/api/pair": {
                        String phone = body == null ? "" : body.optString("phone", "").replaceAll("\\D", "");
                        if (phone.length() == 10) phone = "91" + phone;
                        try {
                            String code = Wabridge.requestPairCode(phone);
                            pairingCode = code;
                            pairingCodeAt = System.currentTimeMillis();
                            EngineLog.write("[PAIR] code minted for +" + phone + ": " + code);
                            JSONObject o = new JSONObject();
                            o.put("code", code);
                            o.put("expiresIn", (int) (PAIRING_TTL_MS / 1000));
                            return json(200, o);
                        } catch (Exception e) {
                            String msg = e.getMessage() == null ? "pairing failed" : e.getMessage();
                            EngineLog.write("[PAIR] mint FAILED for +" + phone + ": " + msg);
                            if (msg.contains("rate-overlimit") || msg.contains("rate-limiting")) {
                                msg = "WhatsApp is rate-limiting pairing attempts for this account. Wait at least 30 minutes (a few hours is safer), then tap again.";
                            } else if (msg.matches("(?i).*(connection closed|websocket|not ready|reconnect).*")) {
                                msg = "WhatsApp is reconnecting - tap again in a few seconds";
                            }
                            return json(400, err(msg));
                        }
                    }
                    case "/api/orders": {
                        String text = body == null ? "" : body.optString("text", "").trim();
                        if (text.isEmpty()) return json(400, err("Provide { \"text\": \"...\" }"));
                        JSONObject parsed = JavaParser.parse(text);
                        if (parsed == null) return json(422, err("Could not find an order in that message"));
                        JSONObject rec = OrdersStore.addOrder(parsed, "manual");
                        return json(201, rec);
                    }
                    case "/api/demo":
                        return json(200, new JSONObject().put("ok", true).put("count", OrdersStore.seedDemo()));
                    case "/api/catalog": {
                        JSONObject entry = OrdersStore.upsertCatalog(body == null ? new JSONObject() : body);
                        if (entry == null) return json(400, err("name required"));
                        entry.put("repricedOrders", OrdersStore.repriceOrdersForItem(entry));
                        return json(200, entry);
                    }
                    case "/api/pending-pricing/resolve":
                        return json(404, err("not supported on-device yet"));
                }
                if (uri.startsWith("/api/pending-pricing/") && uri.endsWith("/resolve")) {
                    return json(404, err("not supported on-device yet"));
                }
                break;
            }
            case DELETE: {
                if (uri.startsWith("/api/orders/")) {
                    String id = uri.substring("/api/orders/".length());
                    return json(200, new JSONObject().put("deleted", OrdersStore.deleteOrder(id)));
                }
                if (uri.startsWith("/api/catalog/")) {
                    String id = uri.substring("/api/catalog/".length());
                    return json(200, new JSONObject().put("deleted", OrdersStore.deleteCatalog(id)));
                }
                break;
            }
        }
        return json(404, err("not found: " + uri));
    }

    // ---- helpers ----

    private JSONObject readBody(IHTTPSession session) {
        if (Method.POST != session.getMethod() && Method.PUT != session.getMethod()) return null;
        Map<String, String> files = new java.util.HashMap<>();
        try {
            session.parseBody(files);
        } catch (Exception e) {
            return null;
        }
        String raw = files.get("postData");
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private Response json(int status, Object payload) {
        Response r = newFixedLengthResponse(Response.Status.lookup(status),
                "application/json", payload.toString());
        r.addHeader("Access-Control-Allow-Origin", "*");
        return r;
    }

    private JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("error", msg); } catch (Exception ignored) {}
        return o;
    }

    private void addCors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token");
        r.addHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    }
}
