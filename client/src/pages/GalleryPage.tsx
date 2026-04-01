import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import Lightbox from '../components/Lightbox';
import VideoPlayer from '../components/VideoPlayer';
import FileUploader from '../components/FileUploader';
import ProcessTrigger from '../components/ProcessTrigger';

export interface GalleryTrip {
  id: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility?: 'public' | 'unlisted';
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
}

export interface GalleryData {
  trip: GalleryTrip;
  images: GalleryImage[];
  videos: GalleryVideo[];
}

interface GroupMemberImage {
  id: string;
  originalFilename: string;
  thumbnailUrl: string;
}

export type AppendMode = 'idle' | 'uploading' | 'uploaded' | 'processing' | 'done';

export default function GalleryPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  // Append media state
  const [appendMode, setAppendMode] = useState<AppendMode>('idle');
  const [showAppend, setShowAppend] = useState(false);
  const appendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Edit trip info state
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Cover image picker state
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverSaving, setCoverSaving] = useState(false);

  // Default image picker state
  const [defaultPickerGroupId, setDefaultPickerGroupId] = useState<string | null>(null);
  const [defaultPickerImages, setDefaultPickerImages] = useState<GroupMemberImage[]>([]);
  const [defaultSaving, setDefaultSaving] = useState(false);

  async function fetchGallery() {
    if (!id) return;
    try {
      const res = await axios.get<GalleryData>(`/api/trips/${id}/gallery`);
      setData(res.data);
    } catch {
      setError('加载相册数据失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  // Cleanup append timer on unmount
  useEffect(() => {
    return () => {
      if (appendTimerRef.current) clearTimeout(appendTimerRef.current);
    };
  }, []);

  // --- Append media handlers ---
  const handleAppendClick = useCallback(() => {
    setShowAppend(true);
    setAppendMode('uploading');
  }, []);

  const handleAppendCancel = useCallback(() => {
    setShowAppend(false);
    setAppendMode('idle');
  }, []);

  const handleAllUploaded = useCallback(() => {
    setAppendMode('uploaded');
  }, []);

  const handleAppendProcessed = useCallback(async () => {
    await fetchGallery();
    setAppendMode('done');
    appendTimerRef.current = setTimeout(() => {
      setShowAppend(false);
      setAppendMode('idle');
    }, 2000);
  }, [id]);

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
    if (id) load();
    return () => { cancelled = true; };
  }, [id]);

  // --- Edit trip info handlers ---
  function openEditModal() {
    if (!data) return;
    setEditTitle(data.trip.title);
    setEditDescription(data.trip.description || '');
    setEditError('');
    setEditModalOpen(true);
  }

  async function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    if (!data || editTitle.trim().length === 0) return;
    setEditSaving(true);
    setEditError('');
    try {
      const res = await axios.put(`/api/trips/${data.trip.id}`, {
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
      });
      setData({
        ...data,
        trip: { ...data.trip, title: res.data.title, description: res.data.description, updatedAt: res.data.updatedAt },
      });
      setEditModalOpen(false);
    } catch {
      setEditError('保存失败，请重试');
    } finally {
      setEditSaving(false);
    }
  }

  // --- Cover image handlers ---
  async function handleSetCover(imageId: string) {
    if (!data) return;
    setCoverSaving(true);
    try {
      await axios.put(`/api/trips/${data.trip.id}/cover`, { imageId });
      setData({ ...data, trip: { ...data.trip, coverImageId: imageId } });
      setCoverPickerOpen(false);
    } catch {
      // user can retry
    } finally {
      setCoverSaving(false);
    }
  }

  // --- Default image handlers ---
  async function openDefaultPicker(groupId: string) {
    setDefaultPickerGroupId(groupId);
    setDefaultPickerImages([]);
    try {
      const res = await axios.get<{ images: GroupMemberImage[] }>(`/api/duplicate-groups/${groupId}/images`);
      setDefaultPickerImages(res.data.images);
    } catch {
      setDefaultPickerGroupId(null);
    }
  }

  async function handleSetDefault(groupId: string, imageId: string) {
    setDefaultSaving(true);
    try {
      await axios.put(`/api/duplicate-groups/${groupId}/default`, { imageId });
      await fetchGallery();
      setDefaultPickerGroupId(null);
    } catch {
      // user can retry
    } finally {
      setDefaultSaving(false);
    }
  }

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

  const { trip, images, videos } = data;

  return (
    <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto' }}>
      <Link to="/" style={{ display: 'inline-block', marginBottom: '16px' }}>
        ← 返回首页
      </Link>

      <header aria-label="旅行信息">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1>{trip.title}</h1>
          <button
            onClick={openEditModal}
            aria-label="编辑旅行信息"
            data-testid="edit-trip-btn"
            style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer' }}
          >
            ✏️ 编辑
          </button>
          {(trip.visibility === 'public' || trip.visibility === undefined) && (
            <button
              onClick={handleAppendClick}
              aria-label="追加素材"
              data-testid="append-media-btn"
              style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer' }}
            >
              ➕ 追加素材
            </button>
          )}
        </div>
        {trip.description && <p style={{ color: '#666' }}>{trip.description}</p>}
        {images.length > 0 && (
          <button
            onClick={() => setCoverPickerOpen(true)}
            aria-label="更换封面图"
            data-testid="change-cover-btn"
            style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer', marginTop: '8px' }}
          >
            🖼️ 更换封面图
          </button>
        )}
      </header>

      {/* Append Media Area */}
      {showAppend && (
        <div data-testid="append-area" style={{ border: '1px solid #ddd', borderRadius: '8px', padding: '16px', marginBottom: '16px', background: '#fafafa' }}>
          {appendMode === 'uploading' && (
            <>
              <FileUploader tripId={id!} onAllUploaded={handleAllUploaded} />
              <button
                onClick={handleAppendCancel}
                data-testid="append-cancel-btn"
                style={{ marginTop: '8px' }}
              >
                取消
              </button>
            </>
          )}
          {(appendMode === 'uploaded' || appendMode === 'processing') && (
            <>
              <p style={{ marginBottom: '8px' }}>开始处理</p>
              <ProcessTrigger tripId={id!} onProcessed={handleAppendProcessed} />
            </>
          )}
          {appendMode === 'done' && (
            <p data-testid="append-done-msg" style={{ color: 'green', fontWeight: 'bold' }}>追加完成</p>
          )}
        </div>
      )}

      {images.length > 0 && (
        <section aria-label="图片区域">
          <h2>图片 ({images.length})</h2>
          <div
            data-testid="image-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
            {images.map((img, idx) => (
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
                {img.duplicateGroup && img.duplicateGroup.imageCount > 1 && (
                  <button
                    onClick={() => openDefaultPicker(img.duplicateGroup!.id)}
                    aria-label={`更换默认展示图 ${img.item.originalFilename}`}
                    data-testid={`change-default-btn-${img.duplicateGroup.id}`}
                    style={{
                      position: 'absolute',
                      bottom: '4px',
                      right: '4px',
                      background: 'rgba(255,255,255,0.9)',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      padding: '2px 8px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    🔄 {img.duplicateGroup.imageCount}张
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {videos.length > 0 && (
        <section aria-label="视频区域">
          <h2>视频 ({videos.length})</h2>
          <ul
            data-testid="video-list"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {videos.map((video) => (
              <li
                key={video.id}
                data-testid={`video-${video.id}`}
                style={{ borderBottom: '1px solid #eee' }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`播放 ${video.originalFilename}`}
                  onClick={() => setSelectedVideoId(selectedVideoId === video.id ? null : video.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setSelectedVideoId(selectedVideoId === video.id ? null : video.id);
                    }
                  }}
                  style={{
                    padding: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <span aria-label="视频图标" role="img">🎬</span>
                  <div>
                    <div>{video.originalFilename}</div>
                    <div style={{ fontSize: '0.85rem', color: '#999' }}>
                      {formatFileSize(video.fileSize)}
                    </div>
                  </div>
                </div>
                {selectedVideoId === video.id && (
                  <div style={{ padding: '0 12px 12px' }}>
                    <VideoPlayer
                      videoUrl={`/api/media/${video.id}/original`}
                      mimeType={video.mimeType}
                      onClose={() => setSelectedVideoId(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {images.length === 0 && videos.length === 0 && (
        <div aria-label="空状态" style={{ textAlign: 'center', padding: '48px', color: '#999' }}>
          这次旅行还没有素材，快去上传吧！
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          images={images.map((img) => ({
            originalUrl: img.originalUrl,
            alt: img.item.originalFilename,
          }))}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
          onNext={() => setLightboxIndex((i) => (i !== null && i < images.length - 1 ? i + 1 : i))}
        />
      )}

      {/* Edit Trip Info Modal */}
      {editModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="编辑旅行信息"
          data-testid="edit-trip-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setEditModalOpen(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', width: '90%', maxWidth: '480px' }}>
            <h2 style={{ marginTop: 0 }}>编辑旅行信息</h2>
            <form onSubmit={handleEditSubmit}>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="edit-title">旅行标题 *</label>
                <input
                  id="edit-title"
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  style={{ display: 'block', width: '100%', padding: '8px', boxSizing: 'border-box' }}
                  required
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="edit-description">旅行说明</label>
                <textarea
                  id="edit-description"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  style={{ display: 'block', width: '100%', padding: '8px', boxSizing: 'border-box', minHeight: '80px' }}
                />
              </div>
              {editError && <p role="alert" style={{ color: 'red' }}>{editError}</p>}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setEditModalOpen(false)} data-testid="edit-cancel-btn">取消</button>
                <button type="submit" disabled={editTitle.trim().length === 0 || editSaving} data-testid="edit-save-btn">
                  {editSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Cover Image Picker Modal */}
      {coverPickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="选择封面图"
          data-testid="cover-picker-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setCoverPickerOpen(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', width: '90%', maxWidth: '600px', maxHeight: '80vh', overflow: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>选择封面图</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
              {images.map((img) => (
                <button
                  key={img.item.id}
                  onClick={() => handleSetCover(img.item.id)}
                  disabled={coverSaving}
                  data-testid={`cover-pick-${img.item.id}`}
                  aria-label={`设为封面 ${img.item.originalFilename}`}
                  style={{
                    padding: 0, border: trip.coverImageId === img.item.id ? '3px solid #4a90d9' : '2px solid transparent',
                    borderRadius: '4px', cursor: 'pointer', background: 'none', overflow: 'hidden',
                  }}
                >
                  <img src={img.thumbnailUrl} alt={img.item.originalFilename} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                </button>
              ))}
            </div>
            <div style={{ marginTop: '12px', textAlign: 'right' }}>
              <button onClick={() => setCoverPickerOpen(false)} data-testid="cover-cancel-btn">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Default Image Picker Modal */}
      {defaultPickerGroupId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="选择默认展示图"
          data-testid="default-picker-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setDefaultPickerGroupId(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', width: '90%', maxWidth: '600px', maxHeight: '80vh', overflow: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>选择默认展示图</h2>
            {defaultPickerImages.length === 0 ? (
              <p>加载中...</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
                {defaultPickerImages.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => handleSetDefault(defaultPickerGroupId, img.id)}
                    disabled={defaultSaving}
                    data-testid={`default-pick-${img.id}`}
                    aria-label={`设为默认展示图 ${img.originalFilename}`}
                    style={{
                      padding: 0, border: '2px solid transparent',
                      borderRadius: '4px', cursor: 'pointer', background: 'none', overflow: 'hidden',
                    }}
                  >
                    <img src={img.thumbnailUrl} alt={img.originalFilename} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: '12px', textAlign: 'right' }}>
              <button onClick={() => setDefaultPickerGroupId(null)} data-testid="default-cancel-btn">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
