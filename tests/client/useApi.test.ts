// =============================================================================
// Fleet Commander — useApi Hook Tests
// =============================================================================
// Tests for the useApi hook and ApiError class: REST method wrappers, URL
// prefixing, body serialization, and error handling.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useApi, ApiError } from '../../src/client/hooks/useApi';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => ({} as Response),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

function errorResponse(
  status: number,
  statusText: string,
  body?: unknown,
): Response {
  const resp = jsonResponse(body ?? {}, status, statusText);
  Object.defineProperty(resp, 'ok', { value: false });
  if (body === undefined) {
    // Simulate unparseable body
    Object.defineProperty(resp, 'json', {
      value: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiError', () => {
  it('should set name to ApiError', () => {
    const err = new ApiError(404, 'Not Found', 'Team not found');
    expect(err.name).toBe('ApiError');
  });

  it('should set status and statusText', () => {
    const err = new ApiError(500, 'Internal Server Error');
    expect(err.status).toBe(500);
    expect(err.statusText).toBe('Internal Server Error');
  });

  it('should use provided message', () => {
    const err = new ApiError(400, 'Bad Request', 'Invalid team ID');
    expect(err.message).toBe('Invalid team ID');
  });

  it('should generate default message when none provided', () => {
    const err = new ApiError(403, 'Forbidden');
    expect(err.message).toBe('API error: 403 Forbidden');
  });

  it('should be an instance of Error', () => {
    const err = new ApiError(500, 'Internal Server Error');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('useApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET', () => {
    it('should prefix /api/ to the path', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = renderHook(() => useApi());

      await result.current.get('teams');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/teams',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should strip leading slash before prefixing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]));
      const { result } = renderHook(() => useApi());

      await result.current.get('/projects');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return parsed JSON response', async () => {
      const body = [{ id: 1, name: 'alpha' }];
      mockFetch.mockResolvedValueOnce(jsonResponse(body));
      const { result } = renderHook(() => useApi());

      const data = await result.current.get('projects');

      expect(data).toEqual(body);
    });

    it('should not send a body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const { result } = renderHook(() => useApi());

      await result.current.get('system/health');

      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.body).toBeUndefined();
    });
  });

  describe('POST', () => {
    it('should send JSON body with Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
      const { result } = renderHook(() => useApi());

      await result.current.post('teams', { issueNumber: 42 });

      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.method).toBe('POST');
      expect((callInit.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
      expect(callInit.body).toBe(JSON.stringify({ issueNumber: 42 }));
    });

    it('should send {} as body when no body is provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = renderHook(() => useApi());

      await result.current.post('teams/1/stop');

      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.body).toBe('{}');
      expect((callInit.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
    });
  });

  describe('PUT', () => {
    it('should send JSON body with Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = renderHook(() => useApi());

      await result.current.put('projects/1', { maxTeams: 5 });

      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.method).toBe('PUT');
      expect(callInit.body).toBe(JSON.stringify({ maxTeams: 5 }));
    });

    it('should send {} as body when no body is provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = renderHook(() => useApi());

      await result.current.put('projects/1');

      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.body).toBe('{}');
    });
  });

  describe('DELETE', () => {
    it('should send DELETE request without body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      const { result } = renderHook(() => useApi());

      await result.current.del('projects/1');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/projects/1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
      expect(callInit.body).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw ApiError with parsed message on error response', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(404, 'Not Found', { message: 'Team not found' }),
      );
      const { result } = renderHook(() => useApi());

      await expect(result.current.get('teams/999')).rejects.toThrow(ApiError);

      try {
        mockFetch.mockResolvedValueOnce(
          errorResponse(404, 'Not Found', { message: 'Team not found' }),
        );
        await result.current.get('teams/999');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.statusText).toBe('Not Found');
        expect(apiErr.message).toBe('Team not found');
      }
    });

    it('should throw ApiError with error field when message is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, 'Bad Request', { error: 'Validation failed' }),
      );
      const { result } = renderHook(() => useApi());

      try {
        await result.current.post('teams', { bad: true });
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toBe('Validation failed');
      }
    });

    it('should throw ApiError even when response body is unparseable', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));
      const { result } = renderHook(() => useApi());

      await expect(result.current.get('system/health')).rejects.toThrow(ApiError);

      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'));
      try {
        await result.current.get('system/health');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.statusText).toBe('Internal Server Error');
        // Should have default message since body parse failed
        expect(apiErr.message).toBe('API error: 500 Internal Server Error');
      }
    });
  });
});
