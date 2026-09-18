import { NavLink } from 'react-router-dom';
import { Glyph } from './Glyph';
import { useUIStore } from '../stores/uiStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useT } from '../lib/i18n';
import type { GlyphName } from '../lib/glyphs';

interface Props {
  onQuickEntry: () => void;
}

// 1d bottom nav: 4 tab slots + the centre brand FAB. Home far-left, then the
// FAB, then Hisaab AI and Groups on the right in BOTH modes. Only slot 2
// changes by mode:
//   full_tracker → Home · Loans · [+] · Hisaab AI · Groups
//   splits_only  → Home · Activity · [+] · Hisaab AI · Groups
// Inbox lives in the page chrome (the bell); Settings via the avatar tap.
//
// The handoff draws text-only tabs; each tab here carries its 3c glyph above
// the label (the founder's standing "icons dominant, labels small" rule), in
// the same white-active / muted-inactive colours. Hidden whenever a modal is
// open — which also covers Quick Entry and New Kameti (modalCount > 0).
export function BottomNav({ onQuickEntry }: Props) {
  const modalCount = useUIStore((s) => s.modalCount);
  const mode = useAppModeStore((s) => s.mode);
  const t = useT();

  if (modalCount > 0) return null;

  const isSplits = mode === 'splits_only';
  const leftPair: NavTabProps[] = [
    { to: '/', icon: 'home', label: t('nav_home') },
    isSplits
      ? { to: '/activity', icon: 'activity', label: t('nav_activity') }
      : { to: '/loans', icon: 'swap', label: t('nav_loans') },
  ];
  const rightTabs: NavTabProps[] = [
    { to: '/hisaab-ai', icon: 'sparkles', label: 'Hisaab AI' },
    { to: '/groups', icon: 'groups', label: t('nav_groups') },
  ];

  return (
    <nav
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] z-40"
      style={{
        // Theme-aware surface (--nav-surface in index.css): the handoff's dark
        // translucent gradient in dark, a near-opaque ivory in light.
        background: 'var(--nav-surface)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--nav-edge)',
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
      }}
    >
      <div className="grid grid-cols-5 items-center h-[62px]">
        {leftPair.map((link) => (
          <NavTab key={link.to} {...link} />
        ))}

        {/* Centre FAB — the + keeps its brand violet-to-navy colour: lit edge,
            one thin wall that collapses on press, violet glow. */}
        <div className="flex flex-col items-center justify-center">
          <button
            onClick={onQuickEntry}
            aria-label={t('a11y_quick_entry')}
            className="m-fab w-[52px] h-[52px] rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-bg"
            style={{ marginTop: -26 }}
          >
            <Glyph name="plus" size={24} strokeWidth={3} />
          </button>
          <span className="text-[10px] font-medium tracking-tight text-ink-500 mt-1" aria-hidden>
            {t('nav_add')}
          </span>
        </div>

        {rightTabs.map((link) => (
          <NavTab key={link.to} {...link} />
        ))}
      </div>
    </nav>
  );
}

interface NavTabProps {
  to: string;
  icon: GlyphName;
  label: string;
}

function NavTab({ to, icon, label }: NavTabProps) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className="flex flex-col items-center justify-center gap-1 h-full transition-opacity active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset rounded-xl"
    >
      {({ isActive }) => (
        <>
          <Glyph
            name={icon}
            size={21}
            strokeWidth={isActive ? 2.6 : 2.1}
            className={`${isActive ? 'text-ink-900' : 'text-ink-500'}${to === '/hisaab-ai' ? ' animate-sparkle' : ''}`}
          />
          <span
            className={`text-[10px] tracking-tight ${
              isActive ? 'text-ink-900 font-semibold' : 'text-ink-500 font-medium'
            }`}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}
