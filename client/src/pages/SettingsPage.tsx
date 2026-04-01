import { useState, useEffect } from 'react';
import axios from 'axios';

interface TripItem {
  id: string;
  title: string;
  visibility: 'public' | 'unlisted';
  createdAt: string;
}

export default function SettingsPage() {
  const [trips, setTrips] = useState<TripItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchTrips() {
      try {
        const res = await axios.get<TripItem[]>('/api/trips');
        if (!cancelled) {
          setTrips(res.data);
        }
      } catch {
        if (!cancelled) {
          setError('加载旅行列表失败，请稍后重试');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    fetchTrips();
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(tripId: string, currentVisibility: 'public' | 'unlisted') {
    const newVisibility = currentVisibility === 'public' ? 'unlisted' : 'public';

    setTogglingIds((prev) => new Set(prev).add(tripId));
    setToggleError('');

    // Optimistically update
    setTrips((prev) =>
      prev.map((t) => (t.id === tripId ? { ...t, visibility: newVisibility } : t))
    );

    try {
      await axios.put(`/api/trips/${tripId}/visibility`, { visibility: newVisibility });
    } catch {
      // Rollback on failure
      setTrips((prev) =>
        prev.map((t) => (t.id === tripId ? { ...t, visibility: currentVisibility } : t))
      );
      setToggleError(`更新「${trips.find((t) => t.id === tripId)?.title}」的可见性失败，请重试`);
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(tripId);
        return next;
      });
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  if (loading) {
    return <div role="status" aria-label="加载中">加载中...</div>;
  }

  if (error) {
    return <div role="alert">{error}</div>;
  }

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '16px' }}>相册可见性设置</h1>

      {toggleError && (
        <div role="alert" style={{ color: '#d32f2f', marginBottom: '12px', fontSize: '0.9rem' }}>
          {toggleError}
        </div>
      )}

      {trips.length === 0 ? (
        <p>暂无旅行记录</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="旅行设置列表">
          {trips.map((trip) => (
            <li
              key={trip.id}
              data-testid={`settings-trip-${trip.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: '1px solid #eee',
              }}
            >
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{trip.title}</div>
                <div style={{ fontSize: '0.85rem', color: '#888' }}>
                  {formatDate(trip.createdAt)}
                  <span style={{ marginLeft: '12px' }}>
                    {trip.visibility === 'public' ? '公开' : '未公开'}
                  </span>
                </div>
              </div>
              <label
                style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '8px' }}
              >
                <span style={{ fontSize: '0.85rem', color: '#666' }}>
                  {trip.visibility === 'public' ? '公开' : '未公开'}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={trip.visibility === 'public'}
                  disabled={togglingIds.has(trip.id)}
                  onChange={() => handleToggle(trip.id, trip.visibility)}
                  aria-label={`切换「${trip.title}」可见性`}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
