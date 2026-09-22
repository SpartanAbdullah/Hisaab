import { useT } from '../lib/i18n';
import { TXN_TYPE_CAPSULE, capsuleToneClass, type TxnTypeKind } from '../lib/txnTypeCapsule';

/** The colour capsule naming a row's transaction type — Lent, Borrowed, Paid
 *  back … — from the reader's side (src/lib/txnTypeCapsule.ts). Always a word,
 *  never colour alone; `shrink-0` so a long name truncates, not the capsule. */
export function TypeCapsule({ kind, className = '' }: { kind: TxnTypeKind; className?: string }) {
  const t = useT();
  const { labelKey, tone } = TXN_TYPE_CAPSULE[kind];
  return (
    <span
      className={`m-chip ${capsuleToneClass(tone)} shrink-0 px-2 text-[10.5px] ${className}`}
      data-capsule={kind}
    >
      {t(labelKey)}
    </span>
  );
}
