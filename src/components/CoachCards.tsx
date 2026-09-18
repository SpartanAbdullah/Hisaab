import { useNavigate } from 'react-router-dom';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { Tile3D } from './Tile3D';
import { Glyph } from './Glyph';
import type { Tint } from '../lib/material';
import type { GlyphName } from '../lib/glyphs';
import type { CoachCard, CoachKind, CoachTone } from '../lib/coachInsights';

// A 3c glyph per insight kind, drawn in the tile's own accent. The meaning
// lives in the title; the glyph is decoration (Tile3D renders it aria-hidden).
// `phone` is the "go nudge them" cue for an overdue receivable, `store` the
// "here is where your money went" one, `clock` the lapsed-logging habit.
const KIND_ICON: Record<CoachKind, GlyphName> = {
  budget_over: 'wallet',
  overdue_receivable: 'phone',
  budget_pace: 'analytics',
  renewals_soon: 'calendar',
  goal_behind: 'savings',
  top_category: 'store',
  log_nudge: 'clock',
};

// Tone → tile tint (face + walls). Carrying the tone into the tint keeps the
// same signal ("this one is about money going out" / "this one is a
// warning") on a surface the user can read at a glance.
const TONE_TINT: Record<CoachTone, Tint> = {
  pay: 'coral',
  warn: 'gold',
  receive: 'mint',
  accent: 'accent',
  info: 'sky',
};

function copyFor(card: CoachCard, t: ReturnType<typeof useT>): { title: string; body: string } {
  const p = card.params;
  const money = (amt: unknown, cur: unknown) => formatMoney(Number(amt), String(cur));
  switch (card.kind) {
    case 'budget_over':
      return { title: t('coach_budget_over_t').replace('{category}', String(p.category)), body: t('coach_budget_over_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'overdue_receivable':
      return { title: t('coach_overdue_t'), body: t('coach_overdue_b').replace('{count}', String(p.count)) };
    case 'budget_pace':
      return { title: t('coach_pace_t').replace('{category}', String(p.category)), body: t('coach_pace_b').replace('{pct}', String(p.pct)).replace('{days}', String(p.daysLeft)) };
    case 'renewals_soon':
      return { title: t('coach_renew_t').replace('{count}', String(p.count)), body: t('coach_renew_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'goal_behind':
      return { title: t('coach_goal_t').replace('{title}', String(p.title)), body: t('coach_goal_b').replace('{amount}', money(p.amount, p.currency)) };
    case 'top_category':
      return { title: t('coach_top_t').replace('{category}', String(p.category)), body: t('coach_top_b').replace('{count}', String(p.count)).replace('{amount}', money(p.amount, p.currency)) };
    case 'log_nudge':
      return { title: t('coach_log_t').replace('{days}', String(p.days)), body: t('coach_log_b') };
  }
}

export function CoachCards({ cards }: { cards: CoachCard[] }) {
  const t = useT();
  const navigate = useNavigate();
  if (cards.length === 0) return null;

  return (
    <div>
      <h2 className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2.5 px-1 flex items-center gap-1.5">
        <Glyph name="sparkles" size={12} tone="violet" /> {t('coach_title')}
      </h2>
      {/* Tiles, not cards: every insight navigates, so each is a pressable
          tile whose wall + press replaces the chevron as the affordance. The
          glyph sits inside the tile now (no overhang), so a 10px gap keeps
          the tinted walls clear of the next tile. */}
      <div className="space-y-2.5">
        {cards.map((card) => {
          const { title, body } = copyFor(card, t);
          return (
            <Tile3D
              key={card.id}
              tint={TONE_TINT[card.tone]}
              icon={KIND_ICON[card.kind]}
              title={title}
              subtitle={body}
              onClick={() => navigate(card.href)}
            />
          );
        })}
      </div>
    </div>
  );
}
