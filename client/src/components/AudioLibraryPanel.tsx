import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface AudioTrack {
  id: string;
  userId: string;
  title: string;
  filePath: string;
  format: 'mp3' | 'aac' | 'wav' | 'ogg';
  duration: number;
  fileSize: number;
  source: 'upload' | 'download';
  sourceUrl?: string;
  createdAt: string;
}

export interface AudioLibraryPanelProps {
  onSelect?: (track: AudioTrack) => void;
  selectable?: boolean;
}

const ACCEPTED_FORMATS = '.mp3,.aac,.wav,.ogg';
const MAX_FILE_SIZE = 52_428_800; // 50MB

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AudioLibraryPanel({ onSelect, selectable }: AudioLibraryPanelProps) {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // URL download state
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Audio preview state
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchTracks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await authFetch('/api/audio');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load audio tracks');
      }
      const data = await res.json();
      setTracks(data.tracks || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load audio tracks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  // Cleanup audio element on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handlePlayPause = useCallback((track: AudioTrack) => {
    if (playingTrackId === track.id) {
      // Pause current
      audioRef.current?.pause();
      setPlayingTrackId(null);
      return;
    }

    // Stop previous
    if (audioRef.current) {
      audioRef.current.pause();
    }

    // Play new track
    const audio = new Audio();
    // Use fetch to get the audio with auth header, then create object URL
    authFetch(`/api/audio/${track.id}/stream`)
      .then(res => {
        if (!res.ok) throw new Error('Stream failed');
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.onended = () => {
          setPlayingTrackId(null);
          URL.revokeObjectURL(url);
        };
        audio.play();
        audioRef.current = audio;
        setPlayingTrackId(track.id);
      })
      .catch(() => {
        setPlayingTrackId(null);
      });
  }, [playingTrackId]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';

    // Client-side size validation
    if (file.size > MAX_FILE_SIZE) {
      setUploadError('文件大小超过 50MB 限制');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await authFetch('/api/audio/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || '上传失败');
      }

      const data = await res.json();
      setTracks(prev => [data.track, ...prev]);
    } catch (err: any) {
      setUploadError(err.message || '上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleUrlDownload = useCallback(async () => {
    const url = downloadUrl.trim();
    if (!url) return;

    setDownloading(true);
    setDownloadError(null);

    try {
      const res = await authFetch('/api/audio/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || '下载失败');
      }

      const data = await res.json();
      setTracks(prev => [data.track, ...prev]);
      setDownloadUrl('');
    } catch (err: any) {
      setDownloadError(err.message || '下载失败');
    } finally {
      setDownloading(false);
    }
  }, [downloadUrl]);

  const handleDelete = useCallback(async (track: AudioTrack) => {
    const confirmed = window.confirm(`确定要删除音频 "${track.title}" 吗？`);
    if (!confirmed) return;

    try {
      const res = await authFetch(`/api/audio/${track.id}`, {
        method: 'DELETE',
      });

      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || '删除失败');
      }

      // Stop playback if this track is playing
      if (playingTrackId === track.id) {
        audioRef.current?.pause();
        setPlayingTrackId(null);
      }

      setTracks(prev => prev.filter(t => t.id !== track.id));
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  }, [playingTrackId]);

  return (
    <div aria-label="音频库" style={{ padding: '16px' }}>
      <h3>音频库</h3>

      {/* Upload Section */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '上传中...' : '上传音频'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FORMATS}
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            data-testid="audio-file-input"
          />
        </div>
        {uploadError && (
          <p role="alert" style={{ color: 'red', margin: '4px 0' }}>{uploadError}</p>
        )}
      </div>

      {/* URL Download Section */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="text"
            value={downloadUrl}
            onChange={e => setDownloadUrl(e.target.value)}
            placeholder="输入音频 URL"
            disabled={downloading}
            style={{ flex: 1, padding: '6px 8px' }}
            data-testid="audio-url-input"
            onKeyDown={e => {
              if (e.key === 'Enter' && downloadUrl.trim()) {
                handleUrlDownload();
              }
            }}
          />
          <button
            onClick={handleUrlDownload}
            disabled={downloading || !downloadUrl.trim()}
          >
            {downloading ? '下载中...' : '下载'}
          </button>
        </div>
        {downloadError && (
          <p role="alert" style={{ color: 'red', margin: '4px 0' }}>{downloadError}</p>
        )}
      </div>

      {/* Error display */}
      {error && (
        <p role="alert" style={{ color: 'red', marginBottom: '8px' }}>{error}</p>
      )}

      {/* Loading state */}
      {loading && <p>加载中...</p>}

      {/* Track list */}
      {!loading && tracks.length === 0 && (
        <p style={{ color: '#666' }}>暂无音频，请上传或下载音频文件</p>
      )}

      {!loading && tracks.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="audio-track-list">
          {tracks.map(track => (
            <li
              key={track.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px',
                borderBottom: '1px solid #eee',
              }}
              data-testid={`audio-track-${track.id}`}
            >
              {/* Play/Pause button */}
              <button
                onClick={() => handlePlayPause(track)}
                aria-label={playingTrackId === track.id ? '暂停' : '播放'}
                style={{ minWidth: '40px' }}
              >
                {playingTrackId === track.id ? '⏸' : '▶'}
              </button>

              {/* Track info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {track.title}
                </div>
                <div style={{ fontSize: '0.85em', color: '#666' }}>
                  {formatDuration(track.duration)} · {track.format.toUpperCase()} · {formatFileSize(track.fileSize)} · {formatDate(track.createdAt)}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '4px' }}>
                {selectable && onSelect && (
                  <button onClick={() => onSelect(track)}>选择</button>
                )}
                <button
                  onClick={() => handleDelete(track)}
                  aria-label={`删除 ${track.title}`}
                  style={{ color: 'red' }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
