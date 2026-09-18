import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Glyph } from './Glyph';
import { InboxAction } from './InboxAction';
import { useT } from '../lib/i18n';
import { heroClass, type HeroAccent } from '../lib/material';

interface NavyHeroProps {
  children: ReactNode;
  /** The section's accent glow: the brand violet by default (Home, Loans,
   *  Settings, Analytics, Investments, Inbox…), gold on Kameti, `ai`
   *  (stronger violet) on Hisaab AI, blue on Groups, pink on Contacts. */
  accent?: HeroAccent;
  /** @deprecated The 1d hero always carries its accent glow; kept so existing
   *  call sites compile. `false` now simply means the default glow. */
  bloom?: boolean;
  className?: string;
}

// The 1d hero band at the top of every screen: a dark navy gradient with a
// radial glow in the section's accent. Dark in BOTH themes (the big white
// figures need a dark ground), so everything inside it — header buttons,
// segmented tabs, numerals, glyphs — renders with the dark material.
//
// Compose with a sibling `.sukoon-body` / `.m-sheet`: the sheet pulls up 16px
// under the hero with a 24px top radius.
export function NavyHero({ children, accent = 'violet', className }: NavyHeroProps) {
  return (
    <header className={`${heroClass(accent)} pt-safe relative ${className ?? ''}`}>
      {children}
    </header>
  );
}

interface TopBarProps {
  title?: string;
  back?: boolean;
  action?: ReactNode;
  onBack?: () => void;
  tone?: 'on-navy' | 'on-cream';
  showInbox?: boolean;
}

// Top header row: 36px raised back button, 17px title, trailing actions and
// the Inbox bell. `.m-ctl` reads the material variables, so the same markup
// is dark on the hero and ivory/dark on a sheet.
export function TopBar({ title, back, action, onBack, tone = 'on-navy', showInbox = true }: TopBarProps) {
  const t = useT();
  const navigate = useNavigate();
  const handleBack = onBack ?? (() => navigate(-1));
  const isOnNavy = tone === 'on-navy';

  return (
    <div className="flex items-center gap-3 px-5 pt-1.5 pb-3 relative z-10">
      {back && (
        <button
          onClick={handleBack}
          className="m-ctl relative w-9 h-9 flex items-center justify-center shrink-0 before:absolute before:-inset-1 before:content-['']"
          aria-label={t('a11y_back')}
        >
          <Glyph name="arrow-left" size={16} className={isOnNavy ? 'text-white' : 'text-ink-800'} />
        </button>
      )}
      <h1
        className={`flex-1 min-w-0 text-[17px] font-semibold tracking-[-0.01em] truncate ${
          isOnNavy ? 'text-white' : 'text-ink-900'
        }`}
      >
        {title}
      </h1>
      <div className="flex items-center gap-2 shrink-0">
        {action}
        {showInbox && <InboxAction tone={tone} />}
      </div>
    </div>
  );
}
