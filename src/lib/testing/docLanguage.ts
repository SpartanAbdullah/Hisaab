// Test-only helpers for the one-language-per-document rule (founder,
// 2026-09-19): statement text + PDF, payment receipt, group settle-up plan and
// kameti slip must be written entirely in the app's current language — never
// an English sentence followed by its roman-Urdu repeat.
//
// Imported only by *.test.ts files (Vitest runs in Node); never by app code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tStatic, useI18nStore, type I18nKey, type Language } from '../i18n';

/** A translator pinned to `lang`. The store's language is restored after every
 *  lookup, so a test never leaks its language into the next one. setState, not
 *  setLang: setLang also persists and reschedules reminders. */
export function translatorFor(lang: Language): (key: I18nKey) => string {
  return (key) => {
    const prev = useI18nStore.getState().lang;
    useI18nStore.setState({ lang });
    try {
      return tStatic(key);
    } finally {
      useI18nStore.setState({ lang: prev });
    }
  };
}

/** Run `fn` with the app's language set to `lang` — for proving that a builder
 *  called WITHOUT a translator follows the live UI language. */
export function withAppLanguage<T>(lang: Language, fn: () => T): T {
  const prev = useI18nStore.getState().lang;
  useI18nStore.setState({ lang });
  try {
    return fn();
  } finally {
    useI18nStore.setState({ lang: prev });
  }
}

/** Every key of the statement family: the `2026-09-19 statements` block of
 *  i18n.ts plus the document titles reused from older blocks. Read from the
 *  source so a key added later is covered without touching the tests. */
export function statementFamilyKeys(): I18nKey[] {
  const src = readFileSync(resolve('src/lib/i18n.ts'), 'utf8');
  const start = src.indexOf('// ── 2026-09-19 statements ──');
  const end = src.indexOf('// ── 2026-09-19 statements END ──');
  if (start < 0 || end < start) throw new Error('statements block not found in i18n.ts');
  const keys = [...src.slice(start, end).matchAll(/^\s{2}(stmt_\w+):/gm)].map((m) => m[1] as I18nKey);
  return [...keys, 'soa_title', 'rcpt_title', 'kslip_title'];
}

/** Literal fragments of the family's copy in `lang` that never occur in the
 *  OTHER language's copy. Finding one in a document rendered in the other
 *  language means that document mixed languages. */
export function distinctiveFragments(lang: Language, keys: readonly I18nKey[] = statementFamilyKeys()): string[] {
  const own = translatorFor(lang);
  const other = translatorFor(lang === 'en' ? 'ur' : 'en');
  const otherAll = keys.map((k) => other(k)).join('\n');
  const out = new Set<string>();
  for (const key of keys) {
    for (const raw of own(key).split(/\{\w+\}/)) {
      const s = raw.trim();
      if (s.length >= 5 && /[A-Za-z]{3,}/.test(s) && !otherAll.includes(s)) out.add(s);
    }
  }
  return [...out];
}

const escapeForHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The fragments of `otherLang` copy present in `doc` (plain text or HTML).
 *  Empty ⇒ the document is purely in the other language. */
export function foreignFragmentsIn(doc: string, otherLang: Language): string[] {
  return distinctiveFragments(otherLang).filter((f) => doc.includes(f) || doc.includes(escapeForHtml(f)));
}
