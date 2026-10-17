package com.usehisaab.app.capture;

import android.content.Intent;
import android.net.Uri;

/**
 * "Share to Hisaab": an ACTION_SEND text intent from the system share sheet
 * (a bank email, SMS, WhatsApp message, anything the user selects and shares)
 * becomes the same kind of https deep link the launcher shortcuts and the
 * widget already use — https://usehisaab.com/?capture=<text> — so Capacitor's
 * App plugin hands it to JS unchanged (getLaunchUrl cold / appUrlOpen warm) and
 * App.tsx opens the CaptureSheet. No permission, no new plugin surface.
 */
public final class ShareIntentRewriter {

    /** Mirrors CAPTURE_TEXT_MAX in src/lib/captureOffer.ts. */
    private static final int MAX_CHARS = 4000;
    private static final String CAPTURE_URL = "https://usehisaab.com/?capture=";

    private ShareIntentRewriter() {}

    /** The rewritten VIEW intent, or null when this is not a text share. */
    public static Intent rewrite(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return null;

        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        StringBuilder sb = new StringBuilder();
        if (subject != null && subject.toString().trim().length() > 0) sb.append(subject.toString().trim()).append('\n');
        if (text != null) sb.append(text.toString().trim());
        String combined = sb.toString().trim();
        if (combined.isEmpty()) return null;
        if (combined.length() > MAX_CHARS) combined = combined.substring(0, MAX_CHARS);

        Intent out = new Intent(Intent.ACTION_VIEW, Uri.parse(CAPTURE_URL + Uri.encode(combined)));
        out.setComponent(intent.getComponent());
        return out;
    }
}
