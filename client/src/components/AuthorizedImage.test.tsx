import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useState } from 'react';
import AuthorizedImage, { classifyImageSource } from './AuthorizedImage';
import { AuthContext, type AuthContextValue } from '../contexts/AuthContext';

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void; signal?: AbortSignal };

function okResponse(url: string): Response {
  return { ok: true, status: 200, blob: async () => ({ fetchedFrom: url }) as unknown as Blob } as unknown as Response;
}

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

let fetchMock: ReturnType<typeof vi.fn>;
let pending: Map<string, Deferred[]>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let blobCounter: number;

function installDeferredFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return new Promise<Response>((resolve, reject) => {
      const list = pending.get(url) ?? [];
      list.push({ resolve, reject, signal: init?.signal ?? undefined });
      pending.set(url, list);
    });
  });
}

function authHeader(callIndex: number): string | null {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit | undefined;
  return new Headers(init?.headers).get('Authorization');
}

beforeEach(() => {
  pending = new Map();
  blobCounter = 0;
  fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(okResponse(String(input))));
  vi.stubGlobal('fetch', fetchMock);
  createObjectURL = vi.fn((b: { fetchedFrom: string }) => `blob:${b.fetchedFrom}#${++blobCounter}`);
  revokeObjectURL = vi.fn();
  globalThis.URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.setItem('auth_token', 'owner-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyImageSource', () => {
  it('only same-origin media routes are authorized', () => {
    const origin = window.location.origin;
    expect(classifyImageSource('/api/media/abc/thumbnail')).toBe('authorized');
    expect(classifyImageSource('/api/media/abc/original?original=true')).toBe('authorized');
    expect(classifyImageSource(`${origin}/api/media/abc/raw`)).toBe('authorized');
    expect(classifyImageSource('https://evil.example.com/api/media/abc/thumbnail')).toBe('direct');
    expect(classifyImageSource('//evil.example.com/api/media/abc/thumbnail')).toBe('direct');
    expect(classifyImageSource('/api/media/abc/versions')).toBe('direct');
    expect(classifyImageSource('/api/media/abc/thumbnail/extra')).toBe('direct');
    expect(classifyImageSource('/uploads/t/originals/a.jpg')).toBe('direct');
    expect(classifyImageSource('blob:http://localhost/123')).toBe('direct');
    expect(classifyImageSource('data:image/png;base64,AAAA')).toBe('direct');
    expect(classifyImageSource('')).toBe('empty');
    expect(classifyImageSource(undefined)).toBe('empty');
    expect(classifyImageSource(null)).toBe('empty');
  });
});

describe('AuthorizedImage', () => {
  it('fetches a media route with the bearer token and shows the blob', async () => {
    render(<AuthorizedImage src="/api/media/a/thumbnail" alt="a" data-testid="i" />);
    await waitFor(() => expect(screen.getByTestId('i').tagName).toBe('IMG'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(0)).toBe('Bearer owner-token');
    expect(screen.getByTestId('i').getAttribute('src')).toMatch(/^blob:\/api\/media\/a\/thumbnail#/);
  });

  it.each([
    ['cross-origin', 'https://cdn.example.com/a.jpg'],
    ['protocol-relative', '//cdn.example.com/api/media/a/thumbnail'],
    ['blob', 'blob:http://localhost/xyz'],
    ['data', 'data:image/png;base64,AAAA'],
    ['other same-origin path', '/static/a.png'],
  ])('%s URLs are rendered directly and never fetched with the token', (_n, src) => {
    render(<AuthorizedImage src={src} alt="x" data-testid="i" />);
    const el = screen.getByTestId('i');
    expect(el.tagName).toBe('IMG');
    expect(el.getAttribute('src')).toBe(src);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty src renders a placeholder and makes no request', () => {
    render(<AuthorizedImage src="" alt="封面" data-testid="i" style={{ height: 180 }} />);
    const el = screen.getByTestId('i');
    expect(el.tagName).toBe('DIV');
    expect(el.getAttribute('data-image-state')).toBe('empty');
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('封面');
    expect(el.style.height).toBe('180px');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 404 (denied or missing) shows the failure placeholder, not a broken image', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, blob: async () => ({}) } as unknown as Response);
    render(<AuthorizedImage src="/api/media/a/thumbnail" alt="a" data-testid="i" />);
    await waitFor(() => expect(screen.getByTestId('i').getAttribute('data-image-state')).toBe('error'));
    expect(screen.getByTestId('i').tagName).toBe('DIV');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('src change aborts the old request and revokes the old object URL', async () => {
    const { rerender } = render(<AuthorizedImage src="/api/media/a/original" alt="a" data-testid="i" />);
    await waitFor(() => expect(screen.getByTestId('i').tagName).toBe('IMG'));
    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    const firstUrl = screen.getByTestId('i').getAttribute('src');

    rerender(<AuthorizedImage src="/api/media/b/original" alt="b" data-testid="i" />);
    expect(firstSignal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
    await waitFor(() => expect(screen.getByTestId('i').getAttribute('src')).toMatch(/\/b\/original#/));
  });

  it('a late response for an old src never replaces the new one', async () => {
    installDeferredFetch();
    const { rerender } = render(<AuthorizedImage src="/api/media/a/original" alt="" data-testid="i" />);
    rerender(<AuthorizedImage src="/api/media/b/original" alt="" data-testid="i" />);
    await act(async () => { pending.get('/api/media/b/original')![0].resolve(okResponse('/api/media/b/original')); });
    await act(async () => { pending.get('/api/media/a/original')![0].resolve(okResponse('/api/media/a/original')); });
    expect(screen.getByTestId('i').getAttribute('src')).toMatch(/\/b\/original#/);
    expect(createObjectURL).not.toHaveBeenCalledWith({ fetchedFrom: '/api/media/a/original' });
  });

  it('unmount aborts in-flight requests and revokes the object URL', async () => {
    const { unmount } = render(<AuthorizedImage src="/api/media/a/original" alt="" data-testid="i" />);
    await waitFor(() => expect(screen.getByTestId('i').tagName).toBe('IMG'));
    const url = screen.getByTestId('i').getAttribute('src');
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('login, logout and account switch abort, revoke and reload under the new identity', async () => {
    let setToken: (t: string | null) => void = () => {};
    function Harness() {
      const [token, set] = useState<string | null>('owner-token');
      setToken = (t) => {
        if (t) localStorage.setItem('auth_token', t); else localStorage.removeItem('auth_token');
        set(t);
      };
      const value = { token, user: null, isLoggedIn: !!token, login: vi.fn(), logout: vi.fn(), register: vi.fn() } as unknown as AuthContextValue;
      return (
        <AuthContext.Provider value={value}>
          <AuthorizedImage src="/api/media/p/thumbnail" alt="" data-testid="i" />
        </AuthContext.Provider>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('i').tagName).toBe('IMG'));
    const ownerUrl = screen.getByTestId('i').getAttribute('src');
    expect(authHeader(0)).toBe('Bearer owner-token');

    // Logout: the owner's image is released and re-fetched anonymously.
    installDeferredFetch();
    act(() => setToken(null));
    expect(revokeObjectURL).toHaveBeenCalledWith(ownerUrl);
    expect(screen.getByTestId('i').tagName).toBe('DIV');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeader(1)).toBeNull();
    const anonRequest = pending.get('/api/media/p/thumbnail')![0];

    // Account switch before the anonymous response: that request is aborted.
    act(() => setToken('other-token'));
    expect(anonRequest.signal?.aborted).toBe(true);
    expect(authHeader(2)).toBe('Bearer other-token');
    await act(async () => { anonRequest.resolve(okResponse('/api/media/p/thumbnail')); });
    expect(screen.getByTestId('i').tagName).toBe('DIV');
  });

  describe('lazy loading', () => {
    let observers: Array<{ cb: IntersectionObserverCallback; el?: Element; disconnected: boolean }>;
    beforeEach(() => {
      observers = [];
      class FakeIO {
        private rec: { cb: IntersectionObserverCallback; el?: Element; disconnected: boolean };
        constructor(cb: IntersectionObserverCallback) { this.rec = { cb, disconnected: false }; observers.push(this.rec); }
        observe(el: Element) { this.rec.el = el; }
        disconnect() { this.rec.disconnected = true; }
        unobserve() {}
        takeRecords() { return []; }
      }
      vi.stubGlobal('IntersectionObserver', FakeIO);
    });

    it('does not fetch until the placeholder nears the viewport', async () => {
      render(<AuthorizedImage loading="lazy" src="/api/media/a/thumbnail" alt="" data-testid="i" />);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('i').getAttribute('data-image-state')).toBe('loading');
      const io = observers[0];
      expect(io.el).toBe(screen.getByTestId('i'));

      await act(async () => {
        io.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(io.disconnected).toBe(true);
      await waitFor(() => expect(screen.getByTestId('i').tagName).toBe('IMG'));
    });

    it('a list of lazy images fetches only the visible ones', async () => {
      render(
        <>
          {['a', 'b', 'c', 'd'].map((id) => (
            <AuthorizedImage key={id} loading="lazy" src={`/api/media/${id}/thumbnail`} alt="" />
          ))}
        </>,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      await act(async () => {
        observers[1].cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe('/api/media/b/thumbnail');
    });
  });
});
