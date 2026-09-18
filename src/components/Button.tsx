import { Loader2 } from 'lucide-react';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT_CLASSES;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  /**
   * @deprecated Every solid variant is extruded in the 1d material now (hard
   * walls + press-collapse, index.css "1D MATERIAL"), so this is a no-op kept
   * so existing call sites compile.
   */
  depth?: boolean;
  children: React.ReactNode;
}

// 1d button variants. Solid variants are built from the material classes —
// gradient face, lit edge, hard walls that collapse on press — so the press
// feedback lives in CSS, not in a scale utility.
//   primary / gradient → brand violet (the primary action; white label)
//   hero               → the same brand violet (AI, investments)
//   secondary          → neutral key material
//   danger             → solid coral (destructive confirms must read as the
//                        loud choice — ConfirmDestructiveSheet.test pins it)
//   warning            → gold-tinted key (amber, but quieter than primary)
//   ghost              → text-only accent
// eslint-disable-next-line react-refresh/only-export-components
export const BUTTON_VARIANT_CLASSES = {
  primary: 'm-btn m-btn-primary',
  secondary: 'm-btn m-btn-plain',
  danger: 'm-btn m-btn-coral',
  warning: 'm-btn m-key m-gold',
  ghost: 'm-btn bg-transparent text-accent-600 active:bg-accent-50',
  hero: 'm-btn m-btn-violet',
  gradient: 'm-btn m-btn-primary',
};

const sizes = {
  sm: 'min-h-[36px] px-3.5 py-2 text-xs rounded-xl gap-1.5',
  md: 'px-5 py-3 text-sm gap-2',
  lg: 'px-5 py-4 text-sm gap-2 w-full justify-center',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  children,
  disabled,
  depth: _depth,
  className = '',
  ...props
}: Props) {
  void _depth;
  const classes = [
    'tracking-tight',
    // ring-offset colour follows the sheet surface so the violet focus ring
    // never draws a white halo in dark mode (§7).
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-bg',
    BUTTON_VARIANT_CLASSES[variant],
    sizes[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...props} disabled={disabled || loading} className={classes}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
