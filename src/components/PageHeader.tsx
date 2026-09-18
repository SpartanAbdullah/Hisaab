import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../lib/i18n';
import { InboxAction } from './InboxAction';
import { Glyph } from './Glyph';

interface Props {
  title: string;
  back?: boolean;
  action?: ReactNode;
  showInbox?: boolean;
}

export function PageHeader({ title, back, action, showInbox = true }: Props) {
  const navigate = useNavigate();
  const t = useT();
  return (
    <header
      className="sticky top-0 border-b border-cream-hairline px-5 pt-safe pb-3.5 flex items-center justify-between z-40"
      style={{
        // Theme-aware surface (see --header-surface in index.css, mirrors
        // BottomNav's --nav-surface): a plain inline rgba() can't flip in
        // dark mode since inline styles always beat any stylesheet rule,
        // including html.dark (audit finding #3, 09-ui-quality.md §8).
        background: 'var(--header-surface)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        {back && (
          <button
            onClick={() => navigate(-1)}
            className="nav-icon-button -ml-1 shrink-0"
            aria-label={t('back')}
          >
            <Glyph name="arrow-left" size={16} className="text-ink-800" />
          </button>
        )}
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink-900 truncate min-w-0">{title}</h1>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {action}
        {showInbox && <InboxAction tone="on-cream" />}
      </div>
    </header>
  );
}
