import { useEffect, useState, type ReactNode, type VideoHTMLAttributes } from 'react';
import { authFetch } from '../contexts/AuthContext';

/**
 * `<video>` whose bytes are fetched with the caller's Authorization header.
 *
 * A plain `<video src>` request cannot carry `Authorization: Bearer`, and the
 * server only reads the JWT from that header, so owner/admin-only video files
 * (e.g. tier slideshow mp4s) would always be served as anonymous. This component
 * downloads the file via `authFetch`, then plays it from an object URL.
 *
 * Trade-off: the whole file is downloaded before playback starts (no HTTP Range
 * streaming) and held in memory as a Blob until the source changes or the
 * component unmounts.
 */
export interface AuthorizedVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> {
  /** API URL of the video file. Fetched with the current user's Authorization header. */
  src: string;
  children?: ReactNode;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string }
  | { status: 'error' };

export default function AuthorizedVideo({ src, children, ...videoProps }: AuthorizedVideoProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    // `active` guards against a late response for a previous `src` (or after
    // unmount) overwriting the state of the current one.
    let active = true;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });

    (async () => {
      try {
        const res = await authFetch(src, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const blob = await res.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', objectUrl });
      } catch {
        // Aborts come from our own cleanup and are not a load failure.
        if (!active || controller.signal.aborted) return;
        setState({ status: 'error' });
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  if (state.status === 'loading') {
    return (
      <div role="status" style={{ padding: '16px', textAlign: 'center', color: '#999' }}>
        视频加载中...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        style={{ color: '#d32f2f', padding: '8px', background: '#fdecea', borderRadius: '4px' }}
      >
        视频加载失败
      </div>
    );
  }

  return (
    <video {...videoProps} src={state.objectUrl}>
      {children}
    </video>
  );
}
