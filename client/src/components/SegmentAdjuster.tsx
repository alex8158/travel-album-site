import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface Segment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  overallScore: number;
  label: string;
}

export interface SegmentAdjusterProps {
  mediaId: string;
  onClose: () => void;
  onCompileStarted?: () => void;
}

const MAX_SELECTED = 50;

const SEVERE_LABELS = ['severely_blurry', 'severely_shaky', 'severely_exposed'];

const LABEL_DISPLAY: Record<string, string> = {
  good: '良好',
  blurry: '模糊',
  shaky: '抖动',
  slightly_shaky: '轻微抖动',
  severely_blurry: '严重模糊',
  severely_shaky: '严重抖动',
  severely_exposed: '严重曝光异常',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function SegmentAdjuster({ mediaId, onClose, onCompileStarted }: SegmentAdjusterProps) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemRef = useRef<number | null>(null);

  // Load segments
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await authFetch(`/api/media/${mediaId}/segments`);
        if (!res.ok) {
          setError('加载片段列表失败');
          return;
        }
        const json = await res.json() as { mediaId: string; segments: Segment[] };
        if (!cancelled) {
          setSegments(json.segments);
          // Default: select non-severe segments (up to 50)
          const defaultSelected = json.segments
            .filter(s => !SEVERE_LABELS.includes(s.label) && s.overallScore >= 30)
            .slice(0, MAX_SELECTED)
            .map(s => s.index);
          setSelectedIndices(defaultSelected);
        }
      } catch {
        if (!cancelled) setError('加载片段列表失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [mediaId]);

  // Toggle segment selection
  const toggleSegment = useCallback((segIndex: number) => {
    setSelectedIndices(prev => {
      if (prev.includes(segIndex)) {
        return prev.filter(i => i !== segIndex);
      }
      if (prev.length >= MAX_SELECTED) {
        return prev; // Don't add if at max
      }
      return [...prev, segIndex];
    });
  }, []);

  // Drag handlers for reordering selected segments
  const handleDragStart = useCallback((e: React.DragEvent, listPosition: number) => {
    dragItemRef.current = listPosition;
    setDragIndex(listPosition);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(listPosition));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, listPosition: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(listPosition);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragItemRef.current = null;
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropPosition: number) => {
    e.preventDefault();
    const fromPosition = dragItemRef.current;
    if (fromPosition === null || fromPosition === dropPosition) {
      handleDragEnd();
      return;
    }
    setSelectedIndices(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromPosition, 1);
      next.splice(dropPosition, 0, moved);
      return next;
    });
    handleDragEnd();
  }, [handleDragEnd]);

  // Submit compile request
  const handleSubmit = useCallback(async () => {
    if (selectedIndices.length === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await authFetch(`/api/media/${mediaId}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentIndices: selectedIndices }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitError(body?.error?.message || body?.error || '提交失败');
        return;
      }
      onCompileStarted?.();
      onClose();
    } catch {
      setSubmitError('提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }, [mediaId, selectedIndices, submitting, onClose, onCompileStarted]);

  if (loading) {
    return (
      <div data-testid="segment-adjuster-loading" style={{ padding: '16px', textAlign: 'center' }}>
        加载片段中...
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="segment-adjuster-error" style={{ padding: '16px' }}>
        <p style={{ color: 'red' }}>{error}</p>
        <button onClick={onClose}>取消</button>
      </div>
    );
  }

  return (
    <div
      data-testid="segment-adjuster"
      style={{
        padding: '16px',
        background: '#fff',
        borderRadius: '8px',
        border: '1px solid #ddd',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ margin: 0 }}>片段调整 — 重新生成</h3>
        <span style={{ fontSize: '0.85rem', color: '#666' }}>
          已选 {selectedIndices.length}/{MAX_SELECTED} 个片段
        </span>
      </div>

      {/* Segment list */}
      <div
        style={{
          maxHeight: '400px',
          overflowY: 'auto',
          border: '1px solid #eee',
          borderRadius: '4px',
          marginBottom: '16px',
        }}
      >
        {segments.map(seg => {
          const isSelected = selectedIndices.includes(seg.index);
          const isLowQuality = SEVERE_LABELS.includes(seg.label) || seg.overallScore < 30;
          const listPosition = selectedIndices.indexOf(seg.index);

          return (
            <div
              key={seg.index}
              data-testid={`adjuster-segment-${seg.index}`}
              draggable={isSelected}
              onDragStart={isSelected ? (e) => handleDragStart(e, listPosition) : undefined}
              onDragOver={isSelected ? (e) => handleDragOver(e, listPosition) : undefined}
              onDrop={isSelected ? (e) => handleDrop(e, listPosition) : undefined}
              onDragEnd={handleDragEnd}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderBottom: '1px solid #f0f0f0',
                background: dragOverIndex === listPosition && isSelected
                  ? '#e3f2fd'
                  : dragIndex === listPosition && isSelected
                    ? '#f5f5f5'
                    : isSelected
                      ? '#f0f7ff'
                      : 'transparent',
                opacity: dragIndex === listPosition ? 0.5 : 1,
                cursor: isSelected ? 'grab' : 'default',
                transition: 'background 0.15s',
              }}
            >
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSegment(seg.index)}
                disabled={!isSelected && selectedIndices.length >= MAX_SELECTED}
                data-testid={`adjuster-check-${seg.index}`}
                aria-label={`选择片段 ${seg.index}`}
              />

              {/* Order indicator */}
              {isSelected && (
                <span
                  data-testid={`adjuster-order-${seg.index}`}
                  style={{
                    minWidth: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    background: '#4a90d9',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                  }}
                >
                  {listPosition + 1}
                </span>
              )}

              {/* Time range */}
              <span style={{ fontSize: '0.85rem', color: '#333', minWidth: '110px' }}>
                {formatTime(seg.startTime)} - {formatTime(seg.endTime)}
              </span>

              {/* Duration */}
              <span style={{ fontSize: '0.85rem', color: '#666', minWidth: '55px' }}>
                {seg.duration.toFixed(1)}s
              </span>

              {/* Quality score */}
              <span
                data-testid={`adjuster-score-${seg.index}`}
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 'bold',
                  color: seg.overallScore >= 70 ? '#28a745' : seg.overallScore >= 30 ? '#ffc107' : '#dc3545',
                  minWidth: '45px',
                }}
              >
                {seg.overallScore.toFixed(0)}分
              </span>

              {/* Low quality badge */}
              {isLowQuality && (
                <span
                  data-testid={`adjuster-low-quality-${seg.index}`}
                  style={{
                    padding: '2px 6px',
                    borderRadius: '3px',
                    background: '#f8d7da',
                    color: '#721c24',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {LABEL_DISPLAY[seg.label] || '低质量'}
                </span>
              )}

              {/* Drag handle for selected items */}
              {isSelected && (
                <span
                  style={{
                    marginLeft: 'auto',
                    cursor: 'grab',
                    fontSize: '1rem',
                    color: '#999',
                    userSelect: 'none',
                  }}
                  title="拖拽调整顺序"
                >
                  ⠿
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Submit error */}
      {submitError && (
        <p data-testid="adjuster-submit-error" style={{ color: 'red', margin: '0 0 12px 0', fontSize: '0.9rem' }}>
          {submitError}
        </p>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button
          onClick={handleSubmit}
          disabled={submitting || selectedIndices.length === 0}
          data-testid="adjuster-submit"
          style={{
            background: selectedIndices.length === 0 ? '#ccc' : '#4a90d9',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            padding: '8px 20px',
            cursor: submitting || selectedIndices.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: '0.95rem',
          }}
        >
          {submitting ? '提交中...' : `确认重新生成 (${selectedIndices.length} 个片段)`}
        </button>

        <button
          onClick={onClose}
          disabled={submitting}
          data-testid="adjuster-cancel"
          style={{
            background: 'none',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '8px 16px',
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontSize: '0.95rem',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}
