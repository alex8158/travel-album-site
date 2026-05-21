import { useState, FormEvent } from 'react';
import { authFetch } from '../contexts/AuthContext';

export interface TripCreateFormProps {
  onCreated?: (trip: { id: string; title: string; description?: string }) => void;
}

export default function TripCreateForm({ onCreated }: TripCreateFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isTitleEmpty = title.trim().length === 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isTitleEmpty) return;

    setSubmitting(true);
    setError('');

    try {
      const res = await authFetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || '创建旅行失败，请重试');
      }
      const data = await res.json();
      onCreated?.(data);
      setTitle('');
      setDescription('');
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('创建旅行失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="创建旅行">
      <div style={{ marginBottom: '16px' }}>
        <label htmlFor="trip-title" style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500 }}>
          旅行标题 <span style={{ color: 'var(--color-danger)' }}>*</span>
        </label>
        <input
          id="trip-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="请输入旅行标题"
          required
          className="form-input"
        />
        {isTitleEmpty && title !== '' && (
          <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginTop: '4px' }}>标题不能为空</p>
        )}
      </div>
      <div style={{ marginBottom: '24px' }}>
        <label htmlFor="trip-description" style={{ display: 'block', marginBottom: '6px', fontSize: '0.9rem', fontWeight: 500 }}>
          旅行说明
        </label>
        <textarea
          id="trip-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="请输入旅行说明（可选）"
          className="form-input"
          style={{ minHeight: '80px', resize: 'vertical' }}
        />
      </div>
      {error && <p role="alert" style={{ color: 'var(--color-danger)', fontSize: '0.9rem', marginBottom: '12px' }}>{error}</p>}
      <button
        type="submit"
        disabled={isTitleEmpty || submitting}
        className="btn-primary"
        style={{ width: '100%', padding: '10px', fontSize: '1rem', opacity: (isTitleEmpty || submitting) ? 0.6 : 1 }}
      >
        {submitting ? '创建中...' : '创建旅行'}
      </button>
    </form>
  );
}
