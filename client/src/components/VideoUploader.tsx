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
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: blob,
        signal: abortSignal,
        headers: { 'Content-Type': 'application/octet-stream' },
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
  const [filename, setFilename] = useState('');
  const [completedParts, setCompletedParts] = useState(0);
  const [totalParts, setTotalParts] = useState(0);
  const [sizeWarning, setSizeWarning] = useState('');
  const [resumePrompt, setResumePrompt] = useState<UploadResumeData | null>(null);

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
    await fetch(url, {
      method: 'PUT',
      body: file,
      signal: controller.signal,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    // Finalize
    await authFetch(`/api/uploads/${init.mediaId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: init.uploadId }),
    });
  }, []);

  const uploadMultipart = useCallback(async (
    file: File,
    init: InitResponse,
    controller: AbortController,
    skipParts: CompletedPart[] = [],
  ) => {
    const partSize = init.partSize!;
    const total = init.totalParts!;
    setTotalParts(total);

    const alreadyDone = new Set(skipParts.map(p => p.partNumber));
    const allCompleted: CompletedPart[] = [...skipParts];
    setCompletedParts(alreadyDone.size);

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
          setCompletedParts(prev => prev + 1);

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
    await authFetch(`/api/uploads/${init.mediaId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: init.uploadId,
        parts: allCompleted.sort((a, b) => a.partNumber - b.partNumber),
      }),
    });
  }, [tripId]);

  const startUpload = useCallback(async (file: File) => {
    setError('');
    setState('uploading');
    setFilename(file.name);
    setCompletedParts(0);
    setTotalParts(0);

    // Size warnings
    if (file.size > TWENTY_GB) {
      setSizeWarning('建议在桌面端上传');
    } else if (file.size > TEN_GB) {
      setSizeWarning('建议使用稳定网络');
    } else {
      setSizeWarning('');
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
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

      if (init.mode === 'simple') {
        setTotalParts(1);
        await uploadSimple(file, init, controller);
        setCompletedParts(1);
      } else {
        await uploadMultipart(file, init, controller);
      }

      clearResumeData(init.mediaId);
      setState('completed');
      onUploaded?.(init.mediaId);

      // Auto-reset to idle after a short delay so user can upload another video
      setTimeout(() => setState('idle'), 2000);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setState('cancelled');
      } else {
        setError(err.message || '上传失败');
        setState('failed');
      }
    }
  }, [tripId, uploadSimple, uploadMultipart, onUploaded]);

  const handleResume = useCallback(async (resumeData: UploadResumeData) => {
    setResumePrompt(null);
    setState('uploading');
    setFilename(resumeData.filename);
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
    setFilename(file.name);
    setSizeWarning('');

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
        await uploadMultipart(file, init, controller, skipParts);
      } else {
        setTotalParts(1);
        await uploadSimple(file, init, controller);
        setCompletedParts(1);
      }

      clearResumeData(rd.mediaId);
      resumeDataRef.current = null;
      resumePartsRef.current = [];
      setState('completed');
      onUploaded?.(rd.mediaId);

      // Auto-reset to idle after a short delay so user can upload another video
      setTimeout(() => setState('idle'), 2000);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setState('cancelled');
      } else {
        setError(err.message || '上传失败');
        setState('failed');
      }
    }
  }, [uploadSimple, uploadMultipart, onUploaded]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (inputRef.current) inputRef.current.value = '';

    // Check if this is a resume scenario
    const rd = resumeDataRef.current;
    if (rd && file.name === rd.filename && file.size === rd.fileSize) {
      // Resume: reuse existing mediaId/uploadId and skip completed parts
      resumeUploadWithFile(file, rd, resumePartsRef.current);
    } else {
      resumeDataRef.current = null;
      resumePartsRef.current = [];
      startUpload(file);
    }
  }, [startUpload, resumeUploadWithFile]);

  const progressPercent = totalParts > 0 ? Math.round((completedParts / totalParts) * 100) : 0;

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
            onChange={handleFileSelect}
            data-testid="video-file-input"
          />
        </div>
      )}

      {/* Size warning */}
      {sizeWarning && (
        <p style={{ color: '#e65100', marginTop: '8px' }}>{sizeWarning}</p>
      )}

      {/* Progress */}
      {state === 'uploading' && (
        <div style={{ marginTop: '12px' }}>
          <p style={{ margin: '0 0 8px 0' }}>正在上传: {filename}</p>
          <div style={{
            width: '100%',
            backgroundColor: '#e0e0e0',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${progressPercent}%`,
              height: 20,
              backgroundColor: '#4caf50',
              transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span>{completedParts}/{totalParts} 分片</span>
            <span>{progressPercent}%</span>
          </div>
          <button onClick={doAbort} style={{ marginTop: '8px' }}>取消上传</button>
        </div>
      )}

      {/* Completed */}
      {state === 'completed' && (
        <p style={{ color: '#2e7d32', marginTop: '8px' }}>✓ {filename} 上传完成</p>
      )}

      {/* Failed */}
      {state === 'failed' && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ color: 'red' }}>上传失败: {error}</p>
          <button onClick={() => setState('idle')}>重新选择</button>
        </div>
      )}

      {/* Cancelled */}
      {state === 'cancelled' && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ color: '#e65100' }}>上传已取消</p>
          <button onClick={() => setState('idle')}>重新选择</button>
        </div>
      )}

      {/* Error display for idle state */}
      {state === 'idle' && error && (
        <p style={{ color: '#e65100', marginTop: '8px' }}>{error}</p>
      )}
    </div>
  );
}
