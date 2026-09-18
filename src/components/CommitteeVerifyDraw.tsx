import { useState } from 'react';
import { Glyph } from './Glyph';
import { useT } from '../lib/i18n';
import { verifyDraw } from '../lib/committeeDraw';
import type { Committee, CommitteeMember } from '../db';

interface Props {
  committee: Pick<Committee, 'payoutMethod' | 'drawSeed' | 'drawCommitment'>;
  members: CommitteeMember[];
}

// Provably-fair draw panel: publishes the seed and its seal, and recomputes the
// payout order from them so anyone — organiser, member, or a relative on the
// witness link with no account — can confirm the order wasn't rigged.
//
// Audit 2026-09 M10: the seed used to be generated on the organiser's phone,
// which made this panel a rubber stamp (re-roll until slot 1 is yours, then
// save the matching pair). The seed now comes from the server inside the same
// transaction that consumes it, so the recompute below is a real check. The
// seed is shown in full on purpose: verification you cannot reproduce by hand
// isn't verification. See src/lib/committeeDraw.ts for the exact scheme.
export function CommitteeVerifyDraw({ committee, members }: Props) {
  const t = useT();
  const [result, setResult] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  if (committee.payoutMethod !== 'ballot' || !committee.drawSeed || !committee.drawCommitment) return null;

  const verify = async () => {
    setChecking(true);
    try {
      const storedOrder = [...members].filter((m) => m.slot != null).sort((a, b) => (a.slot! - b.slot!)).map((m) => m.id);
      const ok = await verifyDraw(members.map((m) => m.id), committee.drawSeed!, committee.drawCommitment!, storedOrder);
      setResult(ok);
    } catch {
      setResult(false);
    } finally {
      setChecking(false);
    }
  };

  // 1d: a card with the shield-check row icon, the seed and seal in sunken
  // wells (they are records to read, not controls), and the check as a
  // neutral secondary — on the organiser's page the draw is the primary.
  return (
    <div className="m-card p-4">
      <div className="flex items-center gap-2.5">
        <div className="m-ctl w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0" aria-hidden="true">
          <Glyph name="shield-check" size={16} tone="green" />
        </div>
        <p className="text-[13.5px] font-semibold text-ink-900 leading-snug">{t('kameti_verify_title')}</p>
      </div>
      <p className="text-[11.5px] text-ink-600 mt-2.5 leading-relaxed">{t('kameti_verify_desc')}</p>
      <p className="text-[11.5px] text-ink-600 mt-1.5 leading-relaxed">{t('kameti_draw_server_note')}</p>
      <div className="m-inset mt-3 px-3 py-2.5">
        <p className="m-label">{t('kameti_draw_seed')}</p>
        <p className="text-[10.5px] font-mono text-ink-700 break-all leading-snug mt-1">{committee.drawSeed}</p>
      </div>
      <div className="m-inset mt-2 px-3 py-2.5">
        <p className="m-label">{t('kameti_commitment')}</p>
        <p className="text-[10.5px] font-mono text-ink-700 break-all leading-snug mt-1">{committee.drawCommitment.slice(0, 32)}…</p>
      </div>
      <p className="text-[10.5px] text-ink-400 mt-2 leading-relaxed">{t('kameti_draw_recompute_how')}</p>
      {result === null ? (
        <button onClick={verify} disabled={checking} className="m-btn m-btn-plain mt-3.5 w-full text-[12.5px]">
          <Glyph name="shield-check" size={15} tone="green" />
          {checking ? t('kameti_verifying') : t('kameti_verify')}
        </button>
      ) : result ? (
        <div className="mt-3.5 flex items-center gap-2 rounded-[12px] bg-receive-100 text-receive-text px-3 py-2.5">
          <Glyph name="check" size={15} strokeWidth={3} />
          <p className="text-[11.5px] font-semibold leading-snug">{t('kameti_verify_ok')}</p>
        </div>
      ) : (
        <div className="mt-3.5 flex items-center gap-2 rounded-[12px] bg-pay-100 text-pay-text px-3 py-2.5">
          <Glyph name="close" size={15} strokeWidth={3} />
          <p className="text-[11.5px] font-semibold leading-snug">{t('kameti_verify_fail')}</p>
        </div>
      )}
    </div>
  );
}
