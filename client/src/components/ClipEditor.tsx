import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';

interface Segment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  sharpnessScore: number;
  stabilityScore: number;
  exposureScore: number;
  overallScore: number;
  label: string;
}

interface JobStatus {
  id: string;
  status: string;
  currentStep: string | null;
  percent: number;
  errorMessage: string | null;
}

interface MergeResult {
  success: boolean;
  mergedPath: string | null;
  error?: string;
}

export interface ClipEditorProps {
  mediaId: string;
  tripId: string;
  onClose?: () => void;
}

const LABEL_COLORS: Record<string, { bg: string; text: string }> = {
  good:              { bg: '#d4edda', text: '#155724' },
  blurry:            { bg: '#fff3cd', text: '#856404' },
  shaky:             { bg: '#fff3cd', text: '#856404' },
  slightly_shaky:    { bg: '#fff3cd', text: '#856404' },
  severely_blurry:   { bg: '#f8d7da', text: '#721c24' },
  severely_shaky:    { bg: '#f8d7da', text: '#721c24' },
  severely_exposed:  { bg: '#f8d7da', text: '#721c24' },
};

const LABEL_TEXT: Record<string, string> = {
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

export default function ClipEditor({ mediaId, tripId: _tripId, onClose }: ClipEditorProps) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [orderedIndices, setOrderedIndices] = useState<number[]>([]);
  const [previewSegment, setPreviewSegment] = useState<Segment | null>(null);

  // Merge state
  const [merging, setMerging] = useState(false);
  const [_mergeJobId, setMergeJobId] = useState<string | null>(null);
  const [mergeStatus, setMergeStatus] = useState<string>('');
  const [mergePercent, setMergePercent] = useState(0);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  const [mergeError, setMergeError] = useState('');

  // Re-edit state
  const [targetDurationInput, setTargetDurationInput] = useState<string>('');
  const [reEditing, setReEditing] = useState(false);
  // Load segments from API
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
          // Default: select all "good" segments
          const goodIndices = json.segments
            .filter(s => s.label === 'good' || s.label === 'slightly_shaky')
            .map(s => s.index);
          setSelectedIndices(new Set(goodIndices));
          setOrderedIndices(goodIndices);
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
  const toggleSegment = useCallback((index: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
        setOrderedIndices(oi => oi.filter(i => i !== index));
      } else {
        next.add(index);
        setOrderedIndices(oi => [...oi, index]);
      }
      return next;
    });
  }, []);

  // Move segment up/down in ordered list
  const moveSegment = useCallback((index: number, direction: 'up' | 'down') => {
    setOrderedIndices(prev => {
      const pos = prev.indexOf(index);
      if (pos < 0) return prev;
      const newPos = direction === 'up' ? pos - 1 : pos + 1;
      if (newPos < 0 || newPos >= prev.length) return prev;
      const next = [...prev];
      [next[pos], next[newPos]] = [next[newPos], next[pos]];
      return next;
    });
  }, []);

  // Poll job status
  const pollJob = useCallback(async (jobId: string) => {
    const maxAttempts = 120; // 2 minutes at 1s interval
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await authFetch(`/api/process-jobs/${jobId}`);
        if (!res.ok) break;
        const job = await res.json() as JobStatus;
        setMergeStatus(job.status);
        setMergePercent(job.percent);

        if (job.status === 'completed') {
          // Fetch result
          const resultRes = await authFetch(`/api/process-jobs/${jobId}/result`);
          if (resultRes.ok) {
            const result = await resultRes.json() as MergeResult;
            setMergeResult(result);
          }
          setMerging(false);
          return;
        }
        if (job.status === 'failed') {
          setMergeError(job.errorMessage || '合并失败');
          setMerging(false);
          return;
        }
      } catch {
        // continue polling
      }
    }
    setMergeError('合并超时，请稍后查看');
    setMerging(false);
  }, []);

  // Trigger merge
  const handleMerge = useCallback(async () => {
    if (orderedIndices.length === 0) return;
    setMerging(true);
    setMergeError('');
    setMergeResult(null);
    setMergeStatus('queued');
    setMergePercent(0);

    try {
      const res = await authFetch(`/api/media/${mediaId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentIndices: orderedIndices }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMergeError(body?.error?.message || '合并请求失败');
        setMerging(false);
        return;
      }
      const data = await res.json() as { jobId: string };
      setMergeJobId(data.jobId);
      pollJob(data.jobId);
    } catch {
      setMergeError('合并请求失败');
      setMerging(false);
    }
  }, [mediaId, orderedIndices, pollJob]);

  if (loading) {
    return <div style={{ padding: '16px', textAlign: 'center' }}>加载片段中...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: '16px' }}>
        <p style={{ color: 'red' }}>{error}</p>
        {onClose && <button onClick={onClose}>关闭</button>}
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div style={{ padding: '16px', textAlign: 'center' }}>
        <p>该视频尚未分析，暂无片段数据。</p>
        {onClose && <button onClick={onClose}>关闭</button>}
      </div>
    );
  }

  return (
    <div
      data-testid="clip-editor"
      style={{
        padding: '16px',
        background: '#fff',
        borderRadius: '8px',
        border: '1px solid #ddd',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 style={{ margin: 0 }}>智能剪辑 — 片段编辑器</h3>
        {onClose && (
          <button
            onClick={onClose}
            data-testid="clip-editor-close"
            style={{ background: 'none', border: '1px solid #ccc', borderRadius: '4px', padding: '4px 12px', cursor: 'pointer' }}
          >
            关闭
          </button>
        )}
      </div>

      {/* Timeline */}
      <div
        data-testid="clip-timeline"
        style={{
          display: 'flex',
          gap: '2px',
          marginBottom: '16px',
          overflowX: 'auto',
          padding: '4px 0',
        }}
      >
        {segments.map(seg => {
          const colors = LABEL_COLORS[seg.label] || LABEL_COLORS.good;
          const isSelected = selectedIndices.has(seg.index);
          return (
            <div
              key={seg.index}
              data-testid={`timeline-seg-${seg.index}`}
              onClick={() => setPreviewSegment(seg)}
              style={{
                minWidth: Math.max(30, seg.duration * 8),
                height: '32px',
                background: colors.bg,
                border: isSelected ? '2px solid #4a90d9' : '1px solid #ccc',
                borderRadius: '3px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                color: colors.text,
                flexShrink: 0,
              }}
              title={`片段 ${seg.index}: ${formatTime(seg.startTime)} - ${formatTime(seg.endTime)} (${LABEL_TEXT[seg.label] || seg.label})`}
            >
              {seg.index}
            </div>
          );
        })}
      </div>

      {/* Segment preview info */}
      {previewSegment && (
        <div
          data-testid="segment-preview"
          style={{
            padding: '12px',
            background: '#f8f9fa',
            borderRadius: '6px',
            marginBottom: '16px',
            border: '1px solid #e9ecef',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>片段 {previewSegment.index} 预览</strong>
            <button
              onClick={() => setPreviewSegment(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}
            >
              ×
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginTop: '8px', fontSize: '0.85rem' }}>
            <span>开始: {formatTime(previewSegment.startTime)}</span>
            <span>结束: {formatTime(previewSegment.endTime)}</span>
            <span>时长: {previewSegment.duration.toFixed(1)}s</span>
            <span>综合评分: {previewSegment.overallScore.toFixed(1)}</span>
            <span>
              标签:{' '}
              <span style={{
                padding: '1px 6px',
                borderRadius: '3px',
                background: (LABEL_COLORS[previewSegment.label] || LABEL_COLORS.good).bg,
                color: (LABEL_COLORS[previewSegment.label] || LABEL_COLORS.good).text,
                fontSize: '0.8rem',
              }}>
                {LABEL_TEXT[previewSegment.label] || previewSegment.label}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Segment list with checkboxes and reorder */}
      <div style={{ marginBottom: '16px' }}>
        <h4 style={{ margin: '0 0 8px 0' }}>片段列表（勾选并排序后合并导出）</h4>
        <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #eee', borderRadius: '4px' }}>
          {segments.map(seg => {
            const colors = LABEL_COLORS[seg.label] || LABEL_COLORS.good;
            const isSelected = selectedIndices.has(seg.index);
            const orderPos = orderedIndices.indexOf(seg.index);
            return (
              <div
                key={seg.index}
                data-testid={`segment-row-${seg.index}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 12px',
                  borderBottom: '1px solid #f0f0f0',
                  background: isSelected ? '#f0f7ff' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSegment(seg.index)}
                  data-testid={`segment-check-${seg.index}`}
                  aria-label={`选择片段 ${seg.index}`}
                />
                <span style={{ minWidth: '28px', fontWeight: 'bold', fontSize: '0.85rem' }}>#{seg.index}</span>
                <span style={{ fontSize: '0.8rem', color: '#666', minWidth: '100px' }}>
                  {formatTime(seg.startTime)} - {formatTime(seg.endTime)}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#666', minWidth: '50px' }}>
                  {seg.duration.toFixed(1)}s
                </span>
                <span style={{ fontSize: '0.8rem', minWidth: '40px' }}>
                  {seg.overallScore.toFixed(0)}分
                </span>
                <span style={{
                  padding: '1px 6px',
                  borderRadius: '3px',
                  background: colors.bg,
                  color: colors.text,
                  fontSize: '0.75rem',
                }}>
                  {LABEL_TEXT[seg.label] || seg.label}
                </span>
                {isSelected && (
                  <span style={{ fontSize: '0.75rem', color: '#4a90d9', marginLeft: 'auto', marginRight: '4px' }}>
                    顺序: {orderPos + 1}
                  </span>
                )}
                {isSelected && (
                  <div style={{ display: 'flex', gap: '2px', marginLeft: isSelected ? '0' : 'auto' }}>
                    <button
                      onClick={() => moveSegment(seg.index, 'up')}
                      disabled={orderPos <= 0}
                      data-testid={`segment-up-${seg.index}`}
                      style={{
                        background: 'none',
                        border: '1px solid #ccc',
                        borderRadius: '3px',
                        padding: '0 4px',
                        cursor: orderPos <= 0 ? 'not-allowed' : 'pointer',
                        fontSize: '0.75rem',
                      }}
                      aria-label={`上移片段 ${seg.index}`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveSegment(seg.index, 'down')}
                      disabled={orderPos >= orderedIndices.length - 1}
                      data-testid={`segment-down-${seg.index}`}
                      style={{
                        background: 'none',
                        border: '1px solid #ccc',
                        borderRadius: '3px',
                        padding: '0 4px',
                        cursor: orderPos >= orderedIndices.length - 1 ? 'not-allowed' : 'pointer',
                        fontSize: '0.75rem',
                      }}
                      aria-label={`下移片段 ${seg.index}`}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Merge controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button
          onClick={handleMerge}
          disabled={merging || orderedIndices.length === 0}
          data-testid="merge-btn"
          style={{
            background: orderedIndices.length === 0 ? '#ccc' : '#4a90d9',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            padding: '8px 20px',
            cursor: merging || orderedIndices.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: '0.95rem',
          }}
        >
          {merging ? '合并中...' : `合并导出 (${orderedIndices.length} 个片段)`}
        </button>

        {merging && (
          <div data-testid="merge-progress" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '120px',
              height: '8px',
              background: '#e9ecef',
              borderRadius: '4px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${mergePercent}%`,
                height: '100%',
                background: '#4a90d9',
                transition: 'width 0.3s',
              }} />
            </div>
            <span style={{ fontSize: '0.8rem', color: '#666' }}>
              {mergeStatus === 'queued' ? '排队中...' : `${mergePercent}%`}
            </span>
          </div>
        )}
      </div>

      {mergeError && (
        <p data-testid="merge-error" style={{ color: 'red', marginTop: '8px', fontSize: '0.9rem' }}>
          {mergeError}
        </p>
      )}

      {mergeResult && mergeResult.success && mergeResult.mergedPath && (
        <div
          data-testid="merge-result"
          style={{
            marginTop: '12px',
            padding: '12px',
            background: '#d4edda',
            borderRadius: '6px',
            border: '1px solid #c3e6cb',
          }}
        >
          <p style={{ margin: '0 0 8px 0', color: '#155724', fontWeight: 'bold' }}>合并完成！</p>
          <button
            onClick={async () => {
              try {
                const res = await authFetch(`/api/media/${mediaId}/download-compiled`);
                if (!res.ok) throw new Error('下载失败');
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `compiled-${mediaId}.mp4`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              } catch {
                alert('下载失败，请重试');
              }
            }}
            data-testid="merge-download"
            style={{
              display: 'inline-block',
              padding: '6px 16px',
              background: '#28a745',
              color: '#fff',
              borderRadius: '4px',
              border: 'none',
              fontSize: '0.9rem',
              cursor: 'pointer',
            }}
          >
            下载合并视频
          </button>
        </div>
      )}

      {/* Re-edit controls */}
      <div style={{ marginTop: '16px', padding: '12px', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e9ecef' }}>
        <h4 style={{ margin: '0 0 8px 0' }}>二次编辑</h4>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.85rem' }}>
            目标时长（秒）：
            <input
              type="number"
              min="1"
              placeholder="留空则自动"
              value={targetDurationInput}
              onChange={e => setTargetDurationInput(e.target.value)}
              data-testid="re-edit-duration"
              style={{ width: '80px', marginLeft: '4px', padding: '4px 6px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </label>
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            已排除 {segments.length - selectedIndices.size} 个片段
          </span>
          <button
            onClick={async () => {
              if (reEditing) return;
              setReEditing(true);
              setMergeError('');
              setMergeResult(null);
              setMergeStatus('queued');
              setMergePercent(0);
              setMerging(true);
              try {
                const excludeIndices = segments
                  .filter(s => !selectedIndices.has(s.index))
                  .map(s => s.index);
                const body: Record<string, unknown> = { excludeIndices };
                if (targetDurationInput) body.targetDuration = Number(targetDurationInput);
                const res = await authFetch(`/api/media/${mediaId}/re-edit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                if (!res.ok) {
                  const b = await res.json().catch(() => ({}));
                  setMergeError(b?.error?.message || '重新编辑请求失败');
                  setMerging(false);
                  setReEditing(false);
                  return;
                }
                const data = await res.json() as { jobId: string };
                setMergeJobId(data.jobId);
                pollJob(data.jobId);
              } catch {
                setMergeError('重新编辑请求失败');
                setMerging(false);
              } finally {
                setReEditing(false);
              }
            }}
            disabled={reEditing || merging || selectedIndices.size === 0}
            data-testid="re-edit-btn"
            style={{
              background: selectedIndices.size === 0 ? '#ccc' : '#6c757d',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '6px 16px',
              cursor: reEditing || merging || selectedIndices.size === 0 ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
            }}
          >
            {reEditing ? '处理中...' : '重新编辑'}
          </button>
        </div>
        <p style={{ fontSize: '0.75rem', color: '#999', margin: '6px 0 0 0' }}>
          取消勾选不需要的片段，设置目标时长后点击"重新编辑"。留空目标时长则按原始视频时长自动计算。
        </p>
      </div>
    </div>
  );
}
