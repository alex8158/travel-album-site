import { useState, useEffect, useRef, useCallback, useMemo, FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import Lightbox from '../components/Lightbox';
import ImageEditor from '../components/ImageEditor';
import VideoPlayer from '../components/VideoPlayer';
import ClipEditor from '../components/ClipEditor';
import FileUploader from '../components/FileUploader';
import ProcessTrigger from '../components/ProcessTrigger';
import type { ProcessResult } from '../components/ProcessTrigger';
import ProcessingLog from '../components/ProcessingLog';
import { useAuth, authFetch } from '../contexts/AuthContext';
import { updateCategory } from '../api';
import type {
  GalleryData,
  TrashedItem,
  AppendMode,
} from './GalleryPage';

type CategoryTab = 'all' | 'landscape' | 'animal' | 'people' | 'other';

const CATEGORY_LABELS: Record<CategoryTab, string> = {
  all: '全部',
  landscape: '风景',
  animal: '动物',
  people: '人物',
  other: '其他',
};

const CATEGORY_TABS: CategoryTab[] = ['all', 'landscape', 'animal', 'people', 'other'];

const TRASHED_REASON_MAP: Record<string, string> = {
  blur: '模糊',
  duplicate: '重复',
  manual: '手动',
};

interface GroupMemberImage {
  id: string;
  originalFilename: string;
  thumbnailUrl: string;
}

export default function MyGalleryPage() {
  const { id } = useParams<{ id: string }>();
  const { user, isLoggedIn } = useAuth();
  const [data, setData] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
  const [clipEditorVideoId, setClipEditorVideoId] = useState<string | null>(null);

  // Append media state
  const [appendMode, setAppendMode] = useState<AppendMode>('idle');
  const [showAppend, setShowAppend] = useState(false);
  const appendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appendUploadCount, setAppendUploadCount] = useState(0);
  const [appendProcessResult, setAppendProcessResult] = useState<ProcessResult | null>(null);
  const [showAppendProcessingLog, setShowAppendProcessingLog] = useState(false);

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

  // Trash zone state
  const [trashedItems, setTrashedItems] = useState<TrashedItem[]>([]);

  // Multi-select mode state
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  // Category filter state
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');

  // Category picker state (single image)
  const [categoryPickerMediaId, setCategoryPickerMediaId] = useState<string | null>(null);
  // Batch category picker state
  const [batchCategoryPickerOpen, setBatchCategoryPickerOpen] = useState(false);
  const [batchCategoryChanging, setBatchCategoryChanging] = useState(false);

  async function fetchGallery() {
    if (!id) return;
    try {
      const res = await authFetch(`/api/my/trips/${id}/gallery`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (res.status === 404) {
        setError('相册不存在');
        return;
      }
      if (!res.ok) {
        setError('加载相册数据失败，请稍后重试');
        return;
      }
      const json = await res.json() as GalleryData;
      setData(json);
    } catch {
      setError('加载相册数据失败，请稍后重试');
    }
  }

  async function fetchTrash() {
    if (!id) return;
    try {
      const res = await authFetch(`/api/trips/${id}/trash`);
      if (res.ok) {
        const json = await res.json() as TrashedItem[];
        setTrashedItems(json);
      }
    } catch {
      // silently fail - trash zone is supplementary
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

  const handleAllUploaded = useCallback((count: number) => {
    setAppendUploadCount(count);
    setAppendMode('processing');
  }, []);

  const handleAppendProcessed = useCallback(async (_result: ProcessResult) => {
    setAppendProcessResult(_result);
    setShowAppendProcessingLog(true);
  }, []);

  const handleAppendProcessingLogClose = useCallback(async () => {
    setShowAppendProcessingLog(false);
    await fetchGallery();
    await fetchTrash();
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
        const res = await authFetch(`/api/my/trips/${id}/gallery`);
        if (cancelled) return;
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (res.status === 404) {
          setError('相册不存在');
          return;
        }
        if (!res.ok) {
          setError('加载相册数据失败，请稍后重试');
          return;
        }
        const json = await res.json() as GalleryData;
        console.log('[MyGalleryPage] gallery data:', JSON.stringify(json).slice(0, 500));
        setData(json);
      } catch {
        if (!cancelled) setError('加载相册数据失败，请稍后重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    async function loadTrash() {
      try {
        const res = await authFetch(`/api/trips/${id}/trash`);
        if (!cancelled && res.ok) {
          const json = await res.json() as TrashedItem[];
          setTrashedItems(json);
        }
      } catch {
        // silently fail
      }
    }
    if (id) {
      load();
      loadTrash();
    }
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
      const res = await authFetch(`/api/trips/${data.trip.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      const resData = await res.json();
      setData({
        ...data,
        trip: { ...data.trip, title: resData.title, description: resData.description, updatedAt: resData.updatedAt },
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
      await authFetch(`/api/trips/${data.trip.id}/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId }),
      });
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
      const res = await authFetch(`/api/duplicate-groups/${groupId}/images`);
      if (res.ok) {
        const json = await res.json() as { images: GroupMemberImage[] };
        setDefaultPickerImages(json.images);
      } else {
        setDefaultPickerGroupId(null);
      }
    } catch {
      setDefaultPickerGroupId(null);
    }
  }

  async function handleSetDefault(groupId: string, imageId: string) {
    setDefaultSaving(true);
    try {
      await authFetch(`/api/duplicate-groups/${groupId}/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId }),
      });
      await fetchGallery();
      setDefaultPickerGroupId(null);
    } catch {
      // user can retry
    } finally {
      setDefaultSaving(false);
    }
  }

  // --- Trash zone handlers ---
  async function handleRestore(mediaId: string) {
    try {
      await authFetch(`/api/media/${mediaId}/restore`, { method: 'PUT' });
      await fetchGallery();
      await fetchTrash();
    } catch {
      // user can retry
    }
  }

  async function handleClearTrash() {
    if (!id) return;
    if (!window.confirm('确定要永久删除待删除区中的所有文件吗？此操作不可撤销。')) return;
    try {
      await authFetch(`/api/trips/${id}/trash`, { method: 'DELETE' });
      await fetchGallery();
      await fetchTrash();
    } catch {
      // user can retry
    }
  }

  // --- Multi-select handlers ---
  function toggleSelect(mediaId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }

  function exitMultiSelect() {
    setMultiSelectMode(false);
    setSelectedIds(new Set());
  }

  async function handleBatchDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`确定要删除选中的 ${selectedIds.size} 个素材吗？`)) return;
    setBatchDeleting(true);
    try {
      const res = await authFetch(`/api/trips/${id}/media/trash`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: [...selectedIds] }),
      });
      if (!res.ok) throw new Error('batch delete failed');
      exitMultiSelect();
      await fetchGallery();
      await fetchTrash();
    } catch {
      // keep selection on failure so user can retry
    } finally {
      setBatchDeleting(false);
    }
  }

  // --- Single delete handler ---
  async function handleSingleDelete(mediaId: string) {
    if (!window.confirm('确定要删除这张图片吗？')) return;
    try {
      const res = await authFetch(`/api/trips/${id}/media/trash`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: [mediaId] }),
      });
      if (!res.ok) throw new Error('delete failed');
      await fetchGallery();
      await fetchTrash();
    } catch {
      // keep image in place on failure
    }
  }

  // --- Single category change handler ---
  async function handleCategoryChange(mediaId: string, newCategory: string) {
    if (!data) return;
    const img = data.images.find(i => i.item.id === mediaId);
    if (!img) return;
    const oldCategory = img.item.category;
    if (oldCategory === newCategory) {
      setCategoryPickerMediaId(null);
      return;
    }
    // Optimistic update
    setData({
      ...data,
      images: data.images.map(i =>
        i.item.id === mediaId ? { ...i, item: { ...i.item, category: newCategory } } : i
      ),
    });
    setCategoryPickerMediaId(null);
    try {
      const res = await updateCategory(mediaId, newCategory);
      if (!res.ok) throw new Error('category update failed');
    } catch {
      // Revert on failure
      setData(prev => prev ? {
        ...prev,
        images: prev.images.map(i =>
          i.item.id === mediaId ? { ...i, item: { ...i.item, category: oldCategory } } : i
        ),
      } : prev);
    }
  }

  // --- Batch category change handler ---
  async function handleBatchCategoryChange(newCategory: string) {
    if (!data || selectedIds.size === 0) return;
    setBatchCategoryChanging(true);
    setBatchCategoryPickerOpen(false);
    const results = await Promise.allSettled(
      [...selectedIds].map(mediaId => updateCategory(mediaId, newCategory).then(res => {
        if (!res.ok) throw new Error('failed');
        return mediaId;
      }))
    );
    const succeeded = results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value);
    const failedCount = results.filter(r => r.status === 'rejected').length;
    if (succeeded.length > 0) {
      setData(prev => prev ? {
        ...prev,
        images: prev.images.map(i =>
          succeeded.includes(i.item.id) ? { ...i, item: { ...i.item, category: newCategory } } : i
        ),
      } : prev);
    }
    if (failedCount > 0) {
      alert(`${failedCount} 个素材分类更换失败`);
    } else {
      exitMultiSelect();
    }
    setBatchCategoryChanging(false);
  }

  // --- Hooks must be called before any conditional returns (React rules of hooks) ---
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

  // --- Permission check ---
  if (!isLoggedIn || !user) {
    return <div role="alert">请先登录</div>;
  }

  if (loading) {
    return <div role="status" aria-label="加载中">加载中...</div>;
  }

  if (forbidden) {
    return (
      <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto', textAlign: 'center' }}>
        <p role="alert" style={{ fontSize: '1.25rem', color: '#666', marginTop: '48px' }}>无权访问此相册</p>
        <Link to="/my" style={{ display: 'inline-block', marginTop: '16px' }}>
          ← 返回我的空间
        </Link>
      </div>
    );
  }

  if (error) {
    return <div role="alert">{error}</div>;
  }

  if (!data) {
    return <div role="alert">未找到相册数据</div>;
  }

  const trip = data!.trip;

  return (
    <div style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto' }}>
      <Link to="/my" style={{ display: 'inline-block', marginBottom: '16px' }}>
        ← 返回我的空间
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
          <button
            onClick={handleAppendClick}
            aria-label="追加素材"
            data-testid="append-media-btn"
            style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer' }}
          >
            ➕ 追加素材
          </button>
          {!multiSelectMode && (images.length > 0 || videos.length > 0) && (
            <button
              onClick={() => setMultiSelectMode(true)}
              aria-label="选择"
              data-testid="multi-select-btn"
              style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer' }}
            >
              ☑️ 选择
            </button>
          )}
          {multiSelectMode && (
            <button
              onClick={exitMultiSelect}
              aria-label="取消选择"
              data-testid="multi-select-cancel-btn"
              style={{ background: 'none', border: '1px solid #e74c3c', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer', color: '#e74c3c' }}
            >
              取消
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

      {/* Unprocessed media banner */}
      {!showAppend && appendMode !== 'processing' && (() => {
        const unprocessedImages = images.filter(img => img.item.category == null && img.item.avgBrightness == null);
        const hasUnprocessed = unprocessedImages.length > 0;
        if (!hasUnprocessed) return null;
        return (
          <div style={{ border: '1px solid #f0ad4e', borderRadius: '8px', padding: '12px', marginBottom: '16px', background: '#fcf8e3' }}>
            <p style={{ margin: 0 }}>有 {unprocessedImages.length} 个素材尚未处理。</p>
            <button
              onClick={() => { setShowAppend(true); setAppendMode('processing'); }}
              style={{ marginTop: '8px' }}
            >
              开始处理
            </button>
          </div>
        );
      })()}

      {/* Append Media Area */}
      {showAppend && (
        <div data-testid="append-area" style={{ border: '1px solid #ddd', borderRadius: '8px', padding: '16px', marginBottom: '16px', background: '#fafafa' }}>
          {appendMode === 'uploading' && (
            <>
              <FileUploader tripId={id!} onAllUploaded={handleAllUploaded} onVideoUploaded={(mediaId, mediaType) => {
                console.log(`[MyGalleryPage] Video ${mediaId} (${mediaType}) uploaded, processing triggered`);
              }} onUploadCancelled={(completedCount) => {
                setAppendUploadCount(completedCount);
                if (completedCount > 0) {
                  setAppendMode('cancelled');
                }
              }} />
              <button
                onClick={handleAppendCancel}
                data-testid="append-cancel-btn"
                style={{ marginTop: '8px' }}
              >
                取消
              </button>
            </>
          )}
          {appendMode === 'cancelled' && (
            <div>
              <p>上传已取消，已成功上传 {appendUploadCount} 个文件。</p>
              <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                <button onClick={() => setAppendMode('processing')}>
                  处理已上传的素材
                </button>
                <button onClick={() => { setShowAppend(false); setAppendMode('idle'); }}>
                  稍后处理
                </button>
              </div>
            </div>
          )}
          {appendMode === 'processing' && (
            <>
              <p style={{ marginBottom: '8px' }}>开始处理</p>
              <ProcessTrigger tripId={id!} autoStart={true} onProcessed={handleAppendProcessed} />
            </>
          )}
          {appendMode === 'done' && (
            <p data-testid="append-done-msg" style={{ color: 'green', fontWeight: 'bold' }}>追加完成</p>
          )}
        </div>
      )}

      {showAppendProcessingLog && appendProcessResult && (
        <ProcessingLog
          uploadCount={appendUploadCount}
          result={appendProcessResult}
          onClose={handleAppendProcessingLogClose}
        />
      )}

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
                  onClick={() => multiSelectMode ? toggleSelect(img.item.id) : setLightboxIndex(idx)}
                  role="button"
                  tabIndex={0}
                  aria-label={multiSelectMode ? `选择 ${img.item.originalFilename}` : `查看 ${img.item.originalFilename}`}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') multiSelectMode ? toggleSelect(img.item.id) : setLightboxIndex(idx); }}
                >
                  <img
                    src={img.thumbnailUrl}
                    alt={img.item.originalFilename}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                  />
                </div>
                {multiSelectMode && (
                  <div
                    data-testid={`select-checkbox-${img.item.id}`}
                    onClick={() => toggleSelect(img.item.id)}
                    style={{
                      position: 'absolute',
                      top: '6px',
                      left: '6px',
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: '2px solid #fff',
                      background: selectedIds.has(img.item.id) ? '#4a90d9' : 'rgba(0,0,0,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: '#fff',
                      fontSize: '14px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    }}
                    role="checkbox"
                    aria-checked={selectedIds.has(img.item.id)}
                    aria-label={`选中 ${img.item.originalFilename}`}
                  >
                    {selectedIds.has(img.item.id) ? '✓' : ''}
                  </div>
                )}
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
                {!multiSelectMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingMediaId(img.item.id); }}
                    aria-label={`编辑 ${img.item.originalFilename}`}
                    style={{
                      position: 'absolute',
                      bottom: '4px',
                      left: '4px',
                      background: 'rgba(255,255,255,0.9)',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      padding: '2px 8px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    ✏️ 编辑
                  </button>
                )}
                {!multiSelectMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSingleDelete(img.item.id); }}
                    aria-label={`删除 ${img.item.originalFilename}`}
                    data-testid={`delete-btn-${img.item.id}`}
                    style={{
                      position: 'absolute',
                      top: '4px',
                      right: '4px',
                      background: 'rgba(255,255,255,0.9)',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      padding: '2px 8px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                    }}
                  >
                    🗑️
                  </button>
                )}
                {!multiSelectMode && (
                  <div style={{ position: 'absolute', top: '4px', left: '4px' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setCategoryPickerMediaId(categoryPickerMediaId === img.item.id ? null : img.item.id);
                      }}
                      aria-label={`更换分类 ${img.item.originalFilename}`}
                      data-testid={`category-label-${img.item.id}`}
                      style={{
                        background: 'rgba(255,255,255,0.9)',
                        border: '1px solid #ccc',
                        borderRadius: '4px',
                        padding: '2px 8px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      {CATEGORY_LABELS[(img.item.category as CategoryTab) || 'other']}
                    </button>
                    {categoryPickerMediaId === img.item.id && (
                      <div
                        data-testid={`category-picker-${img.item.id}`}
                        style={{
                          position: 'absolute',
                          top: '100%',
                          left: 0,
                          background: '#fff',
                          border: '1px solid #ccc',
                          borderRadius: '4px',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                          zIndex: 10,
                          minWidth: '80px',
                        }}
                      >
                        {(['people', 'animal', 'landscape', 'other'] as const).map(cat => (
                          <button
                            key={cat}
                            onClick={(e) => { e.stopPropagation(); handleCategoryChange(img.item.id, cat); }}
                            data-testid={`category-option-${cat}-${img.item.id}`}
                            style={{
                              display: 'block',
                              width: '100%',
                              padding: '6px 12px',
                              border: 'none',
                              background: img.item.category === cat ? '#e8f0fe' : 'transparent',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: '0.8rem',
                            }}
                          >
                            {CATEGORY_LABELS[cat]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
                aria-label={multiSelectMode ? `选择 ${video.originalFilename}` : `播放 ${video.originalFilename}`}
                onClick={() => multiSelectMode ? toggleSelect(video.id) : setSelectedVideoId(video.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') multiSelectMode ? toggleSelect(video.id) : setSelectedVideoId(video.id);
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
                {!multiSelectMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setClipEditorVideoId(video.id); }}
                    data-testid={`clip-edit-btn-${video.id}`}
                    aria-label={`智能剪辑 ${video.originalFilename}`}
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
                    ✂️ 智能剪辑
                  </button>
                )}
                {multiSelectMode && (
                  <div
                    data-testid={`select-checkbox-${video.id}`}
                    onClick={(e) => { e.stopPropagation(); toggleSelect(video.id); }}
                    style={{
                      position: 'absolute',
                      top: '6px',
                      left: '6px',
                      width: '24px',
                      height: '24px',
                      borderRadius: '4px',
                      border: '2px solid #fff',
                      background: selectedIds.has(video.id) ? '#4a90d9' : 'rgba(0,0,0,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: '#fff',
                      fontSize: '14px',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    }}
                    role="checkbox"
                    aria-checked={selectedIds.has(video.id)}
                    aria-label={`选中 ${video.originalFilename}`}
                  >
                    {selectedIds.has(video.id) ? '✓' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Trash Zone */}
      {trashedItems.length > 0 && (
        <section aria-label="待删除区" data-testid="trash-zone" style={{ marginTop: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <h2>待删除区 ({trashedItems.length})</h2>
            <button
              onClick={handleClearTrash}
              data-testid="trash-clear-btn"
              style={{
                background: '#e74c3c',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 12px',
                cursor: 'pointer',
              }}
            >
              🗑️ 清空待删除区
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
            {trashedItems.map((item) => (
              <div
                key={item.id}
                style={{
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: '1px solid #f0c0c0',
                  background: '#fff5f5',
                }}
              >
                <img
                  src={item.thumbnailUrl}
                  alt={item.originalFilename}
                  style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                />
                <div style={{ padding: '8px' }}>
                  <div style={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.originalFilename}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#e74c3c', marginTop: '4px' }}>
                    原因: {item.trashedReason.split(',').map(r => TRASHED_REASON_MAP[r.trim()] || r.trim()).join('、')}
                  </div>
                  <button
                    onClick={() => handleRestore(item.id)}
                    data-testid={`trash-restore-${item.id}`}
                    style={{
                      marginTop: '8px',
                      background: 'none',
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      padding: '2px 12px',
                      cursor: 'pointer',
                      width: '100%',
                    }}
                  >
                    恢复
                  </button>
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

      {/* ClipEditor Modal */}
      {clipEditorVideoId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="智能剪辑"
          data-testid="clip-editor-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setClipEditorVideoId(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            padding: '24px',
          }}
        >
          <div style={{ width: '90%', maxWidth: '800px', maxHeight: '90vh', overflowY: 'auto' }}>
            <ClipEditor
              mediaId={clipEditorVideoId}
              tripId={id!}
              onClose={() => setClipEditorVideoId(null)}
            />
          </div>
        </div>
      )}

      {images.length === 0 && videos.length === 0 && (
        <div aria-label="空状态" style={{ textAlign: 'center', padding: '48px', color: '#999' }}>
          这次旅行还没有素材，快去上传吧！
        </div>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          images={filteredImages.map((img) => ({
            originalUrl: img.originalUrl,
            alt: img.item.originalFilename,
          }))}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
          onNext={() => setLightboxIndex((i) => (i !== null && i < filteredImages.length - 1 ? i + 1 : i))}
        />
      )}

      {/* Image Editor */}
      {editingMediaId && (() => {
        const editImg = images.find(img => img.item.id === editingMediaId);
        if (!editImg) return null;
        return (
          <ImageEditor
            mediaId={editingMediaId}
            originalUrl={`/api/media/${editingMediaId}/raw`}
            onClose={() => setEditingMediaId(null)}
            onSaved={() => { setEditingMediaId(null); fetchGallery(); }}
          />
        );
      })()}

      {/* Multi-select bottom action bar */}
      {multiSelectMode && selectedIds.size > 0 && (
        <div
          data-testid="multi-select-action-bar"
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: '#fff',
            borderTop: '1px solid #ddd',
            padding: '12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            zIndex: 999,
            boxShadow: '0 -2px 8px rgba(0,0,0,0.1)',
          }}
        >
          <span style={{ fontSize: '0.95rem' }}>已选 {selectedIds.size} 项</span>
          <div style={{ display: 'flex', gap: '8px', position: 'relative' }}>
            <button
              onClick={handleBatchDelete}
              disabled={batchDeleting || batchCategoryChanging}
              data-testid="batch-delete-btn"
              style={{
                background: '#e74c3c',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 20px',
                cursor: batchDeleting ? 'not-allowed' : 'pointer',
                fontSize: '0.95rem',
              }}
            >
              {batchDeleting ? '删除中...' : '删除选中'}
            </button>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setBatchCategoryPickerOpen(!batchCategoryPickerOpen)}
                disabled={batchCategoryChanging}
                data-testid="batch-category-btn"
                style={{
                  background: '#4a90d9',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 20px',
                  cursor: batchCategoryChanging ? 'not-allowed' : 'pointer',
                  fontSize: '0.95rem',
                }}
              >
                {batchCategoryChanging ? '更换中...' : '更换分类'}
              </button>
              {batchCategoryPickerOpen && (
                <div
                  data-testid="batch-category-picker"
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    right: 0,
                    marginBottom: '4px',
                    background: '#fff',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    zIndex: 10,
                    minWidth: '100px',
                  }}
                >
                  {(['people', 'animal', 'landscape', 'other'] as const).map(cat => (
                    <button
                      key={cat}
                      onClick={() => handleBatchCategoryChange(cat)}
                      data-testid={`batch-category-option-${cat}`}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '8px 16px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: '0.9rem',
                      }}
                    >
                      {CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
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
