import { useState, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface EditParams {
  brightness: number;  // -100 to 100, default 0
  contrast: number;    // -100 to 100, default 0
  saturation: number;  // -100 to 100, default 0
  sharpen: number;     // 0 to 100, default 0
}

const DEFAULT_PARAMS: EditParams = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 };

export interface ImageEditorProps {
  mediaId: string;
  originalUrl: string;
  onClose: () => void;
  onSaved?: () => void;
}

function paramsToFilter(p: EditParams): string {
  const b = 1 + p.brightness / 100;
  const c = 1 + p.contrast / 100;
  const s = 1 + p.saturation / 100;
  // Note: CSS blur(0) with negative value simulates sharpen visually (approximate)
  // Real sharpen is applied server-side by sharp
  return `brightness(${b}) contrast(${c}) saturate(${s})`;
}

export default function ImageEditor({ mediaId, originalUrl, onClose, onSaved }: ImageEditorProps) {
  const [params, setParams] = useState<EditParams>({ ...DEFAULT_PARAMS });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleChange = useCallback((key: keyof EditParams, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setParams({ ...DEFAULT_PARAMS });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`/api/media/${mediaId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error?.message || '保存失败');
        return;
      }
      onSaved?.();
      onClose();
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [mediaId, params, onClose, onSaved]);

  const sliders: { key: keyof EditParams; label: string; min: number; max: number }[] = [
    { key: 'brightness', label: '亮度', min: -100, max: 100 },
    { key: 'contrast', label: '对比度', min: -100, max: 100 },
    { key: 'saturation', label: '饱和度', min: -100, max: 100 },
    { key: 'sharpen', label: '锐化', min: 0, max: 100 },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片编辑"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
        display: 'flex', zIndex: 1100,
      }}
    >
      {/* Preview area */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
        <img
          src={originalUrl}
          alt="编辑预览"
          style={{
            maxWidth: '90%', maxHeight: '90vh', objectFit: 'contain',
            filter: paramsToFilter(params),
            transition: 'filter 0.1s ease',
          }}
        />
        {(params.brightness !== 0 || params.contrast !== 0 || params.saturation !== 0 || params.sharpen > 0) && (
          <div style={{
            position: 'absolute', top: 12, left: 12,
            background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '4px 10px',
            borderRadius: 4, fontSize: '0.8rem',
          }}>
            预览（锐化效果以保存后为准）
          </div>
        )}
      </div>

      {/* Controls panel */}
      <div style={{
        width: '280px', background: '#1a1a1a', padding: '20px', color: '#fff',
        display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>图片调整</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>

        {sliders.map(({ key, label, min, max }) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ fontSize: '0.9rem' }}>{label}</span>
              <span style={{ fontSize: '0.85rem', color: '#aaa' }}>{params[key]}</span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              value={params[key]}
              onChange={e => handleChange(key, Number(e.target.value))}
              style={{ width: '100%', accentColor: '#4a90d9' }}
            />
          </div>
        ))}

        <button
          onClick={handleReset}
          style={{ padding: '8px', background: '#333', border: '1px solid #555', borderRadius: '4px', color: '#fff', cursor: 'pointer' }}
        >
          重置
        </button>

        {error && <p style={{ color: '#e74c3c', fontSize: '0.85rem', margin: 0 }}>{error}</p>}

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px', background: '#4a90d9', border: 'none', borderRadius: '4px',
            color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '1rem',
          }}
        >
          {saving ? '保存中...' : '应用并保存'}
        </button>
      </div>
    </div>
  );
}
