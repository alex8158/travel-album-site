export interface VideoPlayerProps {
  videoUrl: string;
  mimeType: string;
  onClose?: () => void;
}

export default function VideoPlayer({ videoUrl, mimeType, onClose }: VideoPlayerProps) {
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
      <video
        controls
        autoPlay
        data-testid="video-element"
        aria-label="视频内容"
        style={{ width: '100%', maxHeight: '60vh', display: 'block', borderRadius: '4px' }}
      >
        <source src={videoUrl} type={mimeType} />
        您的浏览器不支持视频播放。
      </video>
    </div>
  );
}
