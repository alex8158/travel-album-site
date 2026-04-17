import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import Lightbox from '../components/Lightbox';
import ImageEditor from '../components/ImageEditor';
import VideoPlayer from '../components/VideoPlayer';

type CategoryTab = 'all' | 'landscape' | 'animal' | 'people' | 'other';

const CATEGORY_LABELS: Record<CategoryTab, string> = {
  all: '全部',
  landscape: '风景',
  animal: '动物',
  people: '人物',
  other: '其他',
};

const CATEGORY_TABS: CategoryTab[] = ['all', 'landscape', 'animal', 'people', 'other'];

export interface GalleryTrip {
  id: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility?: 'public' | 'unlisted';
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryImageItem {
  id: string;
  tripId: string;
  filePath: string;
  thumbnailPath?: string;
  mediaType: 'image' | 'video' | 'unknown';
  mimeType: string;
  originalFilename: string;
  fileSize: number;
  width?: number;
  height?: number;
  qualityScore?: number;
  duplicateGroupId?: string;
  status?: string;
  trashedReason?: string;
  processingError?: string;
  category?: string;
  avgBrightness?: number;
}

export interface GalleryImage {
  item: GalleryImageItem;
  isDefault: boolean;
  duplicateGroup?: {
    id: string;
    tripId: string;
    defaultImageId: string;
    imageCount: number;
  };
  thumbnailUrl: string;
  originalUrl: string;
}

export interface GalleryVideo {
  id: string;
  tripId: string;
  filePath: string;
  mediaType: 'video';
  mimeType: string;
  originalFilename: string;
  fileSize: number;
  thumbnailUrl: string;
}

export interface GalleryData {
  trip: GalleryTrip;
  images: GalleryImage[];
  videos: GalleryVideo[];
}

export interface TrashedItem {
  id: string;
  tripId: string;
  filePath: string;
  mediaType: 'image' | 'video' | 'unknown';
  mimeType: string;
  originalFilename: string;
  fileSize: number;
  thumbnailUrl: string;
  trashedReason: string;
}

export type AppendMode = 'idle' | 'uploading' | 'cancelled' | 'processing' | 'done';

export default function GalleryPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');

  const images = data?.images ?? [];
  const videos = data?.videos ?? [];

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryTab, number> = { all: images.length, landscape: 0, animal: 0, people: 0, other: 0 };
    for (const img of images) {
      const cat = img.item.category as CategoryTab | undefined;
      if (cat && cat in counts) {
        counts[cat]++;
      } else {
        counts.other++;
      }
    }
    return counts;
  }, [images]);

  const filteredImages = useMemo(() => {
    if (activeCategory === 'all') return images;
    return images.filter((img) => {
      const cat = img.item.category;
      if (activeCategory === 'other') {
        return !cat || cat === 'other';
      }
      return cat === activeCategory;
    });
  }, [images, activeCategory]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await axios.get<GalleryData>(`/api/trips/${id}/gallery`);
        if (!cancelled) setData(res.data);
      } catch {
        if (!cancelled) setError('加载相册数据失败，请稍后重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (id) {
      load();
    }
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return <div role="status" aria-label="加载中">加载中...</div>;
  }

  if (error) {
    return <div role="alert">{error}</div>;
  }

  if (!data) {
    return <div role="alert">未找到相册数据</div>;
  }

  if (data.trip.visibility === 'unlisted') {
    return (
      <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto', textAlign: 'center' }}>
        <p role="alert" style={{ fontSize: '1.25rem', color: '#666', marginTop: '48px' }}>该相册未公开</p>
        <Link to="/" style={{ display: 'inline-block', marginTop: '16px' }}>
          ← 返回首页
        </Link>
      </div>
    );
  }

  const { trip } = data;

  return (
    <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto' }}>
      <Link to="/" style={{ display: 'inline-block', marginBottom: '16px' }}>
        ← 返回首页
      </Link>

      <header aria-label="旅行信息">
        <h1>{trip.title}</h1>
        {trip.description && <p style={{ color: '#666' }}>{trip.description}</p>}
      </header>

      {images.length > 0 && (
        <section aria-label="图片区域">
          <h2>图片 ({images.length})</h2>
          <div data-testid="category-tabs" style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveCategory(tab)}
                data-testid={`category-tab-${tab}`}
                style={{
                  padding: '6px 16px',
                  borderRadius: '4px',
                  border: activeCategory === tab ? '2px solid #4a90d9' : '1px solid #ccc',
                  background: activeCategory === tab ? '#e8f0fe' : '#fff',
                  fontWeight: activeCategory === tab ? 'bold' : 'normal',
                  cursor: 'pointer',
                }}
              >
                {CATEGORY_LABELS[tab]} ({categoryCounts[tab]})
              </button>
            ))}
          </div>
          {filteredImages.length > 0 ? (
            <div
              data-testid="image-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: '12px',
              }}
            >
              {filteredImages.map((img, idx) => (
                <div
                  key={img.item.id}
                  data-testid={`image-${img.item.id}`}
                  style={{
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: trip.coverImageId === img.item.id ? '3px solid #4a90d9' : '1px solid #eee',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{ cursor: 'pointer' }}
                    onClick={() => setLightboxIndex(idx)}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${img.item.originalFilename}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setLightboxIndex(idx); }}
                  >
                    <img
                      src={img.thumbnailUrl}
                      alt={img.item.originalFilename}
                      style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div data-testid="empty-category" style={{ textAlign: 'center', padding: '32px', color: '#999' }}>
              该分类下暂无图片
            </div>
          )}
        </section>
      )}

      {videos.length > 0 && (
        <section aria-label="视频区域">
          <h2>视频 ({videos.length})</h2>
          <div
            data-testid="video-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
            {videos.map((video) => (
              <div
                key={video.id}
                data-testid={`video-${video.id}`}
                style={{
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '1px solid #eee',
                  position: 'relative',
                  cursor: 'pointer',
                }}
                role="button"
                tabIndex={0}
                aria-label={`播放 ${video.originalFilename}`}
                onClick={() => setSelectedVideoId(video.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedVideoId(video.id);
                }}
              >
                {video.thumbnailUrl ? (
                  <img
                    src={video.thumbnailUrl}
                    alt={video.originalFilename}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div
                    data-testid={`video-placeholder-${video.id}`}
                    style={{
                      width: '100%',
                      aspectRatio: '1',
                      background: '#e0e0e0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '2rem',
                    }}
                  >
                    <span role="img" aria-label="视频占位图">🎬</span>
                  </div>
                )}
                <div
                  data-testid={`play-icon-${video.id}`}
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    fontSize: '2.5rem',
                    color: 'rgba(255,255,255,0.9)',
                    textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                    pointerEvents: 'none',
                  }}
                  aria-hidden="true"
                >
                  ▶
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Video Player Modal */}
      {selectedVideoId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="视频播放"
          data-testid="video-player-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedVideoId(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div style={{ width: '90%', maxWidth: '900px' }}>
            <VideoPlayer
              videoUrl={`/api/media/${selectedVideoId}/original`}
              mimeType={videos.find(v => v.id === selectedVideoId)?.mimeType || 'video/mp4'}
              onClose={() => setSelectedVideoId(null)}
            />
          </div>
        </div>
      )}

      {images.length === 0 && videos.length === 0 && (
        <div aria-label="空状态" style={{ textAlign: 'center', padding: '48px', color: '#999' }}>
          这次旅行还没有素材，快去上传吧！
        </div>
      )}

      {lightboxIndex !== null && !editingMediaId && (
        <Lightbox
          images={filteredImages.map((img) => ({
            originalUrl: img.originalUrl,
            mediaId: img.item.id,
            alt: img.item.originalFilename,
          }))}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
          onNext={() => setLightboxIndex((i) => (i !== null && i < filteredImages.length - 1 ? i + 1 : i))}
          onEdit={(mediaId) => setEditingMediaId(mediaId)}
        />
      )}

      {editingMediaId && (
        <ImageEditor
          mediaId={editingMediaId}
          originalUrl={`/api/media/${editingMediaId}/original`}
          onClose={() => setEditingMediaId(null)}
          onSaved={() => {
            setEditingMediaId(null);
            // Reload gallery to show updated image
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
