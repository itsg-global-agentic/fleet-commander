import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from './useApi';
import type { TeamDetail as TeamDetailType, TeamTransition, TeamMember, MessageEdge, SpawnRecord } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

interface UseTeamDetailDataResult {
  detail: TeamDetailType | null;
  transitions: TeamTransition[];
  roster: TeamMember[];
  messageEdges: MessageEdge[];
  spawnRecords: SpawnRecord[];
  loading: boolean;
  error: string | null;
  refreshDetail: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache TTL for non-critical data (roster, transitions, message edges) */
const CACHE_TTL = 5_000;

/** Debounce delay for SSE-triggered refreshes */
const SSE_DEBOUNCE_MS = 2_000;

/** Periodic refresh interval used to recover from SSE-debounce reset loops on active teams */
const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Custom hook that encapsulates all data fetching for the TeamDetail panel.
 *
 * On team selection, fires all 4 fetches in parallel via Promise.allSettled:
 * - teams/{id} (required — failure sets error state)
 * - teams/{id}/transitions (non-critical)
 * - teams/{id}/roster (non-critical)
 * - teams/{id}/messages/summary (non-critical)
 *
 * On SSE events for the selected team, only re-fetches the detail endpoint
 * (debounced at 2s). Roster, transitions, and message edges are only
 * re-fetched if their cache is stale (> 5s).
 *
 * A periodic 5s interval also calls `refreshDetail()` while a team is
 * selected. This guarantees that roster and message edges populate even when
 * the SSE-driven debounce keeps getting reset by continuous events on a
 * highly-active team.
 */
export function useTeamDetailData(
  selectedTeamId: number | null,
  lastEvent: Date | null,
  lastEventTeamId: number | null,
): UseTeamDetailDataResult {
  const api = useApi();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [detail, setDetail] = useState<TeamDetailType | null>(null);
  const [transitions, setTransitions] = useState<TeamTransition[]>([]);
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [messageEdges, setMessageEdges] = useState<MessageEdge[]>([]);
  const [spawnRecords, setSpawnRecords] = useState<SpawnRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  const selectedTeamIdRef = useRef(selectedTeamId);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionsCacheRef = useRef<CacheEntry<TeamTransition[]> | null>(null);
  const rosterCacheRef = useRef<CacheEntry<TeamMember[]> | null>(null);
  const edgesCacheRef = useRef<CacheEntry<MessageEdge[]> | null>(null);
  const spawnRecordsCacheRef = useRef<CacheEntry<SpawnRecord[]> | null>(null);

  // Keep ref in sync for use in async callbacks
  useEffect(() => {
    selectedTeamIdRef.current = selectedTeamId;
  }, [selectedTeamId]);

  // ---------------------------------------------------------------------------
  // Primary fetch — fires all 4 calls in parallel on team selection
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedTeamId == null) {
      setDetail(null);
      setTransitions([]);
      setRoster([]);
      setMessageEdges([]);
      setSpawnRecords([]);
      transitionsCacheRef.current = null;
      rosterCacheRef.current = null;
      edgesCacheRef.current = null;
      spawnRecordsCacheRef.current = null;
      return;
    }

    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);

      const [detailResult, transResult, rosterResult, edgesResult, spawnsResult] =
        await Promise.allSettled([
          api.get<TeamDetailType>(`teams/${selectedTeamId}`),
          api.get<TeamTransition[]>(`teams/${selectedTeamId}/transitions`),
          api.get<TeamMember[]>(`teams/${selectedTeamId}/roster`),
          api.get<MessageEdge[]>(`teams/${selectedTeamId}/messages/summary`),
          api.get<SpawnRecord[]>(`teams/${selectedTeamId}/spawns`),
        ]);

      if (cancelled) return;

      // Detail is required — if it fails, set error state
      if (detailResult.status === 'fulfilled') {
        setDetail(detailResult.value);
      } else {
        const err = detailResult.reason;
        setError(err instanceof Error ? err.message : 'Failed to load team detail');
        setDetail(null);
      }

      // Transitions — non-critical
      if (transResult.status === 'fulfilled') {
        setTransitions(transResult.value);
        transitionsCacheRef.current = { data: transResult.value, fetchedAt: Date.now() };
      } else {
        setTransitions([]);
      }

      // Roster — non-critical
      if (rosterResult.status === 'fulfilled') {
        setRoster(rosterResult.value);
        rosterCacheRef.current = { data: rosterResult.value, fetchedAt: Date.now() };
      } else {
        setRoster([]);
      }

      // Message edges — non-critical
      if (edgesResult.status === 'fulfilled') {
        setMessageEdges(edgesResult.value);
        edgesCacheRef.current = { data: edgesResult.value, fetchedAt: Date.now() };
      } else {
        setMessageEdges([]);
      }

      // Spawn records (Issue #713) — non-critical. Defensive: only accept
      // an array; some test mocks return the same detail object for every
      // endpoint, and a non-array value would break downstream `for...of`.
      if (spawnsResult.status === 'fulfilled' && Array.isArray(spawnsResult.value)) {
        setSpawnRecords(spawnsResult.value);
        spawnRecordsCacheRef.current = { data: spawnsResult.value, fetchedAt: Date.now() };
      } else {
        setSpawnRecords([]);
      }

      setLoading(false);
    }

    fetchAll();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, api]);

  // ---------------------------------------------------------------------------
  // refreshDetail — re-fetches detail, plus stale caches in parallel
  // ---------------------------------------------------------------------------
  const refreshDetail = useCallback(() => {
    const teamId = selectedTeamIdRef.current;
    if (teamId == null) return;

    const now = Date.now();
    const staleCalls: Array<Promise<unknown>> = [];

    // Always fetch detail
    const detailPromise = api.get<TeamDetailType>(`teams/${teamId}`);
    staleCalls.push(detailPromise);

    // Check cache staleness for non-critical data
    const transStale = !transitionsCacheRef.current ||
      now - transitionsCacheRef.current.fetchedAt >= CACHE_TTL;
    const rosterStale = !rosterCacheRef.current ||
      now - rosterCacheRef.current.fetchedAt >= CACHE_TTL;
    const edgesStale = !edgesCacheRef.current ||
      now - edgesCacheRef.current.fetchedAt >= CACHE_TTL;
    const spawnsStale = !spawnRecordsCacheRef.current ||
      now - spawnRecordsCacheRef.current.fetchedAt >= CACHE_TTL;

    if (transStale) {
      staleCalls.push(api.get<TeamTransition[]>(`teams/${teamId}/transitions`));
    }
    if (rosterStale) {
      staleCalls.push(api.get<TeamMember[]>(`teams/${teamId}/roster`));
    }
    if (edgesStale) {
      staleCalls.push(api.get<MessageEdge[]>(`teams/${teamId}/messages/summary`));
    }
    if (spawnsStale) {
      staleCalls.push(api.get<SpawnRecord[]>(`teams/${teamId}/spawns`));
    }

    Promise.allSettled(staleCalls).then((results) => {
      if (selectedTeamIdRef.current !== teamId) return;

      let idx = 0;

      // Detail — always at index 0
      const detailResult = results[idx++];
      if (detailResult && detailResult.status === 'fulfilled') {
        setDetail(detailResult.value as TeamDetailType);
      }

      // Transitions
      if (transStale) {
        const r = results[idx++];
        if (r && r.status === 'fulfilled') {
          const data = r.value as TeamTransition[];
          setTransitions(data);
          transitionsCacheRef.current = { data, fetchedAt: Date.now() };
        }
      }

      // Roster
      if (rosterStale) {
        const r = results[idx++];
        if (r && r.status === 'fulfilled') {
          const data = r.value as TeamMember[];
          setRoster(data);
          rosterCacheRef.current = { data, fetchedAt: Date.now() };
        }
      }

      // Message edges
      if (edgesStale) {
        const r = results[idx++];
        if (r && r.status === 'fulfilled') {
          const data = r.value as MessageEdge[];
          setMessageEdges(data);
          edgesCacheRef.current = { data, fetchedAt: Date.now() };
        }
      }

      // Spawn records (Issue #713) — defensive array check (see primary fetch)
      if (spawnsStale) {
        const r = results[idx++];
        if (r && r.status === 'fulfilled' && Array.isArray(r.value)) {
          const data = r.value as SpawnRecord[];
          setSpawnRecords(data);
          spawnRecordsCacheRef.current = { data, fetchedAt: Date.now() };
        }
      }
    });
  }, [api]);

  // ---------------------------------------------------------------------------
  // SSE-driven update — debounced, detail-only (plus stale caches)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedTeamId == null || !lastEvent) return;

    // Skip when the SSE event is for a different team or non-team event
    if (lastEventTeamId !== selectedTeamId) return;

    // Clear any pending debounce timer
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = setTimeout(() => {
      refreshDetail();
    }, SSE_DEBOUNCE_MS);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [lastEvent, lastEventTeamId, selectedTeamId, refreshDetail]);

  // ---------------------------------------------------------------------------
  // Periodic refresh — guarantees roster/edges populate even when continuous
  // SSE events keep resetting the debounce timer above (active-team case).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedTeamId == null) return;

    const handle = setInterval(() => {
      refreshDetail();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(handle);
    };
  }, [selectedTeamId, refreshDetail]);

  return { detail, transitions, roster, messageEdges, spawnRecords, loading, error, refreshDetail };
}
