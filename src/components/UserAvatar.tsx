import { useT } from '../lib/i18n';

interface Props {
  name: string;
  size?: number;
  onClick?: () => void;
  /** The signed-in user: the 1d violet avatar (hero greeting, Settings). Everyone
   *  else wears the navy person avatar — one calm colour for all people, so a
   *  list reads as people rather than as a colour key. */
  self?: boolean;
}

// Letter-circle avatar in the 1d material (.m-avatar / .m-avatar-self in
// index.css): a lit gradient disc with an inset top highlight. Initials clear
// AA on both faces (white on navy, white on the brand violet).
export function UserAvatar({ name, size = 40, onClick, self = false }: Props) {
  const t = useT();
  const trimmed = name.trim();
  const letter = (trimmed[0] || 'U').toUpperCase();
  const fontSize = Math.round(size * 0.4);

  const className = `m-avatar ${self ? 'm-avatar-self' : ''} active:scale-95 transition-transform`;
  const style = { width: size, height: size, fontSize };

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2`}
        style={style}
        aria-label={t('a11y_profile')}
      >
        {letter}
      </button>
    );
  }
  return (
    <div className={className} style={style} aria-hidden>
      {letter}
    </div>
  );
}
