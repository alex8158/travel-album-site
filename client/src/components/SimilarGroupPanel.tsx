/**
 * SimilarGroupPanel — modal dialog showing all photos in a Similar_Group
 * with a clear visual indicator on the AI-recommended best photo.
 *
 * The panel is a fixed-position overlay with a backdrop. Users can close it
 * by clicking the backdrop, pressing ESC, or clicking the × button in the
 * corner. Thumbnails are arranged in a responsive grid; the photo whose
 * id matches `group.bestPhotoId` is rendered with a gold border and a
 * "推荐" label.
 *
 * Requirements: 7.3
 */

import { useEffect, useCallback } from 'react';
import type { SimilarGroup } from '../api';

export interface SimilarGroupPanelProps {
  group: SimilarGroup;
  /** Map of group member photos. Each entry has an id and a thumbnail URL. */
  photos: Array<{ id: string; thumbnailUrl: string }>;
  onClose: () => void;
}

export default function SimilarGroupPanel({ group, photos, onClose }: SimilarGroupPanelProps) {
  // Resolve which photos to render. Prefer the order from group.memberPhotoIds
  // so the layout matches the AI's grouping; fall back to the supplied photos
  // array for any IDs that are missing (defensive).
  const photoMap = new Map(photos.map((p) => [p.id, p]));
  const orderedPhotos = group.memberPhotoIds
    .map((id) => photoMap.get(id))
    .filter((p): p is { id: string; thumbnailUrl: string } => Boolean(p));

  // Append any extra photos not present in memberPhotoIds (shouldn't happen,
  // but keeps the component robust if the caller passes additional context).
  for (const p of photos) {
    if (!group.memberPhotoIds.includes(p.id)) {
      orderedPhotos.push(p);
    }
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const totalCount = group.memberPhotoIds.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="相似照片组"
      data-testid="similar-group-panel"
      onClick={handleOverlayClick}
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
          maxWidth: 960,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 20,
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>
            相似照片组 ({totalCount} 张)
          </h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            data-testid="similar-group-close-btn"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <p style={{ margin: '0 0 16px 0', color: '#666', fontSize: '0.9rem' }}>
          AI 已为您推荐组中质量最佳的一张
        </p>

        {orderedPhotos.length === 0 ? (
          <p
            data-testid="similar-group-empty"
            style={{ color: '#999', textAlign: 'center', padding: '24px 0' }}
          >
            暂无可显示的照片
          </p>
        ) : (
          <div
            data-testid="similar-group-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 12,
            }}
          >
            {orderedPhotos.map((photo) => {
              const isBest = photo.id === group.bestPhotoId;
              return (
                <div
                  key={photo.id}
                  data-testid={isBest ? 'similar-group-best-photo' : 'similar-group-photo'}
                  data-photo-id={photo.id}
                  data-best={isBest ? 'true' : 'false'}
                  style={{
                    position: 'relative',
                    border: isBest ? '3px solid #ffc107' : '1px solid #e0e0e0',
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: '#f5f5f5',
                    aspectRatio: '1 / 1',
                    boxShadow: isBest ? '0 0 12px rgba(255, 193, 7, 0.5)' : 'none',
                  }}
                >
                  <img
                    src={photo.thumbnailUrl}
                    alt={isBest ? '推荐保留的最佳照片' : '相似组成员照片'}
                    loading="lazy"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                  {isBest && (
                    <div
                      data-testid="similar-group-best-label"
                      style={{
                        position: 'absolute',
                        top: 6,
                        left: 6,
                        background: 'rgba(255, 193, 7, 0.95)',
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 12,
                        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
                        letterSpacing: '0.5px',
                      }}
                    >
                      推荐
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
