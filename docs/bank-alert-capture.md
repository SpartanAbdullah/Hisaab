# Bank-alert capture — share sheet + Android notification listener

Added 2026-10-17 (founder: "whenever user receives an email about the transaction, our app
records it, or offers to record it" — decision: **offers**, never records silently).

## What ships

| Route | How the text reaches Hisaab | Permission | Platforms |
|---|---|---|---|
| **Share to Hisaab** | User selects/shares a bank email, SMS, WhatsApp or app message → "Record in Hisaab" in the share sheet → `MainActivity` rewrites `ACTION_SEND` into `https://usehisaab.com/?capture=<text>` (`ShareIntentRewriter.java`) → `App.tsx` opens `CaptureSheet` | none | Android now; iOS later via a share extension |
| **Auto-capture** | `HisaabNotificationListener` (Notification access) sees a bank/wallet app's or mail app's notification, keeps it if it looks like a money alert (`AlertHeuristics`), queues it on-device (`CaptureStore`) and posts "Record this transaction?" → tap opens `/?capture_id=<id>` → `App.tsx` takes it from the queue → `CaptureSheet` | `BIND_NOTIFICATION_LISTENER_SERVICE` (user grants on Android's page) + the app's own notification permission | Android only |

Both end in the same place: `src/components/CaptureSheet.tsx` shows what the parser understood
and hands a prefilled preset to **Quick Entry**. Quick Entry remains the only place money is
written, with all its guards (both app modes, account currency, overpayment, undo).

## The parser (`src/lib/bankAlertParser.ts`, tested)

Keyword heuristics for English alerts from UAE / Pakistan / Gulf banks and wallets:
amount + currency (`AED`, `Dhs`, `Rs.`, `PKR`, `SAR`, `$`, any ISO code), direction
(debit/credit words; "credit card" is not a credit), merchant (`at X`, `to/from X`,
`Merchant: X`), card/account last-4, date (DD/MM order), balance-after.

Refuses (returns null): OTPs / verification codes, declined / failed / insufficient-funds,
future tense ("will be debited", "payment due", "minimum due"), balance-only messages.

`src/lib/captureOffer.ts` matches the account **conservatively**: last-4 must match exactly one
live account *in the same currency*; without digits, only an unambiguous single account in
that currency. Anything else → the user picks in Quick Entry. A wrong account moves money in
the wrong book silently, so ambiguity never guesses.

**Real samples are the next step.** The templates in `bankAlertParser.test.ts` are shapes, not
verbatim bank copy. Founder to supply ~10 alerts per bank (ENBD, Mashreq, CBD, Emirates
Islamic, RAK, Wio, HBL, Meezan, JazzCash, Easypaisa) with amounts redacted; each becomes a
test case and, where needed, a rule.

## Privacy and Play policy

- **Never SMS.** The listener excludes the default SMS app (`Telephony.Sms.getDefaultSmsPackage`)
  and a list of messaging apps by package, so a bank SMS is never read automatically; the user
  can still share one in by hand. This keeps Hisaab outside Play's READ_SMS / SMS-based money
  management declaration entirely (the September research in memory: founder declined SMS).
- **Prominent disclosure** before the OS page, every time the switch goes on
  (`SettingsPage` → `capture_disclosure_*`): what is read, what is excluded, nothing uploaded
  until Record, off any time. This is what Play's "Permissions and APIs that Access Sensitive
  Information" policy asks of Notification-access apps.
- **On-device only.** `CaptureStore` is private SharedPreferences, excluded from backup
  (`allowBackup=false`). Candidates are removed when taken, on sign-out
  (`teardownCapture()` in the auth store's device teardown), or after 20 newer ones.
- **The tray shows no money.** The offer notification carries no amount, merchant or bank —
  same rule as the home-screen widget (lock-screen visible).
- **Telemetry** (`capture_offered`, `capture_resolved`, `capture_listener_toggled`) never
  carries the text, amount or merchant.
- **Data Safety form:** no new *collected* data type — the raw alert never leaves the device,
  and a recorded transaction is already disclosed under *Financial info → Other financial info*
  as user-entered. `docs/play-store-data-safety.md` §1.2 "Messages → Emails / SMS" row now
  explains the on-device reading. Privacy policy (`PublicInfoPages.tsx`) has the matching bullet.

## Device checklist (founder, after the AAB rebuild)

1. Share a bank SMS from Messages → "Record in Hisaab" → sheet shows amount, direction, card
   match → Record → Quick Entry prefilled → save.
2. Settings → Auto-capture → disclosure → Continue → Android list → switch Hisaab on → back:
   the row reads ON (no reload).
3. Trigger a bank app / Gmail notification with a transaction → "Record this transaction?"
   appears (no amount in the tray) → tap → sheet. Tap the same notification again after
   recording → "That alert is no longer available."
4. Receive a bank SMS with auto-capture on → **no** offer (SMS excluded).
5. An OTP email → no offer. A declined-transaction alert → no offer.
6. Sign out → Settings shows the switch OFF for the next account; no stale offers.
7. Switch language → the offer notification's text follows on the next alert.
