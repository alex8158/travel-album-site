import { useState, useRef, useCallback } from 'react';
import axios from 'axios';

export interface FileUploaderProps {
  tripId: string;
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

export default function FileUploader({ tripId }: FileUploaderProps) {
  const [entries, setEntries] = useState<UploadFileEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateEntry = useCallback((index: number, patch: Partial<UploadFileEntry>) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, ...patch } : e));
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newEntries: UploadFileEntry[] = [];
    const newWarnings: string[] = [];

    for (const file of Array.from(files)) {
      if (isFormatSupported(file)) {
        newEntries.push({ file, status: 'pending', progress: 0 });
      } else {
        newWarnings.push(`"${file.name}" 格式不支持，已跳过`);
      }
    }

    setEntries(prev => [...prev, ...newEntries]);
    setWarnings(prev => [...prev, ...newWarnings]);

    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const uploadFile = useCallback(async (index: number, entry: UploadFileEntry) => {
    updateEntry(index, { status: 'uploading', progress: 0, error: undefined });

    const formData = new FormData();
    formData.append('file', entry.file);

    try {
      await axios.post(`/api/trips/${tripId}/media`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress(progressEvent) {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            updateEntry(index, { progress: Math.min(percent, 100) });
          }
        },
      });
      updateEntry(index, { status: 'completed', progress: 100 });
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) && err.response?.data?.error?.message
        ? err.response.data.error.message
        : '上传失败';
      updateEntry(index, { status: 'failed', error: message });
    }
  }, [tripId, updateEntry]);

  const handleUpload = useCallback(async () => {
    setUploading(true);
    const snapshot = entries;
    for (let i = 0; i < snapshot.length; i++) {
      if (snapshot[i].status === 'pending') {
        await uploadFile(i, snapshot[i]);
      }
    }
    setUploading(false);
  }, [entries, uploadFile]);

  const handleRetry = useCallback(async (index: number) => {
    setUploading(true);
    await uploadFile(index, entries[index]);
    setUploading(false);
  }, [entries, uploadFile]);

  const pendingCount = entries.filter(e => e.status === 'pending').length;
  const failedCount = entries.filter(e => e.status === 'failed').length;

  return (
    <div aria-label="文件上传">
      <div>
        <label htmlFor="file-input">选择文件</label>
        <input
          id="file-input"
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.avi,.mkv"
          onChange={handleFileSelect}
        />
      </div>

      {warnings.length > 0 && (
        <ul role="alert" aria-label="格式警告">
          {warnings.map((w, i) => (
            <li key={i} style={{ color: 'orange' }}>{w}</li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <>
          <ul aria-label="上传列表">
            {entries.map((entry, i) => (
              <li key={i} data-testid={`upload-entry-${i}`}>
                <span>{entry.file.name}</span>
                {' '}
                <span data-testid={`status-${i}`}>{entry.status}</span>
                {' '}
                <span data-testid={`progress-${i}`}>{entry.progress}%</span>
                {entry.status === 'failed' && (
                  <>
                    {entry.error && <span style={{ color: 'red' }}> {entry.error}</span>}
                    <button onClick={() => handleRetry(i)} disabled={uploading}>
                      重试
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>

          {(pendingCount > 0 || failedCount > 0) && (
            <button onClick={handleUpload} disabled={uploading || pendingCount === 0}>
              {uploading ? '上传中...' : `开始上传 (${pendingCount} 个文件)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
