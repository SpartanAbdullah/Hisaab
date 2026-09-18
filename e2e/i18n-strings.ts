// Copy-typed literal values from src/lib/i18n.ts, keyed by the same i18n key
// name so a `grep <key>: { ur:` in that file finds the source of truth here
// too. These CANNOT be imported live: src/lib/i18n.ts's `useI18nStore` calls
// `readStoredLang()` — which reads `localStorage` — at module-evaluation time
// (`create<I18nState>((set) => ({ lang: readStoredLang(), ... }))`), and
// Playwright's test files run in Node, where `localStorage` does not exist.
// Importing the module at all would throw before a single test ran.
//
// If a referenced string changes in src/lib/i18n.ts, the matching spec here
// will start failing on a text-based selector — that's the intended signal to
// update this file, not a flake to retry.
export const I18N = {
  // AuthPage — src/lib/i18n.ts
  auth_cta_login: { ur: 'Mujhe log in karao', en: 'Log me in' }, // line 1600
  auth_label_email: { ur: 'Email', en: 'Email' }, // line 1611

  // QuickEntry — src/lib/i18n.ts
  intent_spend: { ur: 'Paisay Kharch Kiye', en: 'Spend Money' }, // line 51
  intent_person: { ur: 'Kisi Ke Sath Paisay', en: 'Money With Someone' }, // line 57
  person_gave: { ur: 'Maine Paisay Diye', en: 'I gave money' }, // line 62
  quick_who: { ur: 'Kisko?', en: 'To Whom?' }, // line 107
  quick_who_placeholder: { ur: 'Naam likho — e.g. Ahmed Bhai', en: 'Enter name — e.g. Ahmed' }, // line 108
  quick_from: { ur: 'Kis account say?', en: 'From Where?' }, // line 105
  quick_note: { ur: 'Note (Optional)', en: 'Note (Optional)' }, // line 142
  quick_next: { ur: 'Aagay', en: 'Next' }, // line 101
  quick_save: { ur: 'Save Karo', en: 'Save' }, // line 143
  qe_title_what_happened: { ur: 'Kya hua?', en: 'What happened?' }, // line 116
  tx_deleted: { ur: 'Entry delete ho gayi', en: 'Entry deleted' }, // line 934
  tx_delete_entry: { ur: 'Entry delete karo', en: 'Delete entry' }, // line 3405
  done_btn: { ur: 'Theek Hai — Done!', en: 'OK — Done!' }, // line 857

  // Loans — src/lib/i18n.ts
  loan_delete: { ur: 'Loan delete karein', en: 'Delete loan' }, // line 283
  loan_delete_cta: { ur: 'Delete karo', en: 'Delete loan' }, // line 289

  // Connect-by-code / contacts — src/lib/i18n.ts
  addc_cta_linked: { ur: 'Add karein aur connect karein', en: 'Add & connect' }, // line 2263
  connect_my_code: { ur: 'Aap ka connect code', en: 'Your connect code' }, // line 2231
  mcc_hsb_tag: { ur: 'HSB', en: 'HSB' }, // line 4046
  cbc_on_hisaab: { ur: 'Hisaab par', en: 'on Hisaab' }, // line 4269
  cbc_already_contact: { ur: 'Pehle se aap ke contacts mein: {name}', en: 'Already in your contacts as {name}' }, // line 4270

  // Cross-user linked loan request — src/lib/i18n.ts
  ltr_branch_cta: { ur: 'Confirmation ke liye bhejo', en: 'Send for confirmation' }, // line 1990
  confirm_send_cta: { ur: 'Request bhejo', en: 'Send request' }, // line 2746
  ltr_sent_title: { ur: 'Confirmation ke liye bhej diya', en: 'Sent for confirmation' }, // line 2020

  // Onboarding — src/lib/i18n.ts
  onboard_start: { ur: 'Shuru Karein', en: 'Get Started' }, // line 1753
  onboard_next: { ur: 'Aagay Chalein', en: 'Continue' }, // line 1770
  onboard_intent_skip: { ur: 'Sab kuch dekhna hai', en: 'A bit of everything' }, // line 571
  onboard_safety_btn: { ur: 'Samajh Gaya, Aage Chalein', en: 'Got it, Continue' }, // line 1816
  quiz_skip: { ur: "Skip — main khud chun lunga", en: "Skip — I'll choose myself" }, // line 3218
  mode_splits_title: { ur: 'Splits Only', en: 'Splits Only' }, // line 1105
  onboard_fresh_title: { ur: 'Fresh Start Karo', en: 'Start Fresh' }, // line 1842
  nav_activity: { ur: 'Activity', en: 'Activity' }, // line 38
  nav_loans: { ur: 'Qarz', en: 'Loans' }, // line 36
  a11y_quick_entry: { ur: 'Jaldi entry', en: 'Quick entry' }, // line 4024
  a11y_create_group: { ur: 'Group banayein', en: 'Create group' }, // line 4541
  cts_a11y_add: { ur: 'Contact add karein', en: 'Add contact' }, // line 4348

  // Settings — PIN — src/lib/i18n.ts
  settings_set_pin: { ur: 'PIN Set Karo', en: 'Set PIN' }, // line 1460
  settings_remove_pin: { ur: 'PIN Hatao', en: 'Remove PIN' }, // line 1462
  pin_set_title: { ur: 'Naya PIN Set Karo', en: 'Set New PIN' }, // line 1504
  pin_confirm: { ur: 'PIN Dobara Daalo', en: 'Confirm PIN' }, // line 1505
  pin_set_success: { ur: 'PIN set ho gaya!', en: 'PIN set successfully!' }, // line 1507
  pin_removed: { ur: 'PIN hata diya', en: 'PIN removed' }, // line 1508
  pin_title: { ur: 'PIN Daalo', en: 'Enter PIN' }, // line 1500
  pin_remove_confirm_cta: { ur: 'PIN band karein', en: 'Turn off PIN' }, // line 946
  set_pin_save: { ur: 'Save', en: 'Save' }, // line 4419
} as const;

export type I18nStringKey = keyof typeof I18N;

/** Both language variants of a key, for a `.or()` locator across languages. */
export function bothLangs(key: I18nStringKey): [string, string] {
  return [I18N[key].ur, I18N[key].en];
}
