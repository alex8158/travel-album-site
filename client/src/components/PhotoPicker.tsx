/**
 * PhotoPicker — 照片选择对话框
 *
 * Modal dialog for selecting a photo from the highlight pool to add to the tier.
 * Opens when the user clicks an Empty_Slot "+" icon in the "精华" tab.
 *
 * Requirements: 2.1, 2.2, 2.4, 2.6, 3.3
 */

import { useState, useEffect, useCallback } from 'react';
import { getHighlightPool, TierPhotoItem } from '../api';

export interface PhotoPickerProps {
  tripId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (photo: TierPhotoItem) => void;
}

export default function PhotoPicker({ tripId, open, onClose, onSelect }: PhotoPickerProps) {
  const [photos, setPhotos] = useState<TierPhotoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPhotos([]);

    getHighlightPool(tripId)
      .then((res) => {
        if (!cancelled) {
          setPhotos(res.photos);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, tripId]);

  const handlePhotoClick = useCallback(
    (photo: TierPhotoItem) => {
      onSelect(photo);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="选择照片"
      data-testid="photo-picker-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 20,
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>选择照片</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            data-testid="photo-picker-close-btn"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            ×
          </button>
        </div>

        {/* Loading state */}
        {loading && (
          <div data-testid="photo-picker-loading" style={{ textAlign: 'center', padding: '40px 0', color: '#666' }}>
            加载中...
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div data-testid="photo-picker-error" style={{ textAlign: 'center', padding: '40px 0', color: '#d32f2f' }}>
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && photos.length === 0 && (
          <div data-testid="photo-picker-empty" style={{ textAlign: 'center', padding: '40px 0', color: '#666' }}>
            没有可选择的照片
          </div>
        )}

        {/* Photo grid */}
        {!loading && !error && photos.length > 0 && (
          <div
            data-testid="photo-picker-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 8,
            }}
          >
            {photos.map((photo) => (
              <button
                key={photo.id}
                data-testid={`photo-picker-item-${photo.id}`}
                onClick={() => handlePhotoClick(photo)}
                style={{
                  border: '2px solid transparent',
                  borderRadius: 4,
                  padding: 0,
                  cursor: 'pointer',
                  background: '#f5f5f5',
                  overflow: 'hidden',
                  aspectRatio: '1',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = '#2196f3';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
                }}
              >
                <img
                  src={photo.thumbnailUrl}
                  alt={photo.category || '照片'}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
