import { useCallback, useMemo } from 'react';

interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    message?: string,
  ) {
    super(message ?? `API error: ${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `/api/${path.replace(/^\//, '')}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  } else if (method === 'POST' || method === 'PUT') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = '{}';
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    let message: string | undefined;
    try {
      const json = await response.json();
      message = json.message ?? json.error ?? undefined;
    } catch {
      // ignore parse failures
    }
    throw new ApiError(response.status, response.statusText, message);
  }

  return response.json() as Promise<T>;
}

/**
 * REST fetch wrapper that prefixes /api/ to paths and returns typed responses.
 */
export function useApi(): ApiClient {
  const get = useCallback(<T,>(path: string) => request<T>('GET', path), []);
  const post = useCallback(<T,>(path: string, body?: unknown) => request<T>('POST', path, body), []);
  const put = useCallback(<T,>(path: string, body?: unknown) => request<T>('PUT', path, body), []);
  const del = useCallback(<T,>(path: string) => request<T>('DELETE', path), []);

  return useMemo(() => ({ get, post, put, del }), [get, post, put, del]);
}
