package com.vyapartrack.app;

import android.content.Context;
import android.database.Cursor;
import android.provider.ContactsContract;

import java.util.HashMap;
import java.util.Map;

/**
 * Saved-contact names for the on-phone engine. whatsmeow does NOT sync the
 * address book (unlike zapo), so we read the phone's own contacts directly
 * (READ_CONTACTS). The whole table is loaded once and cached, keyed by the
 * last 10 digits (numbers are stored formatted/E.164 inconsistently).
 */
final class ContactNames {

    private static volatile Map<String, String> byDigits; // null = not loaded / load failed
    private static volatile long lastAttemptAt;
    private static volatile String lastError = "";

    private ContactNames() {}

    /** Display name for a phone number (digits, any format), or null. */
    static String lookup(Context ctx, String phone) {
        String key = last10(phone);
        if (key == null) return null;
        Map<String, String> m = byDigits;
        if (m == null && System.currentTimeMillis() - lastAttemptAt > 30_000) {
            synchronized (ContactNames.class) {
                if (byDigits == null) {
                    lastAttemptAt = System.currentTimeMillis();
                    Map<String, String> loaded = loadAll(ctx);
                    // Only cache a NON-empty table: a denied permission or a
                    // too-early load must not poison lookups forever.
                    if (!loaded.isEmpty()) byDigits = loaded;
                }
                m = byDigits;
            }
        }
        return m == null ? null : m.get(key);
    }

    /** Call after READ_CONTACTS is granted (or contacts change) to force a reload. */
    static void invalidate() {
        byDigits = null;
        lastAttemptAt = 0;
    }

    /** Diagnostic string for the engine log. */
    static String status() {
        Map<String, String> m = byDigits;
        return "loaded=" + (m != null) + " entries=" + (m == null ? 0 : m.size())
                + " lastError=" + (lastError.isEmpty() ? "none" : lastError);
    }

    private static Map<String, String> loadAll(Context ctx) {
        Map<String, String> out = new HashMap<>();
        try (Cursor c = ctx.getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER,
                        ContactsContract.CommonDataKinds.Phone.NUMBER,
                }, null, null, null)) {
            if (c == null) return out;
            while (c.moveToNext()) {
                String name = c.getString(0);
                if (name == null || name.trim().isEmpty()) continue;
                String k = last10(c.getString(1) != null ? c.getString(1) : c.getString(2));
                if (k != null) out.putIfAbsent(k, name.trim());
            }
        } catch (SecurityException e) {
            lastError = "READ_CONTACTS denied";
        } catch (Exception e) {
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        return out;
    }

    private static String last10(String phone) {
        if (phone == null) return null;
        String digits = phone.replaceAll("\\D", "");
        if (digits.length() < 10) return null;
        return digits.substring(digits.length() - 10);
    }
}
