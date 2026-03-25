import { useConnection, useTeams } from '../context/FleetContext';
import { useEffect, useState } from 'react';

export function StatusBar() {
  const { connected, lastEvent } = useConnection();
  const { fetchError } = useTeams();
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data.version) setVersion(data.version);
      })
      .catch(() => {
        // ignore — version display is non-critical
      });
  }, []);

  useEffect(() => {
    if (!lastEvent) {
      setSecondsAgo(null);
      return;
    }

    const update = () => {
      setSecondsAgo(Math.floor((Date.now() - lastEvent.getTime()) / 1000));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [lastEvent]);

  return (
    <footer className="h-6 min-h-[24px] bg-dark-base border-t border-dark-border flex items-center px-3 text-xs text-dark-muted select-none">
      <span
        className={`inline-block w-2 h-2 rounded-full mr-2 ${
          connected ? 'bg-green-500' : 'bg-red-500'
        }`}
      />
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
      {fetchError && (
        <span className="ml-3" style={{ color: '#F0C674' }}>
          Stale
        </span>
      )}
      {secondsAgo !== null && (
        <span className="ml-4">
          Last update: {secondsAgo}s ago
        </span>
      )}
      {version && (
        <span className="ml-auto">v{version}</span>
      )}
    </footer>
  );
}
