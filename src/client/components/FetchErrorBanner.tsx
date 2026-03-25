import { useTeams } from '../context/FleetContext';

export function FetchErrorBanner() {
  const { fetchError } = useTeams();
  if (!fetchError) return null;
  return (
    <div
      role="alert"
      style={{ backgroundColor: '#3B2607', borderBottom: '1px solid #6B4C1E', color: '#F0C674', padding: '6px 16px', fontSize: '0.75rem' }}
      className="flex items-center gap-2 shrink-0"
    >
      <span style={{ color: '#F0C674' }}>&#9888;</span>
      <span>Data may be stale — {fetchError}</span>
    </div>
  );
}
