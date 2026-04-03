import { useState, useRef, useCallback } from 'react';
import axios from 'axios';

export interface FileUploaderProps {
  tripId: string;
  onAllUploaded?: (count: number) => void;
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

export default function FileUploader({ tripId, onAllUploaded }: FileUploaderProps) {
  const [mode, setMode] = useState<'file' | 'folder'>('file');
  const [entries, setEntries] = useState<UploadFileEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateEntry = useCallback((index: number, patch: Partial<UploadFileEntry>) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, ...patch } : e));
  }, []);

  const uploadFile = useCallback(async (index: number, entry: UploadFileEntry) => {
    updateEntry(index, { status: 'uploading', progress: 0, error: undefined });

    const formData = new FormData();
    formData.append('file', entry.file);

    try {
      const token = localStorage.getItem('auth_token');
      await axios.post(`/api/trips/${tripId}/media`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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

  const doUpload = useCallback(async (fileEntries: UploadFileEntry[]) => {
    setUploading(true);
    for (let i = 0; i < fileEntries.length; i++) {
      if (fileEntries[i].status === 'pending') {
        await uploadFile(i, fileEntries[i]);
      }
    }
    setUploading(false);
    setEntries(prev => {
      const allDone = prev.length > 0 && prev.every(e => e.status === 'completed');
      if (allDone && onAllUploaded) {
        onAllUploaded(prev.length);
      }
      return prev;
    });
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

  const handleSelectFiles = useCallback(() => {
    setMode('file');
    // Need to update the input before clicking
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
        </div>
      )}

      {failedEntries.length > 0 && (
        <div aria-label="失败文件" style={{ marginTop: '8px' }}>
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
