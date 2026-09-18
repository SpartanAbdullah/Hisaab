interface Props {
  steps: string[];
  current: number;
}

// 1d step bar: sunken tracks (the material's --m-track well) that fill with
// violet as the flow advances — done steps solid violet, the active step a lit
// violet gradient plus its readable-violet label. accent-500 is the brand
// violet, which clears 3:1 against the track in BOTH themes.
export function StepIndicator({ steps, current }: Props) {
  return (
    <div className="flex items-center gap-2 px-1">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-1">
          <div
            className="relative flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--m-track)', boxShadow: 'inset 0 1px 1px var(--m-track-shade)' }}
          >
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out ${
                i < current ? 'w-full bg-accent-500' :
                i === current ? 'w-full bg-gradient-to-r from-accent-500 to-accent-600' :
                'w-0'
              }`}
            />
          </div>
          {i === current && (
            <span className="text-[10.5px] font-semibold text-accent-600 whitespace-nowrap animate-fade-in tracking-tight">
              {label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
