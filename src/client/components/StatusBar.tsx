import { useFleet } from '../context/FleetContext';
import { useEffect, useState } from 'react';

export function StatusBar() {
  const { connected, lastEvent } = useFleet();
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

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
      {secondsAgo !== null && (
        <span className="ml-4">
          Last update: {secondsAgo}s ago
        </span>
      )}
    </footer>
  );
}
