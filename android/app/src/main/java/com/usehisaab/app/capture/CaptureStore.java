package com.usehisaab.app.capture;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * On-device queue of captured bank-alert candidates plus the user's opt-in.
 *
 * PRIVACY: everything here stays in the app's private SharedPreferences and
 * is excluded from Android backup (allowBackup=false). A candidate is removed
 * the moment JS takes it (the user tapped "Record this?"), on sign-out
 * (HisaabCapturePlugin.clear), or when it falls off the end of the queue.
 * Nothing in this file talks to the network.
 */
public final class CaptureStore {

    private static final String PREFS = "hisaab_capture";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_LABEL_TITLE = "label_title";
    private static final String KEY_LABEL_BODY = "label_body";
    private static final String KEY_QUEUE = "queue";
    private static final String KEY_RECENT = "recent";

    /** Oldest candidates drop off past this many. */
    private static final int MAX_QUEUE = 20;
    /** Same text from the same app inside this window is one alert. */
    private static final long DEDUPE_WINDOW_MS = 10 * 60 * 1000L;

    private CaptureStore() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context ctx, boolean enabled) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public static void setLabels(Context ctx, String title, String body) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (title != null && !title.isEmpty()) e.putString(KEY_LABEL_TITLE, title);
        if (body != null && !body.isEmpty()) e.putString(KEY_LABEL_BODY, body);
        e.apply();
    }

    /** Localised notification text JS handed over, or null for the resource fallback. */
    public static String labelTitle(Context ctx) {
        return prefs(ctx).getString(KEY_LABEL_TITLE, null);
    }

    public static String labelBody(Context ctx) {
        return prefs(ctx).getString(KEY_LABEL_BODY, null);
    }

    /** True (and records the sighting) when the same alert was seen within the window. */
    public static synchronized boolean seenRecently(Context ctx, int hash, long now) {
        JSONArray recent = readArray(ctx, KEY_RECENT);
        JSONArray kept = new JSONArray();
        boolean seen = false;
        for (int i = 0; i < recent.length(); i++) {
            JSONObject entry = recent.optJSONObject(i);
            if (entry == null) continue;
            long at = entry.optLong("at", 0);
            if (now - at > DEDUPE_WINDOW_MS) continue;
            if (entry.optInt("h", 0) == hash) seen = true;
            kept.put(entry);
        }
        if (!seen) {
            try {
                kept.put(new JSONObject().put("h", hash).put("at", now));
            } catch (JSONException ignored) {
                // Unreachable: fixed keys and primitive values.
            }
        }
        prefs(ctx).edit().putString(KEY_RECENT, kept.toString()).apply();
        return seen;
    }

    /** Queues a candidate and returns its id. */
    public static synchronized String enqueue(Context ctx, String packageName, String title, String text, long postedAt) {
        JSONArray queue = readArray(ctx, KEY_QUEUE);
        String id = "c_" + postedAt + "_" + Integer.toHexString(text.hashCode() & 0xffff);
        try {
            JSONObject candidate = new JSONObject()
                .put("id", id)
                .put("packageName", packageName == null ? JSONObject.NULL : packageName)
                .put("title", title == null || title.isEmpty() ? JSONObject.NULL : title)
                .put("text", text)
                .put("postedAt", postedAt);
            queue.put(candidate);
        } catch (JSONException ignored) {
            return id;
        }
        while (queue.length() > MAX_QUEUE) {
            queue.remove(0);
        }
        prefs(ctx).edit().putString(KEY_QUEUE, queue.toString()).apply();
        return id;
    }

    /** Removes and returns the candidate with this id, or null. */
    public static synchronized JSONObject take(Context ctx, String id) {
        if (id == null) return null;
        JSONArray queue = readArray(ctx, KEY_QUEUE);
        JSONArray kept = new JSONArray();
        JSONObject found = null;
        for (int i = 0; i < queue.length(); i++) {
            JSONObject c = queue.optJSONObject(i);
            if (c == null) continue;
            if (found == null && id.equals(c.optString("id"))) {
                found = c;
            } else {
                kept.put(c);
            }
        }
        prefs(ctx).edit().putString(KEY_QUEUE, kept.toString()).apply();
        return found;
    }

    public static synchronized void clear(Context ctx) {
        prefs(ctx).edit().remove(KEY_QUEUE).remove(KEY_RECENT).apply();
    }

    private static JSONArray readArray(Context ctx, String key) {
        String raw = prefs(ctx).getString(key, null);
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
