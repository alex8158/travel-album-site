import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';
import VideoPlayer from './VideoPlayer';

export interface CompilationPreviewProps {
  mediaId: string;
  compiledPath: string | null;
  hasSegments: boolean;
  isProcessing: boolean;
}

interface CompileJobStatus {
  status: 'queued' | 'running' | 'completed' | 'failed';
  percent: number;
  error?: string;
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中...',
  running: '正在生成剪辑...',
  completed: '剪辑完成',
  failed: '剪辑失败',
};

export default function CompilationPreview({
  mediaId,
  compiledPath,
  hasSegments,
  isProcessing,
}: CompilationPreviewProps) {
  const [showPlayer, setShowPlayer] = useState(false);
  const [jobStatus, setJobStatus] = useState<CompileJobStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [localCompiledPath, setLocalCompiledPath] = useState(compiledPath);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Sync prop changes
  useEffect(() => {
    setLocalCompiledPath(compiledPath);
  }, [compiledPath]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setPolling(false);
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const res = await authFetch(`/api/media/${mediaId}/compile/status`);
      if (!mountedRef.current) return;

      if (!res.ok) {
        // No active job found
        stopPolling();
        return;
      }

      const data: CompileJobStatus = await res.json();
      if (!mountedRef.current) return;

      setJobStatus(data);

      if (data.status === 'completed') {
        stopPolling();
        setLocalCompiledPath(`/api/media/${mediaId}/compile/download`);
      } else if (data.status === 'failed') {
        stopPolling();
      }
    } catch {
      // Network error — keep polling, will retry next interval
    }
  }, [mediaId, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    setPolling(true);
    // Immediate poll
    pollStatus();
    pollingRef.current = setInterval(pollStatus, 2000);
  }, [stopPolling, pollStatus]);

  // Start polling if isProcessing prop is true on mount
  useEffect(() => {
    if (isProcessing && !polling) {
      startPolling();
    }
  }, [isProcessing]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerateCompile = async () => {
    setJobStatus({ status: 'queued', percent: 0 });
    try {
      const res = await authFetch(`/api/media/${mediaId}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!mountedRef.current) return;

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setJobStatus({
          status: 'failed',
          percent: 0,
          error: body?.error?.message || body?.error || '启动剪辑任务失败',
        });
        return;
      }

      startPolling();
    } catch {
      if (!mountedRef.current) return;
      setJobStatus({ status: 'failed', percent: 0, error: '网络错误，请重试' });
    }
  };

  const handleRetry = () => {
    setJobStatus(null);
    handleGenerateCompile();
  };

  // Determine current display state
  const isActive = jobStatus && (jobStatus.status === 'queued' || jobStatus.status === 'running');
  const isFailed = jobStatus && jobStatus.status === 'failed';
  const hasCompiled = !!localCompiledPath;

  // No segments and no compiled path → don't render
  if (!hasCompiled && !hasSegments && !isActive && !isFailed) {
    return null;
  }

  // Active processing state
  if (isActive) {
    return (
      <div data-testid="compilation-preview" aria-label="剪辑预览">
        <div style={{ padding: '12px' }}>
          <p style={{ margin: '0 0 8px 0', fontWeight: 500 }}>
            {STATUS_LABELS[jobStatus.status]}
          </p>
          <div
            style={{
              width: '100%',
              backgroundColor: '#e0e0e0',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <div
              data-testid="compile-progress-bar"
              style={{
                width: `${Math.max(jobStatus.percent, 2)}%`,
                height: 16,
                backgroundColor: '#2196f3',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.875rem', color: '#666' }}>
            {jobStatus.percent}%
          </p>
        </div>
      </div>
    );
  }

  // Failed state
  if (isFailed) {
    return (
      <div data-testid="compilation-preview" aria-label="剪辑预览">
        <div style={{ padding: '12px' }}>
          <p role="alert" style={{ color: '#d32f2f', margin: '0 0 8px 0' }}>
            {jobStatus.error || '剪辑失败'}
          </p>
          <button
            onClick={handleRetry}
            data-testid="compile-retry-btn"
            style={{
              padding: '6px 16px',
              backgroundColor: '#f44336',
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
    );
  }

  // Has compiled video
  if (hasCompiled) {
    return (
      <div data-testid="compilation-preview" aria-label="剪辑预览">
        {!showPlayer && (
          <button
            onClick={() => setShowPlayer(true)}
            data-testid="compile-preview-btn"
            style={{
              padding: '8px 20px',
              backgroundColor: '#1976d2',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            剪辑预览
          </button>
        )}
        {showPlayer && (
          <VideoPlayer
            videoUrl={`/api/media/${mediaId}/compile/download`}
            mimeType="video/mp4"
            onClose={() => setShowPlayer(false)}
          />
        )}
      </div>
    );
  }

  // Has segments but no compiled video → show generate button
  if (hasSegments && !hasCompiled) {
    return (
      <div data-testid="compilation-preview" aria-label="剪辑预览">
        <button
          onClick={handleGenerateCompile}
          data-testid="compile-generate-btn"
          style={{
            padding: '8px 20px',
            backgroundColor: '#4caf50',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: '0.9rem',
          }}
        >
          生成剪辑
        </button>
      </div>
    );
  }

  return null;
}
