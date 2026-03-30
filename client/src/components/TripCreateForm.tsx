import { useState, FormEvent } from 'react';
import axios from 'axios';

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
      const res = await axios.post('/api/trips', {
        title: title.trim(),
        description: description.trim() || undefined,
      });
      onCreated?.(res.data);
      setTitle('');
      setDescription('');
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data?.error?.message) {
        setError(err.response.data.error.message);
      } else {
        setError('创建旅行失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="创建旅行">
      <div>
        <label htmlFor="trip-title">旅行标题 *</label>
        <input
          id="trip-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="请输入旅行标题"
          required
        />
        {isTitleEmpty && title !== '' && (
          <p role="alert" style={{ color: 'red' }}>标题不能为空</p>
        )}
      </div>
      <div>
        <label htmlFor="trip-description">旅行说明</label>
        <textarea
          id="trip-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="请输入旅行说明（可选）"
        />
      </div>
      {error && <p role="alert" style={{ color: 'red' }}>{error}</p>}
      <button type="submit" disabled={isTitleEmpty || submitting}>
        {submitting ? '创建中...' : '创建旅行'}
      </button>
    </form>
  );
}
