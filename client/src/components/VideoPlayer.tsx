import { useContext } from 'react';
import AuthorizedVideo from './AuthorizedVideo';
import { AuthContext } from '../contexts/AuthContext';

export interface VideoPlayerProps {
  videoUrl: string;
  mimeType: string;
  onClose?: () => void;
  /**
   * Fetch the file with the caller's Authorization header and play it from a
   * blob (multi-user-system G-21). Needed for owner/admin-only files, e.g.
   * private, trashed or uncompiled videos. The whole file is downloaded before
   * playback starts: no HTTP Range streaming. The request starts only when the
   * player mounts, and is aborted and its object URL released when the player
   * closes, the URL changes or the signed-in identity changes. Default false
   * keeps the plain `<source src>` with Range streaming.
   */
  authorized?: boolean;
}

const VIDEO_STYLE = { width: '100%', maxHeight: '60vh', display: 'block', borderRadius: '4px' } as const;

export default function VideoPlayer({ videoUrl, mimeType, onClose, authorized = false }: VideoPlayerProps) {
  const auth = useContext(AuthContext);
  const identity = auth ? (auth.token ?? '') : '';
  return (
    <div
      data-testid="video-player"
      role="region"
      aria-label="视频播放器"
      style={{
        padding: '12px',
        background: '#000',
        borderRadius: '8px',
        position: 'relative',
      }}
    >
      {onClose && (
        <button
          onClick={onClose}
          aria-label="关闭播放器"
          data-testid="video-player-close"
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            color: '#fff',
            fontSize: '1.25rem',
            cursor: 'pointer',
            borderRadius: '50%',
            width: 32,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
          }}
        >
          ×
        </button>
      )}
      {authorized ? (
        // key: remount (abort + revoke) when the signed-in identity changes.
        <AuthorizedVideo
          key={identity}
          src={videoUrl}
          controls
          autoPlay
          playsInline
          preload="metadata"
          data-testid="video-element"
          aria-label="视频内容"
          style={VIDEO_STYLE}
        >
          您的浏览器不支持视频播放。
        </AuthorizedVideo>
      ) : (
        <video
          controls
          autoPlay
          playsInline
          preload="metadata"
          data-testid="video-element"
          aria-label="视频内容"
          style={VIDEO_STYLE}
        >
          <source src={videoUrl} type={mimeType} />
          您的浏览器不支持视频播放。
        </video>
      )}
    </div>
  );
}
