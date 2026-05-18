import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface WaveformTrimmerProps {
  trackId: string;
  audioDuration: number;
  videoDuration: number;
  initialStart?: number;
  onChange: (start: number, end: number) => void;
}

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 120;
const BAR_COUNT = 200;
const BAR_GAP = 1;
const MARKER_WIDTH = 8;

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
}

export default function WaveformTrimmer({
  trackId,
  audioDuration,
  videoDuration,
  initialStart = 0,
  onChange,
}: WaveformTrimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number>(() => {
    // Constrain initial start
    const maxStart = Math.max(0, audioDuration - videoDuration);
    return Math.min(Math.max(0, initialStart), maxStart);
  });
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef(0);

  const endTime = startTime + videoDuration;
  const maxStart = Math.max(0, audioDuration - videoDuration);

  // Fetch waveform data
  useEffect(() => {
    let cancelled = false;

    async function fetchWaveform() {
      try {
        setLoading(true);
        setError(null);
        const res = await authFetch(`/api/audio/${trackId}/waveform`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load waveform');
        }
        const data = await res.json();
        if (!cancelled) {
          setWaveform(data.waveform || []);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load waveform');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchWaveform();
    return () => { cancelled = true; };
  }, [trackId]);

  // Draw waveform on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waveform.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_WIDTH * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Background
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Calculate highlighted region in pixels
    const startX = (startTime / audioDuration) * CANVAS_WIDTH;
    const endX = (endTime / audioDuration) * CANVAS_WIDTH;

    // Draw highlighted region background
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.fillRect(startX, 0, endX - startX, CANVAS_HEIGHT);

    // Draw waveform bars
    const barWidth = (CANVAS_WIDTH - (BAR_COUNT - 1) * BAR_GAP) / BAR_COUNT;
    const centerY = CANVAS_HEIGHT / 2;

    for (let i = 0; i < BAR_COUNT && i < waveform.length; i++) {
      const amplitude = waveform[i] || 0;
      const barHeight = Math.max(2, amplitude * (CANVAS_HEIGHT - 8));
      const x = i * (barWidth + BAR_GAP);
      const y = centerY - barHeight / 2;

      // Color bars inside selection differently
      const barCenter = x + barWidth / 2;
      if (barCenter >= startX && barCenter <= endX) {
        ctx.fillStyle = '#3b82f6';
      } else {
        ctx.fillStyle = '#cbd5e1';
      }

      ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Draw start marker
    ctx.fillStyle = '#1d4ed8';
    ctx.fillRect(startX - MARKER_WIDTH / 2, 0, MARKER_WIDTH, CANVAS_HEIGHT);

    // Draw start marker handle (triangle)
    ctx.beginPath();
    ctx.moveTo(startX - 6, 0);
    ctx.lineTo(startX + 6, 0);
    ctx.lineTo(startX, 10);
    ctx.closePath();
    ctx.fill();

    // Draw end marker (non-draggable, lighter)
    ctx.fillStyle = 'rgba(29, 78, 216, 0.5)';
    ctx.fillRect(endX - MARKER_WIDTH / 2, 0, MARKER_WIDTH, CANVAS_HEIGHT);

    // Draw end marker handle (triangle)
    ctx.beginPath();
    ctx.moveTo(endX - 6, 0);
    ctx.lineTo(endX + 6, 0);
    ctx.lineTo(endX, 10);
    ctx.closePath();
    ctx.fill();
  }, [waveform, startTime, endTime, audioDuration]);

  // Check if mouse is near the start marker
  const isNearStartMarker = useCallback((clientX: number): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const markerX = (startTime / audioDuration) * rect.width;
    return Math.abs(x - markerX) <= MARKER_WIDTH + 4;
  }, [startTime, audioDuration]);

  // Mouse event handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isNearStartMarker(e.clientX)) {
      setDragging(true);
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const markerX = (startTime / audioDuration) * rect.width;
        dragOffsetRef.current = x - markerX;
      }
      e.preventDefault();
    }
  }, [isNearStartMarker, startTime, audioDuration]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - dragOffsetRef.current;
    const ratio = x / rect.width;
    let newStart = ratio * audioDuration;

    // Constrain: start >= 0, end <= audioDuration
    newStart = Math.max(0, Math.min(newStart, maxStart));

    setStartTime(newStart);
  }, [dragging, audioDuration, maxStart]);

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      setDragging(false);
      onChange(startTime, startTime + videoDuration);
    }
  }, [dragging, startTime, videoDuration, onChange]);

  // Attach global mouse events for dragging
  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Update cursor style
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (isNearStartMarker(e.clientX)) {
      canvas.style.cursor = 'ew-resize';
    } else {
      canvas.style.cursor = 'default';
    }
  }, [isNearStartMarker]);

  // Notify parent of initial value
  useEffect(() => {
    onChange(startTime, startTime + videoDuration);
    // Only call on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <div data-testid="waveform-loading" style={{ padding: '12px' }}>加载波形数据...</div>;
  }

  if (error) {
    return <div data-testid="waveform-error" role="alert" style={{ padding: '12px', color: 'red' }}>{error}</div>;
  }

  return (
    <div
      ref={containerRef}
      data-testid="waveform-trimmer"
      style={{ padding: '12px 0' }}
      aria-label="波形裁剪器"
    >
      {/* Time labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '0.85em', color: '#666' }}>
        <span data-testid="waveform-start-label">起始: {formatTime(startTime)}</span>
        <span data-testid="waveform-end-label">结束: {formatTime(endTime)}</span>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        data-testid="waveform-canvas"
        style={{
          width: '100%',
          height: `${CANVAS_HEIGHT}px`,
          display: 'block',
          borderRadius: '4px',
          border: '1px solid #e2e8f0',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleCanvasMouseMove}
      />

      {/* Duration info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.8em', color: '#999' }}>
        <span>0:00</span>
        <span>选中时长: {formatTime(videoDuration)}</span>
        <span>{formatTime(audioDuration)}</span>
      </div>
    </div>
  );
}
