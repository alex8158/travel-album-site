import { useState, useRef, useCallback, useEffect } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface VideoUploaderProps {
  tripId: string;
  onUploaded?: (mediaId: string) => void;
  onCancelled?: () => void;
}

interface InitResponse {
  mediaId: string;
  storageKey: string;
  mode: 'simple' | 'multipart';
  uploadId: string;
  presignedUrl?: string;
  partSize?: number;
  totalParts?: number;
}

interface PartInfo {
  partNumber: number;
  url: string;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadResumeData {
  mediaId: string;
  uploadId: string;
  tripId: string;
  filename: string;
  fileSize: number;
  mode: 'simple' | 'multipart';
  storageKey: string;
  partSize: number;
  totalParts: number;
  completedParts: CompletedPart[];
  createdAt: number;
}

type FileUploadStatus = 'queued' | 'uploading' | 'completed' | 'failed';

interface QueuedFile {
  file: File;
  status: FileUploadStatus;
  error?: string;
  completedParts: number;
  totalParts: number;
  mediaId?: string;
}

type UploadState = 'idle' | 'uploading' | 'completed' | 'failed' | 'cancelled';

const VIDEO_ACCEPT = '.mp4,.mov,.avi,.mkv';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const CONCURRENCY = 4;
const TEN_GB = 10 * 1024 * 1024 * 1024;
const TWENTY_GB = 20 * 1024 * 1024 * 1024;

function getResumeKey(mediaId: string) {
  return `upload_resume_${mediaId}`;
}

function saveResumeData(data: UploadResumeData) {
  try {
    localStorage.setItem(getResumeKey(data.mediaId), JSON.stringify(data));
  } catch { /* ignore quota errors */ }
}

export function loadResumeData(mediaId: string): UploadResumeData | null {
  try {
    const raw = localStorage.getItem(getResumeKey(mediaId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearResumeData(mediaId: string) {
  try { localStorage.removeItem(getResumeKey(mediaId)); } catch { /* */ }
}

function findIncompleteUploads(tripId: string): UploadResumeData[] {
  const results: UploadResumeData[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('upload_resume_')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const data: UploadResumeData = JSON.parse(raw);
          if (data.tripId === tripId && data.completedParts.length < data.totalParts) {
            results.push(data);
          }
        }
      }
    }
  } catch { /* */ }
  return results;
}

async function uploadPartWithRetry(
  url: string,
  blob: Blob,
  abortSignal: AbortSignal,
): Promise<string> {
  // Get auth token for local storage relay endpoints
  const token = localStorage.getItem('auth_token');
  const headers: Record<string, string> = {};
  // Only set Content-Type for local storage relay (server endpoints), not for S3 presigned URLs
  if (url.startsWith('/api/')) {
    headers['Content-Type'] = 'application/octet-stream';
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: blob,
        signal: abortSignal,
        headers,
      });
      if (!res.ok) throw new Error(`Part upload failed: ${res.status}`);
      const etag = res.headers.get('etag') || res.headers.get('ETag');
      if (etag) return etag.replace(/"/g, '');
      // Try to get etag from JSON body (local storage relay)
      try {
        const body = await res.clone().json();
        if (body.etag) return body.etag;
      } catch { /* not json */ }
      return '';
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError || new Error('Part upload failed after retries');
}

export default function VideoUploader({ tripId, onUploaded, onCancelled }: VideoUploaderProps) {
  const [state, setState] = useState<UploadState>('idle');
  const [error, setError] = useState<string>('');
  const [sizeWarning, setSizeWarning] = useState('');
  const [resumePrompt, setResumePrompt] = useState<UploadResumeData | null>(null);

  // Multi-file queue
  const [fileQueue, setFileQueue] = useState<QueuedFile[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mediaIdRef = useRef<string>('');
  const uploadIdRef = useRef<string>('');
  const resumePartsRef = useRef<CompletedPart[]>([]);
  const resumeDataRef = useRef<UploadResumeData | null>(null);

  // Check for incomplete uploads on mount
  useEffect(() => {
    const incomplete = findIncompleteUploads(tripId);
    if (incomplete.length > 0) {
      setResumePrompt(incomplete[0]);
    }
  }, [tripId]);

  const doAbort = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const mid = mediaIdRef.current;
    const uid = uploadIdRef.current;
    if (mid && uid) {
      try {
        await authFetch(`/api/uploads/${mid}/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: uid }),
        });
      } catch { /* best effort */ }
      clearResumeData(mid);
    }
    setState('cancelled');
    onCancelled?.();
  }, [onCancelled]);

  const uploadSimple = useCallback(async (
    file: File, init: InitResponse, controller: AbortController
  ) => {
    const url = init.presignedUrl!;
    // For local storage relay, need auth token
    const token = localStorage.getItem('auth_token');
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token && url.startsWith('/api/')) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const putRes = await fetch(url, {
      method: 'PUT',
      body: file,
      signal: controller.signal,
      headers,
    });
    if (!putRes.ok) {
      throw new Error(`Simple upload failed: ${putRes.status}`);
    }
    // Finalize
    const finalizeRes = await authFetch(`/api/uploads/${init.mediaId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: init.uploadId }),
    });
    if (!finalizeRes.ok) {
      const body = await finalizeRes.json().catch(() => ({}));
      throw new Error(body.error?.message || `Finalize failed: ${finalizeRes.status}`);
    }
  }, []);

  const uploadMultipart = useCallback(async (
    file: File,
    init: InitResponse,
    controller: AbortController,
    skipParts: CompletedPart[] = [],
    onPartComplete?: () => void,
  ) => {
    const partSize = init.partSize!;
    const total = init.totalParts!;

    const alreadyDone = new Set(skipParts.map(p => p.partNumber));
    const allCompleted: CompletedPart[] = [...skipParts];

    // Save initial resume data
    const resumeData: UploadResumeData = {
      mediaId: init.mediaId,
      uploadId: init.uploadId,
      tripId,
      filename: file.name,
      fileSize: file.size,
      mode: 'multipart',
      storageKey: init.storageKey,
      partSize,
      totalParts: total,
      completedParts: [...skipParts],
      createdAt: Date.now(),
    };
    saveResumeData(resumeData);

    // Build list of parts to upload
    const partsToUpload: number[] = [];
    for (let i = 1; i <= total; i++) {
      if (!alreadyDone.has(i)) partsToUpload.push(i);
    }

    // Batch presign and upload with concurrency
    const batchSize = 10;
    for (let batchStart = 0; batchStart < partsToUpload.length; batchStart += batchSize) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const batch = partsToUpload.slice(batchStart, batchStart + batchSize);
      // Get presigned URLs for this batch
      const presignRes = await authFetch(`/api/uploads/${init.mediaId}/parts/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: init.uploadId, partNumbers: batch }),
      });
      if (!presignRes.ok) throw new Error(`Presign failed: ${presignRes.status}`);
      const presignData = await presignRes.json();
      const parts: PartInfo[] = presignData.parts;

      // Upload parts concurrently
      let cursor = 0;
      const worker = async () => {
        while (cursor < parts.length) {
          if (controller.signal.aborted) return;
          const idx = cursor++;
          const part = parts[idx];
          const start = (part.partNumber - 1) * partSize;
          const end = Math.min(start + partSize, file.size);
          const blob = file.slice(start, end);

          const etag = await uploadPartWithRetry(part.url, blob, controller.signal);
          const completed: CompletedPart = { partNumber: part.partNumber, etag };
          allCompleted.push(completed);
          onPartComplete?.();

          // Update resume data
          resumeData.completedParts = [...allCompleted];
          saveResumeData(resumeData);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, parts.length) }, () => worker())
      );
    }

    // Complete
    const completeRes = await authFetch(`/api/uploads/${init.mediaId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: init.uploadId,
        parts: allCompleted.sort((a, b) => a.partNumber - b.partNumber),
      }),
    });
    if (!completeRes.ok) {
      const body = await completeRes.json().catch(() => ({}));
      throw new Error(body.error?.message || `Complete failed: ${completeRes.status}`);
    }
  }, [tripId]);

  // Fire-and-forget process call after each upload
  const triggerProcess = useCallback((mediaId: string) => {
    authFetch(`/api/media/${mediaId}/process`, { method: 'POST' })
      .then(res => {
        if (!res.ok) console.error(`[VideoUploader] process trigger failed for ${mediaId}: ${res.status}`);
      })
      .catch(err => {
        console.error(`[VideoUploader] process trigger error for ${mediaId}:`, err);
      });
  }, []);

  const uploadSingleFile = useCallback(async (
    file: File,
    queueIndex: number,
    controller: AbortController,
  ): Promise<string | null> => {
    // Update queue status to uploading
    setFileQueue(prev => prev.map((q, i) => i === queueIndex ? { ...q, status: 'uploading' as const } : q));

    try {
      console.log(`[VideoUploader] Starting upload for ${file.name} (${file.size} bytes) to trip ${tripId}`);
      // Init upload
      const initRes = await authFetch('/api/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileSize: file.size, tripId }),
      });
      if (!initRes.ok) {
        const body = await initRes.json().catch(() => ({}));
        throw new Error(body.error?.message || body.message || `Init failed: ${initRes.status}`);
      }
      const init: InitResponse = await initRes.json();
      mediaIdRef.current = init.mediaId;
      uploadIdRef.current = init.uploadId;

      setFileQueue(prev => prev.map((q, i) =>
        i === queueIndex ? { ...q, mediaId: init.mediaId, totalParts: init.mode === 'simple' ? 1 : (init.totalParts || 0) } : q
      ));

      if (init.mode === 'simple') {
        await uploadSimple(file, init, controller);
        setFileQueue(prev => prev.map((q, i) => i === queueIndex ? { ...q, completedParts: 1 } : q));
      } else {
        await uploadMultipart(file, init, controller, [], () => {
          setFileQueue(prev => prev.map((q, i) => i === queueIndex ? { ...q, completedParts: q.completedParts + 1 } : q));
        });
      }

      clearResumeData(init.mediaId);
      setFileQueue(prev => prev.map((q, i) => i === queueIndex ? { ...q, status: 'completed' as const } : q));
      onUploaded?.(init.mediaId);

      return init.mediaId;
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      setFileQueue(prev => prev.map((q, i) =>
        i === queueIndex ? { ...q, status: 'failed' as const, error: err.message || '上传失败' } : q
      ));
      return null;
    }
  }, [tripId, uploadSimple, uploadMultipart, onUploaded]);

  const startQueueUpload = useCallback(async (files: File[]) => {
    setError('');
    setState('uploading');

    const queue: QueuedFile[] = files.map(f => ({
      file: f,
      status: 'queued' as const,
      completedParts: 0,
      totalParts: 0,
    }));
    setFileQueue(queue);

    // Size warnings
    const maxSize = Math.max(...files.map(f => f.size));
    if (maxSize > TWENTY_GB) {
      setSizeWarning('建议在桌面端上传');
    } else if (maxSize > TEN_GB) {
      setSizeWarning('建议使用稳定网络');
    } else {
      setSizeWarning('');
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const mediaId = await uploadSingleFile(files[i], i, controller);
        // Fire-and-forget process call after each successful upload
        if (mediaId) {
          triggerProcess(mediaId);
        }
      }

      setState('completed');
      // Auto-reset to idle after a short delay
      setTimeout(() => {
        setState('idle');
        setFileQueue([]);
      }, 2000);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setState('cancelled');
      } else {
        setError(err.message || '上传失败');
        setState('failed');
      }
    }
  }, [uploadSingleFile, triggerProcess]);

  const handleResume = useCallback(async (resumeData: UploadResumeData) => {
    setResumePrompt(null);
    setState('uploading');
    setError('');
    setSizeWarning('');

    const controller = new AbortController();
    abortRef.current = controller;
    mediaIdRef.current = resumeData.mediaId;
    uploadIdRef.current = resumeData.uploadId;

    try {
      // Verify server state
      const statusRes = await authFetch(`/api/uploads/${resumeData.mediaId}/status`);
      if (!statusRes.ok) {
        clearResumeData(resumeData.mediaId);
        throw new Error('上传会话已失效，请重新上传');
      }
      const status = await statusRes.json();
      if (status.status !== 'uploading' && status.status !== 'active') {
        clearResumeData(resumeData.mediaId);
        throw new Error('上传会话已失效，请重新上传');
      }

      // Use server-side uploaded parts as source of truth
      const serverParts: CompletedPart[] = (status.uploadedParts || []).map((p: any) => ({
        partNumber: p.partNumber,
        etag: p.etag,
      }));

      // Store resume info for when file is re-selected
      resumePartsRef.current = serverParts;
      resumeDataRef.current = resumeData;

      // Need the file again — prompt user to re-select
      setError('请重新选择文件以继续上传: ' + resumeData.filename);
      setState('idle');
    } catch (err: any) {
      setError(err.message || '恢复上传失败');
      setState('failed');
    }
  }, []);

  const handleDismissResume = useCallback(() => {
    if (resumePrompt) {
      clearResumeData(resumePrompt.mediaId);
      setResumePrompt(null);
    }
  }, [resumePrompt]);

  const resumeUploadWithFile = useCallback(async (
    file: File,
    rd: UploadResumeData,
    skipParts: CompletedPart[],
  ) => {
    setError('');
    setState('uploading');
    setSizeWarning('');

    const queue: QueuedFile[] = [{
      file,
      status: 'uploading',
      completedParts: skipParts.length,
      totalParts: rd.totalParts,
      mediaId: rd.mediaId,
    }];
    setFileQueue(queue);

    const controller = new AbortController();
    abortRef.current = controller;
    mediaIdRef.current = rd.mediaId;
    uploadIdRef.current = rd.uploadId;

    try {
      const init: InitResponse = {
        mediaId: rd.mediaId,
        storageKey: rd.storageKey,
        mode: rd.mode,
        uploadId: rd.uploadId,
        partSize: rd.partSize,
        totalParts: rd.totalParts,
      };

      if (init.mode === 'multipart') {
        await uploadMultipart(file, init, controller, skipParts, () => {
          setFileQueue(prev => prev.map((q, i) => i === 0 ? { ...q, completedParts: q.completedParts + 1 } : q));
        });
      } else {
        await uploadSimple(file, init, controller);
        setFileQueue(prev => prev.map((q, i) => i === 0 ? { ...q, completedParts: 1 } : q));
      }

      clearResumeData(rd.mediaId);
      resumeDataRef.current = null;
      resumePartsRef.current = [];
      setFileQueue(prev => prev.map((q, i) => i === 0 ? { ...q, status: 'completed' as const } : q));
      setState('completed');
      onUploaded?.(rd.mediaId);
      triggerProcess(rd.mediaId);

      // Auto-reset to idle after a short delay
      setTimeout(() => {
        setState('idle');
        setFileQueue([]);
      }, 2000);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setState('cancelled');
      } else {
        setError(err.message || '上传失败');
        setState('failed');
      }
    }
  }, [uploadSimple, uploadMultipart, onUploaded, triggerProcess]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (inputRef.current) inputRef.current.value = '';

    const fileArray = Array.from(files);

    // Check if this is a resume scenario (single file matching resume data)
    const rd = resumeDataRef.current;
    if (rd && fileArray.length === 1 && fileArray[0].name === rd.filename && fileArray[0].size === rd.fileSize) {
      resumeUploadWithFile(fileArray[0], rd, resumePartsRef.current);
    } else {
      resumeDataRef.current = null;
      resumePartsRef.current = [];
      startQueueUpload(fileArray);
    }
  }, [startQueueUpload, resumeUploadWithFile]);

  return (
    <div style={{ marginTop: '12px' }}>
      {/* Resume prompt */}
      {resumePrompt && state === 'idle' && (
        <div style={{
          padding: '12px',
          border: '1px solid #ffa726',
          borderRadius: '6px',
          backgroundColor: '#fff3e0',
          marginBottom: '12px',
        }}>
          <p style={{ margin: '0 0 8px 0' }}>
            发现未完成的上传: <strong>{resumePrompt.filename}</strong>
            ({resumePrompt.completedParts.length}/{resumePrompt.totalParts} 分片已完成)
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => handleResume(resumePrompt)}>恢复上传</button>
            <button onClick={handleDismissResume}>放弃</button>
          </div>
        </div>
      )}

      {/* File input */}
      {state === 'idle' && (
        <div>
          <input
            ref={inputRef}
            type="file"
            accept={VIDEO_ACCEPT}
            multiple
            onChange={handleFileSelect}
            data-testid="video-file-input"
          />
        </div>
      )}

      {/* Size warning */}
      {sizeWarning && (
        <p style={{ color: '#e65100', marginTop: '8px' }}>{sizeWarning}</p>
      )}

      {/* File queue list */}
      {fileQueue.length > 0 && state === 'uploading' && (
        <div style={{ marginTop: '12px' }}>
          {fileQueue.map((qf, idx) => {
            const percent = qf.totalParts > 0 ? Math.round((qf.completedParts / qf.totalParts) * 100) : 0;
            return (
              <div key={idx} style={{ marginBottom: '10px', padding: '8px', border: '1px solid #eee', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: qf.status === 'uploading' ? 'bold' : 'normal' }}>
                    {qf.file.name}
                  </span>
                  <span style={{
                    fontSize: '0.75rem',
                    color: qf.status === 'completed' ? '#2e7d32' : qf.status === 'failed' ? 'red' : qf.status === 'uploading' ? '#1565c0' : '#999',
                  }}>
                    {qf.status === 'queued' && '排队中'}
                    {qf.status === 'uploading' && `上传中 ${percent}%`}
                    {qf.status === 'completed' && '✓ 完成'}
                    {qf.status === 'failed' && `✗ 失败: ${qf.error}`}
                  </span>
                </div>
                {qf.status === 'uploading' && qf.totalParts > 0 && (
                  <div style={{ width: '100%', backgroundColor: '#e0e0e0', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      width: `${percent}%`,
                      height: 12,
                      backgroundColor: '#4caf50',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={doAbort} style={{ marginTop: '8px' }}>取消上传</button>
        </div>
      )}

      {/* Completed */}
      {state === 'completed' && (
        <p style={{ color: '#2e7d32', marginTop: '8px' }}>
          ✓ {fileQueue.length > 1 ? `${fileQueue.length} 个视频` : fileQueue[0]?.file.name} 上传完成，已自动触发处理
        </p>
      )}

      {/* Failed */}
      {state === 'failed' && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ color: 'red' }}>上传失败: {error}</p>
          <button onClick={() => { setState('idle'); setFileQueue([]); }}>重新选择</button>
        </div>
      )}

      {/* Cancelled */}
      {state === 'cancelled' && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ color: '#e65100' }}>上传已取消</p>
          <button onClick={() => { setState('idle'); setFileQueue([]); }}>重新选择</button>
        </div>
      )}

      {/* Error display for idle state */}
      {state === 'idle' && error && (
        <p style={{ color: '#e65100', marginTop: '8px' }}>{error}</p>
      )}
    </div>
  );
}
