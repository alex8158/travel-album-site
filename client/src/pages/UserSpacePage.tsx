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
    <div className="page-container" style={{ maxWidth: '960px' }}>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1>我的空间</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          {user?.role === 'admin' && (
            <Link to="/admin" className="btn-link" style={{ textDecoration: 'none', color: '#666', border: '1px solid #ccc', borderRadius: 'var(--radius)', padding: '6px 16px', fontSize: '0.9rem' }}>
              会员管理
            </Link>
          )}
          <Link to="/upload" className="nav-btn-primary" style={{ textDecoration: 'none' }}>
            + 新建相册
          </Link>
        </div>
      </div>
      {trips.length === 0 ? (
        <div className="empty-state">
          <p>还没有创建相册</p>
          <Link to="/upload" className="btn-primary" style={{ display: 'inline-block', padding: '8px 20px', borderRadius: 'var(--radius)', textDecoration: 'none' }}>创建一个</Link>
        </div>
      ) : (
        <div className="trip-grid" style={{ padding: 0 }}>
          {trips.map((trip) => (
            <article key={trip.id} className="trip-card">
              <Link to={`/my/trips/${trip.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <img
                  src={trip.coverImageUrl}
                  alt={`${trip.title} 封面`}
                  style={{ width: '100%', height: '180px', objectFit: 'cover' }}
                />
                <div className="trip-card-body">
                  <h2>{trip.title}</h2>
                  <span>{trip.mediaCount ?? 0} 个素材</span>
                </div>
              </Link>
              <div style={{ padding: '8px 16px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span className={`badge ${trip.visibility === 'public' ? 'badge-success' : 'badge-warning'}`}>
                  {trip.visibility === 'public' ? '公开' : '不公开'}
                </span>
                <button
                  onClick={() => handleToggleVisibility(trip.id, trip.visibility)}
                  style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                  aria-label={`切换可见性 ${trip.title}`}
                >
                  {trip.visibility === 'public' ? '设为不公开' : '设为公开'}
                </button>
                <button
                  onClick={() => handleDeleteTrip(trip.id)}
                  className="btn-danger"
                  style={{ padding: '2px 8px', fontSize: '0.75rem' }}
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
