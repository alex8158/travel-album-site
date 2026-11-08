import {
  useContext, useEffect, useRef, useState,
  type CSSProperties, type ImgHTMLAttributes, type MouseEventHandler,
} from 'react';
import { AuthContext, authFetch } from '../contexts/AuthContext';

/**
 * `<img>` for the media file routes `/api/media/:id/{thumbnail,original,raw}`.
 *
 * Those routes decide per request from `Authorization: Bearer` (multi-user-system
 * G-21), which a plain `<img src>` cannot send. For a same-origin media-route URL
 * this component fetches the bytes with `authFetch` and shows them from an object
 * URL. Anything else is never sent the token:
 *
 * - empty `src`: placeholder, no request;
 * - `blob:` / `data:` URLs: rendered directly;
 * - other paths and cross-origin URLs: rendered as a plain `<img>`, which the
 *   browser loads without our Authorization header.
 *
 * Loading and failure (including 404 for media the requester may not see) show a
 * placeholder box that keeps the given `style` / `className`, so layouts do not
 * collapse and no broken-image icon appears.
 *
 * `loading="lazy"` is honoured: the fetch starts only when the element comes near
 * the viewport (IntersectionObserver, 200px margin). Without IntersectionObserver
 * the fetch starts immediately.
 *
 * The request is cancelled and the object URL released when `src` changes, when
 * the signed-in identity changes (login, logout, account switch), and on unmount,
 * so an image fetched under one identity is never kept on screen for another.
 */
export type AuthorizedImageProps = ImgHTMLAttributes<HTMLImageElement> & { src?: string | null };

const MEDIA_ROUTE = /^\/api\/media\/[^/]+\/(thumbnail|original|raw)$/;

export type ImageSourceKind = 'empty' | 'authorized' | 'direct';

/** Decide how a `src` is loaded. Exported for tests. */
export function classifyImageSource(src: string | null | undefined): ImageSourceKind {
  if (!src) return 'empty';
  if (/^(blob|data):/i.test(src)) return 'direct';
  let url: URL;
  try {
    url = new URL(src, window.location.href);
  } catch {
    return 'direct';
  }
  if (url.origin !== window.location.origin) return 'direct';
  return MEDIA_ROUTE.test(url.pathname) ? 'authorized' : 'direct';
}

/** Token outside AuthProvider; never throws during render. */
function readStoredToken(): string {
  try {
    return localStorage.getItem('auth_token') ?? '';
  } catch {
    return '';
  }
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string }
  | { status: 'error' };

const PLACEHOLDER_STYLE: CSSProperties = {
  background: '#eee',
  display: 'block',
};

export default function AuthorizedImage({ src, loading, style, className, alt, ...imgProps }: AuthorizedImageProps) {
  const auth = useContext(AuthContext);
  // Identity key: the provider's token when mounted inside AuthProvider, else
  // whatever authFetch would send. A change re-runs the effect below.
  const identity = auth ? (auth.token ?? '') : readStoredToken();
  const kind = classifyImageSource(src);
  const lazy = loading === 'lazy' && typeof IntersectionObserver !== 'undefined';

  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [inView, setInView] = useState(!lazy);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  // Start observing only while we still need to load.
  useEffect(() => {
    if (kind !== 'authorized' || inView) return;
    const el = placeholderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [kind, inView]);

  useEffect(() => {
    if (kind !== 'authorized' || !inView || !src) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });

    (async () => {
      try {
        const res = await authFetch(src, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', objectUrl });
      } catch {
        if (!active || controller.signal.aborted) return;
        setState({ status: 'error' });
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, inView, src, identity]);

  if (kind === 'direct') {
    return <img {...imgProps} src={src ?? undefined} alt={alt} loading={loading} style={style} className={className} />;
  }

  if (kind === 'authorized' && state.status === 'ready') {
    return <img {...imgProps} src={state.objectUrl} alt={alt} style={style} className={className} />;
  }

  const placeholderState = kind === 'empty' ? 'empty' : state.status === 'error' ? 'error' : 'loading';
  return (
    <div
      ref={placeholderRef}
      role="img"
      aria-label={alt}
      aria-busy={placeholderState === 'loading' || undefined}
      data-testid={(imgProps as Record<string, unknown>)['data-testid'] as string | undefined}
      data-image-state={placeholderState}
      className={className}
      style={{ ...PLACEHOLDER_STYLE, ...style }}
      onClick={imgProps.onClick as unknown as MouseEventHandler<HTMLDivElement> | undefined}
    />
  );
}
