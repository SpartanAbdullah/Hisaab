import { skeletonDelay } from '../lib/material';

interface Props {
  rows?: number;
  withAvatar?: boolean;
  withTrailing?: boolean;
}

// 1d loading list: rows inside one card, separated by hairlines — the same
// shape the loaded list will take, so nothing jumps when data lands. Blocks
// breathe (1.6s pulse, staggered 0.15s per row — .m-skel in index.css).
export function ListSkeleton({ rows = 3, withAvatar = true, withTrailing = true }: Props) {
  return (
    <div className="m-card overflow-hidden" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => {
        const delay = { '--m-skel-delay': skeletonDelay(i) } as React.CSSProperties;
        return (
          <div
            key={i}
            className={`flex items-center gap-3 p-4 ${i > 0 ? 'border-t border-cream-hairline' : ''}`}
          >
            {withAvatar && <div className="m-skel w-11 h-11 rounded-full shrink-0" style={delay} />}
            <div className="flex-1 min-w-0">
              <div className="m-skel h-[11px] w-[48%]" style={delay} />
              <div className="m-skel h-[9px] w-[30%] mt-2" style={delay} />
            </div>
            {withTrailing && <div className="m-skel h-[13px] w-[62px]" style={delay} />}
          </div>
        );
      })}
    </div>
  );
}
