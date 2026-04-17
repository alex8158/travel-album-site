import { useState, useRef, useCallback } from 'react';
import { apiPost, getApiErrorMessage } from '../api';

export interface FileUploaderProps {
  tripId: string;
  onAllUploaded?: (count: number) => void;
  onVideoUploaded?: (mediaId: string, mediaType: string) => void;
  onUploadCancelled?: (completedCount: number) => void;
}

export type UploadStatus = 'pending' | 'uploading' | 'completed' | 'failed';

export interface UploadFileEntry {
  file: File;
  status: UploadStatus;
  progress: number;
  error?: string;
}

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic',
  '.mp4', '.mov', '.avi', '.mkv',
]);

export function isFormatSupported(file: File): boolean {
  if (SUPPORTED_MIME_TYPES.has(file.type)) return true;
  const ext = file.name.lastIndexOf('.') >= 0
    ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    : '';
  return SUPPORTED_EXTENSIONS.has(ext);
}

function getAuthToken(): string | null {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency = 3
): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const current = cursor++;
      await tasks[current]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
}

export default function FileUploader({ tripId, onAllUploaded, onVideoUploaded, onUploadCancelled }: FileUploaderProps) {
  const [mode, setMode] = useState<'file' | 'folder'>('file');
  const [entries, setEntries] = useState<UploadFileEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const updateEntry = useCallback((index: number, patch: Partial<UploadFileEntry>) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, ...patch } : e));
  }, []);

  const uploadFile = useCallback(async (index: number, entry: UploadFileEntry) => {
    updateEntry(index, { status: 'uploading', progress: 0, error: undefined });

    const formData = new FormData();
    formData.append('file', entry.file);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const token = getAuthToken();
      const response = await apiPost(`/api/trips/${tripId}/media`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
        onUploadProgress(progressEvent) {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            updateEntry(index, { progress: Math.min(percent, 100) });
          }
        },
      });
      updateEntry(index, { status: 'completed', progress: 100 });

      const responseData = response.data;
      if (responseData.mediaType === 'video') {
        // Fire-and-forget: trigger immediate video processing
        apiPost(`/api/media/${responseData.id}/process`, null, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).catch(err => console.error('Video processing failed:', err));
        onVideoUploaded?.(responseData.id, responseData.mediaType);
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        updateEntry(index, { status: 'failed', error: '已取消' });
      } else {
        const message = getApiErrorMessage(err) || '上传失败';
        updateEntry(index, { status: 'failed', error: message });
      }
    } finally {
      abortControllerRef.current = null;
    }
  }, [tripId, updateEntry, onVideoUploaded]);

  const doUpload = useCallback(async (fileEntries: UploadFileEntry[]) => {
    cancelledRef.current = false;
    setUploading(true);
    const tasks = fileEntries.map((item, i) => () => {
      if (cancelledRef.current) return Promise.resolve();
      if (item.status === 'pending') return uploadFile(i, item);
      return Promise.resolve();
    });
    await runWithConcurrency(tasks, 3);
    setUploading(false);
    if (!cancelledRef.current) {
      setEntries(prev => {
        const allDone = prev.length > 0 && prev.every(e => e.status === 'completed');
        if (allDone && onAllUploaded) {
          onAllUploaded(prev.length);
        }
        return prev;
      });
    }
  }, [uploadFile, onAllUploaded]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const allFiles = Array.from(files);
    const supported: UploadFileEntry[] = [];
    let skippedCount = 0;

    for (const file of allFiles) {
      if (isFormatSupported(file)) {
        supported.push({ file, status: 'pending', progress: 0 });
      } else {
        skippedCount++;
      }
    }

    const newWarnings: string[] = [];
    if (supported.length === 0 && allFiles.length > 0) {
      newWarnings.push('未找到支持格式的文件');
    } else if (skippedCount > 0) {
      newWarnings.push(`已跳过 ${skippedCount} 个不支持格式的文件`);
    }

    setWarnings(newWarnings);
    setEntries(supported);

    if (inputRef.current) inputRef.current.value = '';

    // Auto-start upload if there are supported files
    if (supported.length > 0) {
      // Use setTimeout to allow state to settle before uploading
      setTimeout(() => {
        doUpload(supported);
      }, 0);
    }
  }, [doUpload]);

  const handleRetry = useCallback(async (index: number) => {
    setUploading(true);
    await uploadFile(index, entries[index]);
    setUploading(false);
    setEntries(prev => {
      const allDone = prev.length > 0 && prev.every(e => e.status === 'completed');
      if (allDone && onAllUploaded) {
        onAllUploaded(prev.length);
      }
      return prev;
    });
  }, [entries, uploadFile, onAllUploaded]);

  const handleRetryAll = useCallback(async () => {
    cancelledRef.current = false;
    setUploading(true);
    const tasks = entries
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => entry.status === 'failed')
      .map(({ entry, i }) => () => {
        if (cancelledRef.current) return Promise.resolve();
        return uploadFile(i, entry);
      });
    await runWithConcurrency(tasks, 3);
    setUploading(false);
    setEntries(prev => {
      const allDone = prev.length > 0 && prev.every(e => e.status === 'completed');
      if (allDone && onAllUploaded) {
        onAllUploaded(prev.length);
      }
      return prev;
    });
  }, [entries, uploadFile, onAllUploaded]);

  const handleCancelAll = useCallback(() => {
    const completed = entries.filter(e => e.status === 'completed').length;
    setEntries(prev => prev.filter(e => e.status !== 'failed'));
    if (completed > 0) {
      onUploadCancelled?.(completed);
    }
    // If all remaining are completed, trigger onAllUploaded
    setEntries(prev => {
      const allDone = prev.length > 0 && prev.every(e => e.status === 'completed');
      if (allDone && onAllUploaded) {
        onAllUploaded(prev.length);
      }
      return prev;
    });
  }, [entries, onAllUploaded, onUploadCancelled]);

  const handleCancelUpload = useCallback(() => {
    cancelledRef.current = true;
    // Abort the current in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    // Mark remaining pending entries as failed with '已取消'
    setEntries(prev => prev.map(e =>
      e.status === 'pending' ? { ...e, status: 'failed' as const, error: '已取消' } : e
    ));
  }, []);

  const handleSelectFiles = useCallback(() => {
    setMode('file');
    if (inputRef.current) {
      inputRef.current.removeAttribute('webkitdirectory');
      inputRef.current.click();
    }
  }, []);

  const handleSelectFolder = useCallback(() => {
    setMode('folder');
    if (inputRef.current) {
      inputRef.current.setAttribute('webkitdirectory', '');
      inputRef.current.click();
    }
  }, []);

  const completedCount = entries.filter(e => e.status === 'completed').length;
  const totalCount = entries.length;
  const failedEntries = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ entry }) => entry.status === 'failed');
  const progressPercent = totalCount > 0 ? Math.round(completedCount / totalCount * 100) : 0;

  return (
    <div aria-label="文件上传">
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <button onClick={handleSelectFiles}>选择文件</button>
        <button onClick={handleSelectFolder}>选择文件夹</button>
      </div>

      <input
        ref={inputRef}
        data-testid="file-input"
        type="file"
        multiple
        accept=".jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.avi,.mkv"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        {...(mode === 'folder' ? { webkitdirectory: '' } : {})}
      />

      {warnings.length > 0 && (
        <div role="alert" aria-label="格式警告">
          {warnings.map((w, i) => (
            <p key={i} style={{ color: 'orange' }}>{w}</p>
          ))}
        </div>
      )}

      {totalCount > 0 && (uploading || completedCount > 0 || failedEntries.length > 0) && (
        <div aria-label="上传进度">
          <div
            style={{
              width: '100%',
              backgroundColor: '#e0e0e0',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              data-testid="upload-progress-fill"
              style={{
                width: `${progressPercent}%`,
                height: 20,
                backgroundColor: '#4caf50',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span data-testid="upload-count">{completedCount}/{totalCount}</span>
            <span data-testid="upload-percent">{progressPercent}%</span>
          </div>
          {uploading && (
            <button onClick={handleCancelUpload} style={{ marginTop: 8 }}>
              取消上传
            </button>
          )}
        </div>
      )}

      {failedEntries.length > 0 && (
        <div aria-label="失败文件" style={{ marginTop: '8px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button onClick={handleRetryAll} disabled={uploading}>
              全部重试
            </button>
            <button onClick={handleCancelAll} disabled={uploading}>
              全部取消
            </button>
          </div>
          {failedEntries.map(({ entry, index }) => (
            <div key={index} data-testid={`failed-entry-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ color: 'red' }}>{entry.file.name}</span>
              {entry.error && <span style={{ color: 'red', fontSize: '0.9em' }}>{entry.error}</span>}
              <button onClick={() => handleRetry(index)} disabled={uploading}>
                重试
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
