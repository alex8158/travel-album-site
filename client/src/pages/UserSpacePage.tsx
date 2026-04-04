import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, authFetch } from '../contexts/AuthContext';

interface Trip {
  id: string;
  title: string;
  coverImageUrl: string;
  mediaCount: number;
  visibility: string;
  createdAt: string;
}

export default function UserSpacePage() {
  const { user } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchTrips() {
      try {
        const res = await authFetch('/api/my/trips');
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        if (!cancelled) setTrips(data.trips ?? []);
      } catch {
        if (!cancelled) setError('加载相册列表失败，请稍后重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchTrips();
    return () => { cancelled = true; };
  }, []);

  async function handleToggleVisibility(tripId: string, currentVisibility: string) {
    const newVisibility = currentVisibility === 'public' ? 'unlisted' : 'public';
    // Optimistic update
    setTrips(prev => prev.map(t => t.id === tripId ? { ...t, visibility: newVisibility } : t));
    try {
      const res = await authFetch(`/api/trips/${tripId}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: newVisibility }),
      });
      if (!res.ok) throw new Error('切换失败');
    } catch {
      // Rollback on failure
      setTrips(prev => prev.map(t => t.id === tripId ? { ...t, visibility: currentVisibility } : t));
      alert('切换可见性失败，请重试');
    }
  }

  async function handleDeleteTrip(tripId: string) {
    if (!window.confirm('确定要删除这个相册吗？此操作不可撤销。')) return;
    try {
      const res = await authFetch(`/api/trips/${tripId}`, { method: 'DELETE' });
      if (res.ok) {
        setTrips(prev => prev.filter(t => t.id !== tripId));
      } else {
        const data = await res.json();
        alert(data.error?.message || '删除失败');
      }
    } catch {
      alert('删除失败，请稍后重试');
    }
  }

  if (loading) return <div role="status" aria-label="加载中">加载中...</div>;
  if (error) return <div role="alert">{error}</div>;

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>我的空间</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {user?.role === 'admin' && (
            <Link
              to="/admin"
              style={{
                textDecoration: 'none',
                color: '#666',
                border: '1px solid #ccc',
                borderRadius: '4px',
                padding: '6px 16px',
                fontSize: '0.9rem',
              }}
            >
              会员管理
            </Link>
          )}
          <Link
            to="/upload"
            style={{
              textDecoration: 'none',
              color: '#fff',
              backgroundColor: '#4a90d9',
              padding: '6px 16px',
              borderRadius: '4px',
              fontSize: '0.9rem',
            }}
          >
            + 新建相册
          </Link>
        </div>
      </div>
      {trips.length === 0 ? (
        <p>还没有创建相册，去<Link to="/upload">创建一个</Link>吧！</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '16px',
          }}
        >
          {trips.map((trip) => (
            <article
              key={trip.id}
              style={{
                border: '1px solid #ddd',
                borderRadius: '8px',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <Link
                to={`/my/trips/${trip.id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <img
                  src={trip.coverImageUrl}
                  alt={`${trip.title} 封面`}
                  style={{ width: '100%', height: '180px', objectFit: 'cover' }}
                />
                <div style={{ padding: '12px 12px 4px' }}>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: '1.1rem' }}>{trip.title}</h2>
                  <span style={{ fontSize: '0.85rem', color: '#999' }}>
                    {trip.mediaCount ?? 0} 个素材
                  </span>
                </div>
              </Link>
              <div style={{ padding: '8px 12px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: trip.visibility === 'public' ? '#e8f5e9' : '#fff3e0',
                    color: trip.visibility === 'public' ? '#2e7d32' : '#e65100',
                  }}
                >
                  {trip.visibility === 'public' ? '公开' : '不公开'}
                </span>
                <button
                  onClick={() => handleToggleVisibility(trip.id, trip.visibility)}
                  style={{
                    background: 'none',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                  aria-label={`切换可见性 ${trip.title}`}
                >
                  {trip.visibility === 'public' ? '设为不公开' : '设为公开'}
                </button>
                <button
                  onClick={() => handleDeleteTrip(trip.id)}
                  style={{
                    background: 'none',
                    border: '1px solid #e74c3c',
                    borderRadius: '4px',
                    padding: '2px 8px',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    color: '#e74c3c',
                  }}
                  aria-label={`删除相册 ${trip.title}`}
                >
                  删除相册
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
