/**
 * SlideshowDialog — 照片幻灯片视频生成对话框
 *
 * Multi-step flow:
 *   1. audio       — 选择背景音乐（或跳过）
 *   2. generating  — 通过 SSE 接收 ffmpeg 进度
 *   3. complete    — 显示预览播放器和下载按钮
 *   error          — 显示错误信息和重试按钮
 *
 * Requirements: 1.2, 1.4, 4.1, 4.4, 5.2, 5.4, 6.1, 6.2, 6.3, 7.4
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import AudioLibraryPanel, { AudioTrack } from './AudioLibraryPanel';
import { authFetch } from '../contexts/AuthContext';

export interface SlideshowDialogProps {
  tripId: string;
  photoIds: string[];
  onClose: () => void;
  onComplete: (videoUrl: string) => void;
}

type Step = 'audio' | 'generating' | 'complete' | 'error';

interface SSEEvent {
  event: string;
  data: any;
}

/** Parse a single SSE event block (e.g. "event: progress\ndata: {...}") */
function parseSSEEvent(block: string): SSEEvent | null {
  const lines = block.split('\n');
  let event = 'message';
  let dataStr = '';
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr += line.slice(5).trim();
    }
  }
  if (!dataStr) return null;
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

export default function SlideshowDialog({
  tripId,
  photoIds,
  onClose,
  onComplete,
}: SlideshowDialogProps) {
  const [step, setStep] = useState<Step>('audio');
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedTrack, setSelectedTrack] = useState<AudioTrack | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Track latest blob URL for cleanup
  useEffect(() => {
    blobUrlRef.current = videoBlobUrl;
  }, [videoBlobUrl]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  const handleSelectTrack = useCallback((track: AudioTrack) => {
    setSelectedTrack(track);
  }, []);

  const fetchVideoBlob = useCallback(async (url: string) => {
    const res = await authFetch(url);
    if (!res.ok) {
      throw new Error('下载视频失败');
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }, []);

  const startGeneration = useCallback(
    async (audioTrackId: string | null) => {
      setStep('generating');
      setPercent(0);
      setErrorMsg('');

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await authFetch('/api/slideshow/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tripId, photoIds, audioTrackId }),
          signal: ac.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message =
            body?.error?.message || body?.message || `生成失败 (HTTP ${res.status})`;
          throw new Error(message);
        }

        if (!res.body) {
          throw new Error('当前环境不支持流式响应');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completedUrl: string | null = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by blank lines
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            if (!block.trim()) continue;
            const evt = parseSSEEvent(block);
            if (!evt) continue;

            if (!mountedRef.current) return;

            if (evt.event === 'progress') {
              const p = Number(evt.data?.percent);
              if (Number.isFinite(p)) {
                setPercent(Math.max(0, Math.min(100, Math.round(p))));
              }
            } else if (evt.event === 'complete') {
              completedUrl = String(evt.data?.videoUrl || '');
            } else if (evt.event === 'error') {
              const message = evt.data?.message || '视频生成失败';
              setErrorMsg(message);
              setStep('error');
              return;
            }
          }
        }

        if (!completedUrl) {
          throw new Error('生成中断或未收到完成事件');
        }

        // Fetch the video as a blob (auth required) so we can preview/download
        const blobUrl = await fetchVideoBlob(completedUrl);
        if (!mountedRef.current) {
          URL.revokeObjectURL(blobUrl);
          return;
        }

        // Revoke any previous blob URL
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        setVideoUrl(completedUrl);
        setVideoBlobUrl(blobUrl);
        setPercent(100);
        setStep('complete');
        onComplete(completedUrl);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setErrorMsg(err?.message || '视频生成失败');
        setStep('error');
      }
    },
    [tripId, photoIds, onComplete, fetchVideoBlob],
  );

  const handleSkipAudio = useCallback(() => {
    startGeneration(null);
  }, [startGeneration]);

  const handleConfirmAudio = useCallback(() => {
    if (!selectedTrack) return;
    startGeneration(selectedTrack.id);
  }, [selectedTrack, startGeneration]);

  const handleRetry = useCallback(() => {
    setStep('audio');
    setPercent(0);
    setErrorMsg('');
  }, []);

  const handleDownload = useCallback(() => {
    if (!videoBlobUrl) return;
    const a = document.createElement('a');
    a.href = videoBlobUrl;
    a.download = 'slideshow.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [videoBlobUrl]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="生成幻灯片视频"
      data-testid="slideshow-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== 'generating') {
          handleClose();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          maxWidth: 720,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 20,
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.25rem' }}>
            生成幻灯片视频
          </h2>
          {step !== 'generating' && (
            <button
              onClick={handleClose}
              aria-label="关闭"
              data-testid="slideshow-close-btn"
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.5rem',
                cursor: 'pointer',
                padding: '4px 8px',
              }}
            >
              ×
            </button>
          )}
        </div>

        <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '0.9rem' }}>
          已选择 {photoIds.length} 张照片，每张播放 2 秒
        </p>

        {step === 'audio' && (
          <div data-testid="slideshow-step-audio">
            <p style={{ margin: '0 0 12px 0' }}>
              选择背景音乐（可选）
            </p>

            <div
              style={{
                border: '1px solid #e0e0e0',
                borderRadius: 4,
                marginBottom: 16,
                maxHeight: 360,
                overflow: 'auto',
              }}
            >
              <AudioLibraryPanel selectable onSelect={handleSelectTrack} />
            </div>

            {selectedTrack && (
              <div
                data-testid="slideshow-selected-track"
                style={{
                  marginBottom: 12,
                  padding: 8,
                  background: '#f0f7ff',
                  borderRadius: 4,
                }}
              >
                <strong>已选音乐：</strong>
                {selectedTrack.title}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={handleClose}
                data-testid="slideshow-cancel-btn"
                style={{
                  padding: '8px 16px',
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                onClick={handleSkipAudio}
                data-testid="slideshow-skip-audio-btn"
                style={{
                  padding: '8px 16px',
                  background: '#fff',
                  border: '1px solid #2196f3',
                  color: '#2196f3',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                不加音乐
              </button>
              <button
                onClick={handleConfirmAudio}
                disabled={!selectedTrack}
                data-testid="slideshow-confirm-btn"
                style={{
                  padding: '8px 16px',
                  background: selectedTrack ? '#4caf50' : '#ccc',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: selectedTrack ? 'pointer' : 'not-allowed',
                }}
              >
                开始生成
              </button>
            </div>
          </div>
        )}

        {step === 'generating' && (
          <div data-testid="slideshow-step-generating">
            <p style={{ margin: '0 0 8px 0' }}>正在生成视频，请稍候...</p>
            <div
              style={{
                width: '100%',
                background: '#e0e0e0',
                borderRadius: 4,
                overflow: 'hidden',
                marginBottom: 8,
              }}
            >
              <div
                data-testid="slideshow-progress-bar"
                style={{
                  width: `${Math.max(percent, 2)}%`,
                  height: 20,
                  background: '#2196f3',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <p
              data-testid="slideshow-progress-percent"
              style={{ margin: 0, fontSize: '0.875rem', color: '#666' }}
            >
              {percent}%
            </p>
          </div>
        )}

        {step === 'complete' && videoBlobUrl && (
          <div data-testid="slideshow-step-complete">
            <p style={{ margin: '0 0 12px 0', color: '#2e7d32', fontWeight: 500 }}>
              ✓ 视频生成完成
            </p>
            <video
              controls
              playsInline
              data-testid="slideshow-video-preview"
              src={videoBlobUrl}
              style={{
                width: '100%',
                maxHeight: '50vh',
                background: '#000',
                borderRadius: 4,
                marginBottom: 12,
              }}
            >
              您的浏览器不支持视频播放。
            </video>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={handleClose}
                data-testid="slideshow-complete-close-btn"
                style={{
                  padding: '8px 16px',
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                关闭
              </button>
              <button
                onClick={handleDownload}
                data-testid="slideshow-download-btn"
                style={{
                  padding: '8px 16px',
                  background: '#1976d2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                下载
              </button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div data-testid="slideshow-step-error">
            <p
              role="alert"
              data-testid="slideshow-error-message"
              style={{ color: '#d32f2f', margin: '0 0 12px 0' }}
            >
              {errorMsg || '视频生成失败'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={handleClose}
                data-testid="slideshow-error-close-btn"
                style={{
                  padding: '8px 16px',
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                关闭
              </button>
              <button
                onClick={handleRetry}
                data-testid="slideshow-retry-btn"
                style={{
                  padding: '8px 16px',
                  background: '#f44336',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* Hidden videoUrl reference for testing/diagnostics */}
        {videoUrl && step === 'complete' && (
          <span data-testid="slideshow-video-url" style={{ display: 'none' }}>
            {videoUrl}
          </span>
        )}
      </div>
    </div>
  );
}
