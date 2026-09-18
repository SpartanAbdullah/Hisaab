import { useT } from '../lib/i18n';
import { Glyph } from './Glyph';

interface Props {
  /** Day-of-month strings (1..31), controlled by the parent form. */
  statementDay: string;
  dueDay: string;
  onStatementDay: (v: string) => void;
  onDueDay: (v: string) => void;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}

// The credit-card billing cycle, made legible: a real card CLOSES its
// statement on one day, then gives you ~3 weeks to pay by another. Asking for
// both (instead of one vague "due day") is what lets Hisaab remind you at the
// right time and put each purchase on the right statement. The little timeline
// makes the relationship obvious at a glance.
export function StatementCycleField({ statementDay, dueDay, onStatementDay, onDueDay }: Props) {
  const t = useT();
  const sd = parseInt(statementDay, 10);
  const dd = parseInt(dueDay, 10);
  const validSd = Number.isFinite(sd) && sd >= 1 && sd <= 31;
  const validDd = Number.isFinite(dd) && dd >= 1 && dd <= 31;
  // Only a DISTINCT statement day forms a cycle worth drawing — equal days
  // mean a single-date card (matches every downstream consumer), so no
  // timeline. Days from close to due, due rolling to next month if it's
  // on/before close; clamped so an end-of-month wrap never reads "0 days".
  const bothSet = validSd && validDd && sd !== dd;
  const daysToPay = bothSet ? (dd > sd ? dd - sd : Math.max(1, dd + 30 - sd)) : null;

  const clampDay = (raw: string): string => {
    const digits = raw.replace(/\D/g, '').slice(0, 2);
    if (digits === '') return '';
    const n = Math.min(31, Math.max(1, parseInt(digits, 10)));
    return String(n);
  };

  // Two labelled field cards (caption + bare 22px day input) under a short
  // explainer; when both days are set, a violet→coral timeline shows the gap.
  // The inputs carry an inline font-size: index.css pins every <input> to
  // 16px (iOS zoom guard), which beats any text-* utility.
  return (
    <div className="m-card p-4">
      <p className="form-label mb-1">{t('cc_cycle_title')}</p>
      <p className="text-[11.5px] text-ink-600 leading-relaxed mb-3">{t('cc_cycle_sub')}</p>

      <div className="grid grid-cols-2 gap-2.5">
        {/* Statement closes */}
        <label className="m-field px-3 py-2.5 cursor-text">
          <span className="flex items-center gap-1.5 mb-1">
            <Glyph name="document" size={14} tone="violet" />
            <span className="text-[11px] font-semibold text-ink-700 leading-tight">{t('cc_cycle_close')}</span>
          </span>
          <input
            type="number" inputMode="numeric" min="1" max="31"
            value={statementDay}
            onChange={(e) => onStatementDay(clampDay(e.target.value))}
            placeholder="—"
            aria-label={t('cc_cycle_close')}
            className="w-full text-center font-semibold text-ink-900 tabular-nums bg-transparent outline-none"
            style={{ fontSize: 22 }}
          />
        </label>

        {/* Payment due */}
        <label className="m-field px-3 py-2.5 cursor-text">
          <span className="flex items-center gap-1.5 mb-1">
            <Glyph name="bell" size={14} tone="coral" />
            <span className="text-[11px] font-semibold text-ink-700 leading-tight">{t('cc_cycle_due')}</span>
          </span>
          <input
            type="number" inputMode="numeric" min="1" max="31"
            value={dueDay}
            onChange={(e) => onDueDay(clampDay(e.target.value))}
            placeholder="—"
            aria-label={t('cc_cycle_due')}
            className="w-full text-center font-semibold text-ink-900 tabular-nums bg-transparent outline-none"
            style={{ fontSize: 22 }}
          />
        </label>
      </div>

      {/* Live timeline — closes ●━━ ~N days ━━● due */}
      {bothSet && daysToPay !== null && (
        <div className="mt-3.5 animate-fade-in">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-accent-500 shrink-0 ring-2 ring-accent-100" />
            <span className="flex-1 h-[2px] bg-gradient-to-r from-accent-500 to-pay-600 rounded-full" />
            <span className="m-chip m-chip-neutral shrink-0 tabular-nums">
              {(daysToPay === 1 ? t('cc_cycle_gap_one') : t('cc_cycle_gap')).replace('{n}', String(daysToPay))}
            </span>
            <span className="flex-1 h-[2px] bg-pay-600 rounded-full" />
            <span className="w-2.5 h-2.5 rounded-full bg-pay-600 shrink-0 ring-2 ring-pay-100" />
          </div>
          <div className="flex justify-between mt-1.5 text-[10.5px] font-medium text-ink-500 tabular-nums">
            <span>{t('cc_cycle_closes_on').replace('{d}', `${sd}${ordinal(sd)}`)}</span>
            <span>{t('cc_cycle_due_on').replace('{d}', `${dd}${ordinal(dd)}`)}</span>
          </div>
          <div className="m-card m-mint mt-3 flex items-start gap-2 px-3 py-2.5">
            <Glyph name="sparkle" size={13} tone="green" className="mt-0.5" />
            <p className="text-[11px] text-receive-text leading-relaxed">
              {t('cc_cycle_reassure').replace('{d}', `${dd}${ordinal(dd)}`)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
