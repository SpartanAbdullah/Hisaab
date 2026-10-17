package com.usehisaab.app.capture;

import java.util.regex.Pattern;

/**
 * Cheap native pre-filter for the notification listener: does this text look
 * like a money alert at all? It only decides whether to QUEUE a candidate and
 * post "Record this?"; the real parse (amount, direction, merchant, refusals)
 * happens in JS (src/lib/bankAlertParser.ts) when the user taps. Err towards
 * letting a borderline alert through — a wrong offer costs one dismiss, a
 * missed one costs the whole feature — but never queue secrets.
 */
final class AlertHeuristics {

    private AlertHeuristics() {}

    // A currency token next to a number, either order.
    private static final Pattern MONEY = Pattern.compile(
        "(?i)(?:\\b(?:AED|Dhs?\\.?|PKR|Rs\\.?|SAR|SR\\.?|QAR|USD|GBP|EUR|INR)\\s?\\d|\\d\\s?(?:AED|Dhs?|PKR|Rs|SAR|SR|QAR|USD|GBP|EUR|INR)\\b|[$£€₹₨]\\s?\\d)");

    private static final Pattern VERB = Pattern.compile(
        "(?i)\\b(?:debit(?:ed)?|credit(?:ed)?|spent|purchase[ds]?|paid|payment|withdraw(?:n|al)?|transfer(?:red)?|received|deposit(?:ed)?|refund(?:ed)?|salary|pos|txn|transaction|charged)\\b");

    // Secrets never reach the queue, even for one tap.
    private static final Pattern SECRET = Pattern.compile(
        "(?i)\\b(?:otp|one[- ]time (?:password|pin|code)|verification code|passcode|security code)\\b");

    static boolean looksLikeMoneyAlert(String text) {
        if (text == null || text.length() < 8) return false;
        if (SECRET.matcher(text).find()) return false;
        return MONEY.matcher(text).find() && VERB.matcher(text).find();
    }
}
