import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import AuthorizedVideo from './AuthorizedVideo';

// The real authFetch is used on purpose: these tests assert the actual
// Authorization header that reaches fetch, read from the existing token store.

type Deferred = {
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
};

/** Response-like object whose blob carries the URL it was fetched from. */
function okResponse(url: string): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => ({ fetchedFrom: url }) as unknown as Blob,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let pending: Map<string, Deferred>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

/** fetch that stays pending until the test resolves it. Ignores abort on purpose,
 * to simulate a response that still arrives after the caller moved on. */
function installDeferredFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return new Promise<Response>((resolve, reject) => {
      pending.set(url, { resolve, reject, signal: init?.signal ?? undefined });
    });
  });
}

function headersOf(callIndex: number): Headers {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

beforeEach(() => {
  pending = new Map();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  createObjectURL = vi.fn((blob: { fetchedFrom: string }) => `blob:${blob.fetchedFrom}`);
  revokeObjectURL = vi.fn();
  globalThis.URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  // In-memory stand-in for the token store authFetch reads (the test runtime's
  // own localStorage is not reliably usable).
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.setItem('auth_token', 'owner-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
}

describe('AuthorizedVideo', () => {
  it('fetches the video with the bearer token and plays the blob URL', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(okResponse(String(input))));
    render(<AuthorizedVideo src="/api/v/a.mp4" controls aria-label="精华视频 - animal" data-testid="v" />);

    const video = await screen.findByTestId('v');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v/a.mp4');
    expect(headersOf(0).get('Authorization')).toBe('Bearer owner-token');
    expect(video.getAttribute('src')).toBe('blob:/api/v/a.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('aria-label')).toBe('精华视频 - animal');
  });

  it('sends no Authorization header when there is no stored token', async () => {
    localStorage.removeItem('auth_token');
    fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(okResponse(String(input))));
    render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);

    await screen.findByTestId('v');
    expect(headersOf(0).has('Authorization')).toBe(false);
  });

  it('shows an accessible loading state and no video while fetching', () => {
    installDeferredFetch();
    const { container } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);

    expect(screen.getByRole('status').textContent).toContain('视频加载中');
    expect(container.querySelector('video')).toBeNull();
  });

  it('shows an alert and renders no video src on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, blob: async () => ({}) } as unknown as Response);
    const { container } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('视频加载失败');
    expect(container.querySelector('video')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows an alert on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);

    expect((await screen.findByRole('alert')).textContent).toContain('视频加载失败');
    expect(container.querySelector('video')).toBeNull();
  });

  it('aborts the previous request and revokes the previous object URL when src changes', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(okResponse(String(input))));
    const { rerender } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    await waitFor(() => expect(screen.getByTestId('v').getAttribute('src')).toBe('blob:/api/v/a.mp4'));
    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    rerender(<AuthorizedVideo src="/api/v/b.mp4" data-testid="v" />);

    expect(firstSignal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:/api/v/a.mp4');
    await waitFor(() => expect(screen.getByTestId('v').getAttribute('src')).toBe('blob:/api/v/b.mp4'));
  });

  it('aborts an in-flight request when src changes before it finishes', () => {
    installDeferredFetch();
    const { rerender } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    const first = pending.get('/api/v/a.mp4')!;

    rerender(<AuthorizedVideo src="/api/v/b.mp4" data-testid="v" />);

    expect(first.signal?.aborted).toBe(true);
  });

  it('does not let a late response for an old src override the newer one', async () => {
    installDeferredFetch();
    const { rerender } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    rerender(<AuthorizedVideo src="/api/v/b.mp4" data-testid="v" />);

    await act(async () => {
      pending.get('/api/v/b.mp4')!.resolve(okResponse('/api/v/b.mp4'));
    });
    await waitFor(() => expect(screen.getByTestId('v').getAttribute('src')).toBe('blob:/api/v/b.mp4'));

    // The old request's response arrives last (the mock ignores abort).
    await act(async () => {
      pending.get('/api/v/a.mp4')!.resolve(okResponse('/api/v/a.mp4'));
    });

    expect(screen.getByTestId('v').getAttribute('src')).toBe('blob:/api/v/b.mp4');
    // No object URL is ever created for the stale response, so nothing leaks.
    expect(createObjectURL).not.toHaveBeenCalledWith({ fetchedFrom: '/api/v/a.mp4' });
  });

  it('does not show an error for a request it aborted itself', async () => {
    installDeferredFetch();
    const { rerender } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    rerender(<AuthorizedVideo src="/api/v/b.mp4" data-testid="v" />);

    await act(async () => {
      pending.get('/api/v/a.mp4')!.reject(new DOMException('aborted', 'AbortError'));
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('revokes the object URL and aborts on unmount', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => Promise.resolve(okResponse(String(input))));
    const { unmount } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    await screen.findByTestId('v');
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:/api/v/a.mp4');
    expect(signal.aborted).toBe(true);
  });

  it('aborts an in-flight request on unmount and never creates an object URL for it', async () => {
    installDeferredFetch();
    const { unmount } = render(<AuthorizedVideo src="/api/v/a.mp4" data-testid="v" />);
    const first = pending.get('/api/v/a.mp4')!;

    unmount();
    expect(first.signal?.aborted).toBe(true);

    await act(async () => {
      first.resolve(okResponse('/api/v/a.mp4'));
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
