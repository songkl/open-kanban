import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, authApi, createApiRequest, setGlobalErrorHandler } from './api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
}));

describe('ApiError', () => {
  it('creates error with message and status', () => {
    const error = new ApiError('Not Found', 404);
    expect(error.message).toBe('Not Found');
    expect(error.status).toBe(404);
    expect(error.isNetworkError).toBe(false);
    expect(error.isAbortError).toBe(false);
    expect(error.name).toBe('ApiError');
  });

  it('creates network error', () => {
    const error = new ApiError('Network failed', undefined, true);
    expect(error.isNetworkError).toBe(true);
  });

  it('creates abort error', () => {
    const error = new ApiError('Request cancelled', undefined, false, true);
    expect(error.isAbortError).toBe(true);
  });

  it('combines flags correctly', () => {
    const error = new ApiError('Combined', 500, true, false);
    expect(error.status).toBe(500);
    expect(error.isNetworkError).toBe(true);
    expect(error.isAbortError).toBe(false);
  });
});

describe('API error handling', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('handles 401 unauthorized error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 401,
    });
  });

  it('handles 403 forbidden error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 403,
    });
  });

  it('handles 500 server error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 500,
    });
  });

  it('handles 502 bad gateway error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'Bad gateway' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 502,
    });
  });

  it('handles 503 service unavailable error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'Service unavailable' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 503,
    });
  });

  it('handles network timeout error', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 0,
    });

    await expect(request.promise).rejects.toMatchObject({
      isNetworkError: true,
    });
  });

  it('handles CORS error as network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 0,
    });

    await expect(request.promise).rejects.toMatchObject({
      isNetworkError: true,
    });
  });

  it('uses error message from response when available', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: 'Validation failed: title is required' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      message: 'Validation failed: title is required',
      status: 422,
    });
  });

  it('handles empty error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({}),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      status: 400,
    });
  });

  it('retries on 502 bad gateway when configured', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: 'Bad gateway' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '1' }),
      });

    const request = createApiRequest<{ id: string }>('/api/test', undefined, {
      retries: 1,
      retryDelay: 10,
      retryOn: () => true,
    });

    const result = await request.promise;
    expect(result).toEqual({ id: '1' });
  });
});

describe('createApiRequest', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns promise and abort function', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: '1', name: 'Test' }),
    });

    const request = createApiRequest<{ id: string; name: string }>('/api/test');
    expect(request.promise).toBeInstanceOf(Promise);
    expect(typeof request.abort).toBe('function');
  });

  it('resolves with data on success', async () => {
    const mockData = { id: '1', name: 'Test' };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const request = createApiRequest<typeof mockData>('/api/test');
    const result = await request.promise;
    expect(result).toEqual(mockData);
  });

  it('rejects with ApiError on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    const request = createApiRequest<unknown>('/api/test');

    await expect(request.promise).rejects.toMatchObject({
      message: 'Not found',
      status: 404,
    });
  });

  it('rejects with ApiError on network failure', async () => {
    mockFetch.mockRejectedValue(
      new ApiError('Network error', undefined, true)
    );

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 0,
    });

    await expect(request.promise).rejects.toMatchObject({
      isNetworkError: true,
    });
  });

  it('aborts request when abort is called', async () => {
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));

    const request = createApiRequest<unknown>('/api/test');
    request.abort();

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/test'),
      expect.objectContaining({
        signal: expect.objectContaining({ aborted: true }),
      })
    );
  });

  it('calls global error handler on error', async () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);

    mockFetch.mockRejectedValueOnce(new Error('Test error'));

    const request = createApiRequest<unknown>('/api/test');
    await request.promise.catch(() => {});

    expect(handler).toHaveBeenCalled();

    setGlobalErrorHandler(null);
  });
});

describe('retry behavior', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries on network error with default retries', async () => {
    const mockData = { id: '1' };
    mockFetch
      .mockRejectedValueOnce(new ApiError('Network error', undefined, true))
      .mockRejectedValueOnce(new ApiError('Network error', undefined, true))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

    const request = createApiRequest<typeof mockData>('/api/test', undefined, {
      retries: 2,
      retryDelay: 10,
    });

    const result = await request.promise;
    expect(result).toEqual(mockData);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fails after exhausting retries', async () => {
    mockFetch.mockRejectedValue(new ApiError('Network error', undefined, true));

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 2,
      retryDelay: 10,
    });

    await expect(request.promise).rejects.toMatchObject({
      isNetworkError: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry on abort error', async () => {
    mockFetch.mockRejectedValue(new ApiError('Request cancelled', undefined, false, true));

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 2,
    });

    await expect(request.promise).rejects.toMatchObject({
      isAbortError: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx errors', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad request' }),
      });

    const request = createApiRequest<unknown>('/api/test', undefined, {
      retries: 2,
    });

    await expect(request.promise).rejects.toMatchObject({
      status: 400,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when retryOn returns false', async () => {
    mockFetch
      .mockRejectedValueOnce(new ApiError('Network error', undefined, true))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '1' }),
      });

    const request = createApiRequest<{ id: string }>('/api/test', undefined, {
      retries: 3,
      retryOn: () => false,
    });

    await expect(request.promise).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx errors when configured', async () => {
    const mockData = { id: '1' };
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

    const request = createApiRequest<typeof mockData>('/api/test', undefined, {
      retries: 2,
      retryDelay: 10,
      retryOn: () => true,
    });

    const result = await request.promise;
    expect(result).toEqual(mockData);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('authApi.bulkSetPermissions', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockOkResponse = (data: unknown) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    });
  };

  const mockErrorResponse = (status: number, body: unknown) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      json: () => Promise.resolve(body),
    });
  };

  it('POSTs to auth/permissions/bulk with { boardId, userIds, access } as JSON body', async () => {
    mockOkResponse({
      success: true,
      boardId: 'board-1',
      granted: [
        { userId: 'user-1', access: 'READ' },
        { userId: 'user-2', access: 'READ' },
      ],
      count: 2,
    });

    await authApi.bulkSetPermissions('board-1', ['user-1', 'user-2'], 'READ');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('auth/permissions/bulk');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({
      boardId: 'board-1',
      userIds: ['user-1', 'user-2'],
      access: 'READ',
    });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns the parsed BoardBulkGrantResult on success', async () => {
    const payload = {
      success: true,
      boardId: 'board-7',
      granted: [
        { userId: 'u-1', access: 'WRITE' },
        { userId: 'u-2', access: 'WRITE' },
        { userId: 'u-3', access: 'WRITE' },
      ],
      count: 3,
    };
    mockOkResponse(payload);

    const result = await authApi.bulkSetPermissions('board-7', ['u-1', 'u-2', 'u-3'], 'WRITE');

    expect(result).toEqual(payload);
    expect(result.success).toBe(true);
    expect(result.boardId).toBe('board-7');
    expect(result.count).toBe(3);
    expect(Array.isArray(result.granted)).toBe(true);
    expect(result.granted).toHaveLength(3);
    result.granted.forEach((entry) => {
      expect(entry).toHaveProperty('userId');
      expect(entry).toHaveProperty('access');
    });
  });

  it('preserves userIds order in the request body', async () => {
    mockOkResponse({
      success: true,
      boardId: 'board-1',
      granted: [],
      count: 0,
    });

    const ids = ['user-z', 'user-a', 'user-m'];
    await authApi.bulkSetPermissions('board-1', ids, 'ADMIN');

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body).userIds).toEqual(ids);
  });

  const failureCases = [
    {
      name: '400 unknown user ids → ApiError preserves status and parses message',
      status: 400,
      body: {
        error: 'Unknown user ids',
        unknownUserIds: ['user-99'],
      },
      access: 'READ' as const,
    },
    {
      name: '400 too many users → ApiError preserves status',
      status: 400,
      body: { error: 'Too many users in one request' },
      access: 'READ' as const,
    },
    {
      name: '403 owner forbidden → ApiError preserves status',
      status: 403,
      body: { error: "Cannot bulk-modify owner's permission row" },
      access: 'WRITE' as const,
    },
    {
      name: '404 board not found → ApiError preserves status',
      status: 404,
      body: { error: 'Board not found' },
      access: 'READ' as const,
    },
  ];

  failureCases.forEach((tc) => {
    it(tc.name, async () => {
      mockErrorResponse(tc.status, tc.body);

      await expect(
        authApi.bulkSetPermissions('board-1', ['user-1'], tc.access)
      ).rejects.toMatchObject({
        status: tc.status,
        message: tc.body.error,
      });
    });
  });
});