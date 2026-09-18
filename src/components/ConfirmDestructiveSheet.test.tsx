import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmationActions } from './ConfirmDestructiveSheet';

function renderActions(props: Partial<Parameters<typeof ConfirmationActions>[0]> = {}) {
  return renderToStaticMarkup(
    <ConfirmationActions
      confirmLabel="Remove contact"
      onCancel={() => undefined}
      onConfirm={() => undefined}
      {...props}
    />,
  );
}

describe('ConfirmationActions', () => {
  it('renders a neutral cancel button and a visible destructive remove-contact button', () => {
    const html = renderActions();

    expect(html).toContain('Cancel');
    expect(html).toContain('Remove contact');
    expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('Remove contact'));
    // 1d: a solid coral face (m-btn-coral), not a tinted secondary — the
    // destructive choice stays the loud one.
    expect(html).toContain('m-btn-coral');
  });

  it('keeps leave-group warning confirmation visible with an explicit label', () => {
    const html = renderActions({ confirmLabel: 'Leave group', tone: 'warning' });

    expect(html).toContain('Leave group');
    // Amber-tinted key: visible, but quieter than a destructive confirm.
    expect(html).toContain('m-gold');
  });

  it('keeps delete-account destructive confirmation visible', () => {
    const html = renderActions({ confirmLabel: 'Delete account' });

    expect(html).toContain('Delete account');
    expect(html).toContain('m-btn-coral');
  });

  it('keeps the confirm action readable while loading and disabled', () => {
    const html = renderActions({ loading: true });

    expect(html).toContain('Remove contact...');
    expect(html).toContain('disabled=""');
    // .m-btn:disabled dims the face in index.css; the label stays legible.
    expect(html).toContain('m-btn');
  });
});
