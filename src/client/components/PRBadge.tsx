import { useState, useCallback } from 'react';
import { PRDetail } from './PRDetail';
import type { PRState, CIStatus } from '../../shared/types';

/** CI status icon and color map */
const CI_ICONS: Record<string, { icon: string; color: string }> = {
  passing: { icon: '\u2713', color: '#3FB950' },
  failing: { icon: '\u2715', color: '#F85149' },
  pending: { icon: '\u25CB', color: '#D29922' },
  none: { icon: '\u2014', color: '#8B949E' },
};

/** PR state color map for hover tooltip */
const STATE_COLORS: Record<string, string> = {
  open: '#3FB950',
  merged: '#A371F7',
  closed: '#8B949E',
  draft: '#8B949E',
};

interface PRBadgeProps {
  prNumber: number | null;
  ciStatus: CIStatus | null;
  teamId?: number;
  prState?: PRState | null;
}

export function PRBadge({ prNumber, ciStatus, teamId, prState }: PRBadgeProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (prNumber != null && teamId != null) {
        setPopoverOpen((prev) => !prev);
      }
    },
    [prNumber, teamId],
  );

  const handleClose = useCallback(() => {
    setPopoverOpen(false);
  }, []);

  if (prNumber == null) {
    return <span className="text-dark-muted text-sm">{'\u2014'}</span>;
  }

  const ci = CI_ICONS[ciStatus ?? 'none'] ?? CI_ICONS.none;
  const canExpand = teamId != null;
  const stateColor = STATE_COLORS[prState ?? ''] ?? '#8B949E';
  const stateLabel = prState ? prState.toUpperCase() : null;

  return (
    <span className="relative inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`inline-flex items-center gap-1.5 ${
          canExpand
            ? 'cursor-pointer hover:bg-dark-border/30 rounded px-1.5 py-0.5 -mx-1.5 -my-0.5 transition-colors'
            : ''
        }`}
        title={canExpand ? 'Click to view PR details' : undefined}
      >
        <span className="text-sm text-dark-accent">#{prNumber}</span>
        <span className="text-sm font-bold" style={{ color: ci.color }}>
          {ci.icon}
        </span>
      </button>

      {/* Mini tooltip showing PR state on hover */}
      {hovered && !popoverOpen && stateLabel && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 text-xs rounded whitespace-nowrap bg-[#1C2128] border border-dark-border shadow-lg pointer-events-none"
          style={{ color: stateColor }}
        >
          {stateLabel}
        </span>
      )}

      {/* PRDetail popover */}
      {popoverOpen && teamId != null && (
        <PRDetail prNumber={prNumber} teamId={teamId} onClose={handleClose} />
      )}
    </span>
  );
}
