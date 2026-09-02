import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import Lightbox from '../components/Lightbox';
import ImageEditor from '../components/ImageEditor';
import VideoPlayer from '../components/VideoPlayer';
import { getTierPhotos, getHighlightPhotos, TierPhotoItem } from '../api';

export interface GalleryTrip {
  id: string;
  title: string;
  description?: string;
  coverImageId?: string;
  // Required, matching the server contract: trips.visibility is NOT NULL DEFAULT
  // 'public' and the API only ever writes 'public' or 'unlisted'. Leaving this
  // optional previously let fixtures fabricate an undefined state that production
  // cannot produce, which is what hid the inverted video-section gate below.
  visibility: 'public' | 'unlisted';
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
  compiledPath?: string;
  mediaSource?: 'upload' | 'merged';
  audioTrackId?: string;
}

export interface GalleryData {
  trip: GalleryTrip;
  images: GalleryImage[];
  videos: GalleryVideo[];
  originalVideos?: GalleryVideo[];
  compiledVideos?: GalleryVideo[];
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
  const [tierSlideshowUrls, setTierSlideshowUrls] = useState<Record<string, string>>({});
  const [galleryTab, setGalleryTab] = useState<'all' | 'tier'>('all');
  const [highlightPhotos, setHighlightPhotos] = useState<TierPhotoItem[]>([]);
  const [tierPhotos, setTierPhotos] = useState<TierPhotoItem[]>([]);

  // Photos on this page come from the 精选 / 精华 endpoints, not from data.images
  // — the raw image grid it used to feed now lives only in MyGalleryPage.
  const videos = data?.videos ?? [];

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

  // Fetch tier slideshow URL and tier photos for public trips
  useEffect(() => {
    let cancelled = false;
    async function loadTierData() {
      if (!id) return;
      try {
        const tierData = await getTierPhotos(id);
        if (!cancelled) {
          setTierSlideshowUrls(tierData.slideshowUrls ?? {});
          setTierPhotos(tierData.photos);
        }
      } catch {
        // Silently ignore — tier data may not exist yet
      }
    }
    // Only fetch once gallery data confirms the trip is public
    if (data && data.trip.visibility !== 'unlisted') {
      loadTierData();
    }
    return () => { cancelled = true; };
  }, [id, data]);

  // Fetch highlight photos for the "全部" tab
  useEffect(() => {
    let cancelled = false;
    async function loadHighlightPhotos() {
      if (!id) return;
      try {
        const result = await getHighlightPhotos(id);
        if (!cancelled) {
          setHighlightPhotos(result.photos);
        }
      } catch {
        // Silently ignore — highlight data may not exist yet
      }
    }
    // Only fetch for public trips
    if (data && data.trip.visibility !== 'unlisted') {
      loadHighlightPhotos();
    }
    return () => { cancelled = true; };
  }, [id, data]);

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
      <div className="page-container" style={{ textAlign: 'center' }}>
        <p role="alert" style={{ fontSize: '1.25rem', color: '#666', marginTop: '48px' }}>该相册未公开</p>
        <Link to="/" style={{ display: 'inline-block', marginTop: '16px' }}>
          ← 返回首页
        </Link>
      </div>
    );
  }

  const { trip } = data;

  return (
    <div className="page-container">
      <Link to="/" style={{ display: 'inline-block', marginBottom: '16px' }}>
        ← 返回首页
      </Link>

      <header className="page-header" aria-label="旅行信息">
        <h1>{trip.title}</h1>
        {trip.description && <p>{trip.description}</p>}
      </header>

      {/* Gallery mode tabs — only for public trips with highlight data */}
      {data.trip.visibility === 'public' && (
        <div className="pill-tabs" data-testid="gallery-mode-tabs">
          <button className={`pill-tab${galleryTab === 'all' ? ' active' : ''}`} onClick={() => setGalleryTab('all')}>精选</button>
          <button className={`pill-tab${galleryTab === 'tier' ? ' active' : ''}`} onClick={() => setGalleryTab('tier')}>精华</button>
        </div>
      )}

      {/* "全部" tab: show all highlight photos */}
      {galleryTab === 'all' && data.trip.visibility === 'public' && highlightPhotos.length > 0 && (
        <section aria-label="全部精选照片">
          <h2>精选照片 ({highlightPhotos.length})</h2>
          <div
            data-testid="highlight-photos-grid"
            className="media-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
            {highlightPhotos.map((photo, idx) => (
              <div
                key={photo.id}
                data-testid={`highlight-photo-${photo.id}`}
                className="media-card"
                style={{ cursor: 'pointer' }}
                onClick={() => setLightboxIndex(idx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setLightboxIndex(idx); }}
              >
                <img
                  src={photo.thumbnailUrl}
                  alt={photo.category || '精选照片'}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* "精华" tab: show tier photos + slideshow */}
      {galleryTab === 'tier' && data.trip.visibility === 'public' && (
        <>
          {Object.keys(tierSlideshowUrls).length > 0 && (
            <section aria-label="精华视频" data-testid="tier-slideshow-section" style={{ marginBottom: '24px' }}>
              <h2>精华视频</h2>
              {Object.entries(tierSlideshowUrls).map(([cat, url]) => (
                <div key={cat} style={{ maxWidth: '800px', margin: '0 auto 16px' }}>
                  {cat !== 'all' && <h3 style={{ margin: '0 0 8px 0', color: '#666' }}>{cat === 'animal' ? '🐾 动物' : cat === 'landscape' ? '🏞️ 风景' : cat === 'people' ? '👤 人物' : cat}</h3>}
                  <video
                    src={url}
                    controls
                    data-testid="tier-slideshow-video"
                    style={{ width: '100%', borderRadius: '8px', background: '#000' }}
                    aria-label={`精华视频 - ${cat}`}
                  />
                </div>
              ))}
            </section>
          )}
          {tierPhotos.length > 0 && (
            <section aria-label="精华照片">
              <h2>精华照片 ({tierPhotos.length})</h2>
              <div
                data-testid="tier-photos-grid"
                className="media-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap: '12px',
                }}
              >
                {tierPhotos.map((photo, idx) => (
                  <div
                    key={photo.id}
                    data-testid={`tier-photo-${photo.id}`}
                    className="media-card"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setLightboxIndex(idx)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setLightboxIndex(idx); }}
                  >
                    <img
                      src={photo.thumbnailUrl}
                      alt={photo.category || '精华照片'}
                      style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
          {tierPhotos.length === 0 && Object.keys(tierSlideshowUrls).length === 0 && (
            <div className="empty-state" style={{ padding: '32px' }}>
              <p>暂无精华照片</p>
            </div>
          )}
        </>
      )}

      {/*
        Public gallery video section. The server already restricts this payload to
        compiled / merged videos, which is exactly what visitors are meant to see
        (video-auto-compile-and-merge Requirement 3, multi-user-system 需求 9 AC 6).

        There is deliberately no raw image grid here. The public photo view is the
        精选 / 精华 grids above (highlight-tier Requirement 8 AC 1); owners are
        routed to /my/trips/:id instead (multi-user-system 需求 11 AC 11), which is
        where the full unfiltered grid lives.
      */}
      {data.trip.visibility === 'public' && videos.length > 0 && (
        <section aria-label="视频区域">
          <h2>视频 ({videos.length})</h2>
          <div
            data-testid="video-grid"
            className="media-grid"
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
                className="media-card"
                style={{ cursor: 'pointer' }}
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
                {/*
                  No download control on purpose: this gallery is anonymous, and
                  every compiled-video download endpoint requires Bearer auth. No
                  requirement grants visitors a compiled download, so none is
                  offered here. Owner-side download lives in MyGalleryPage.
                */}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Video Player Modal */}
      {selectedVideoId && (() => {
        const selectedVideo = videos.find(v => v.id === selectedVideoId);
        // /original is the playback authority: for videos it resolves to
        // compiled_path when present, serves inline with Range support, and needs
        // no auth. ?original=true is the only way to ask for the raw upload.
        const videoUrl = `/api/media/${selectedVideoId}/original`;
        return (
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
                videoUrl={videoUrl}
                mimeType={selectedVideo?.mimeType || 'video/mp4'}
                onClose={() => setSelectedVideoId(null)}
              />
            </div>
          </div>
        );
      })()}

      {lightboxIndex !== null && !editingMediaId && (() => {
        // Only the 精选 / 精华 grids can open the lightbox on this page, and both
        // exist only for public trips, so the tab decides the list outright.
        const lightboxImages = galleryTab === 'tier'
          ? tierPhotos.map((p) => ({ originalUrl: p.originalUrl, mediaId: p.id, alt: p.category || '精华照片' }))
          : highlightPhotos.map((p) => ({ originalUrl: p.originalUrl, mediaId: p.id, alt: p.category || '精选照片' }));
        return (
          <Lightbox
            images={lightboxImages}
            currentIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onPrev={() => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
            onNext={() => setLightboxIndex((i) => (i !== null && i < lightboxImages.length - 1 ? i + 1 : i))}
            onEdit={(mediaId) => setEditingMediaId(mediaId)}
          />
        );
      })()}

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
