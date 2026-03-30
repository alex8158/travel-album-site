import { useEffect, useCallback } from 'react';

export interface LightboxImage {
  originalUrl: string;
  alt: string;
}

export interface LightboxProps {
  images: LightboxImage[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export default function Lightbox({ images, currentIndex, onClose, onPrev, onNext }: LightboxProps) {
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === images.length - 1;
  const current = images[currentIndex];

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && !isFirst) onPrev();
      else if (e.key === 'ArrowRight' && !isLast) onNext();
    },
    [onClose, onPrev, onNext, isFirst, isLast],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片灯箱"
      data-testid="lightbox-overlay"
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <button
        onClick={onClose}
        aria-label="关闭灯箱"
        data-testid="lightbox-close"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'none',
          border: 'none',
          color: '#fff',
          fontSize: '2rem',
          cursor: 'pointer',
        }}
      >
        ×
      </button>

      {!isFirst && (
        <button
          onClick={onPrev}
          aria-label="上一张"
          data-testid="lightbox-prev"
          style={{
            position: 'absolute',
            left: 16,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: '#fff',
            fontSize: '2rem',
            cursor: 'pointer',
          }}
        >
          ←
        </button>
      )}

      <img
        src={current.originalUrl}
        alt={current.alt}
        data-testid="lightbox-image"
        style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }}
      />

      {!isLast && (
        <button
          onClick={onNext}
          aria-label="下一张"
          data-testid="lightbox-next"
          style={{
            position: 'absolute',
            right: 16,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: '#fff',
            fontSize: '2rem',
            cursor: 'pointer',
          }}
        >
          →
        </button>
      )}
    </div>
  );
}
