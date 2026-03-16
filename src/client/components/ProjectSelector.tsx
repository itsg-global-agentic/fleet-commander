import { useState, useEffect, useCallback } from 'react';
import { useFleet } from '../context/FleetContext';
import { useApi } from '../hooks/useApi';
import type { ProjectSummary } from '../../shared/types';

export function ProjectSelector() {
  const { selectedProjectId, setSelectedProjectId } = useFleet();
  const api = useApi();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const fetchProjects = useCallback(async () => {
    try {
      const data = await api.get<ProjectSummary[]>('projects');
      setProjects(data);
    } catch {
      // ignore
    }
  }, [api]);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 15_000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  return (
    <select
      value={selectedProjectId ?? ''}
      onChange={(e) => {
        const val = e.target.value;
        setSelectedProjectId(val ? parseInt(val, 10) : null);
      }}
      className="px-2 py-1 text-xs rounded border border-dark-border bg-dark-base text-dark-text focus:outline-none focus:border-dark-accent focus:ring-1 focus:ring-dark-accent/30 max-w-[180px] truncate"
      title="Filter by project"
    >
      <option value="">All Projects</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
