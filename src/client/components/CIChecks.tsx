import type { CICheck } from '../../shared/types';

// ---------------------------------------------------------------------------
// CI check status icon and color mapping
// ---------------------------------------------------------------------------

function getCheckIcon(conclusion: string | null, status: string): { icon: string; color: string } {
  if (conclusion === 'success') return { icon: '\u2713', color: '#3FB950' };  // green checkmark
  if (conclusion === 'failure') return { icon: '\u2715', color: '#F85149' };  // red X
  if (conclusion === 'cancelled') return { icon: '\u2015', color: '#8B949E' }; // grey dash
  // Pending / in-progress / queued
  if (status === 'in_progress' || status === 'queued' || status === 'pending') {
    return { icon: '\u25CB', color: '#D29922' };  // amber circle
  }
  return { icon: '\u25CB', color: '#8B949E' };  // grey circle for unknown
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CIChecksProps {
  checks: CICheck[];
}

export function CIChecks({ checks }: CIChecksProps) {
  if (checks.length === 0) {
    return (
      <p className="text-dark-muted text-sm">No CI checks available</p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {checks.map((check) => {
        const { icon, color } = getCheckIcon(check.conclusion, check.status);
        return (
          <li key={check.name} className="flex items-center gap-2 text-sm">
            <span
              className="font-bold text-base leading-none w-4 text-center shrink-0"
              style={{ color }}
            >
              {icon}
            </span>
            <span className="text-dark-text truncate">{check.name}</span>
          </li>
        );
      })}
    </ul>
  );
}
