import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { authFetch } from '../contexts/AuthContext';

interface Trip {
  id: string;
  title: string;
  coverImageUrl: string;
  mediaCount: number;
  visibility: string;
  createdAt: string;
}

export default function AdminUserTripsPage() {
  const { userId } = useParams<{ userId: string }>();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchTrips() {
      try {
        const res = await authFetch(`/api/admin/users/${userId}/trips`);
        if (!res.ok) throw new Error('加载失败');
        const json = await res.json();
        if (!cancelled) setTrips(json.trips ?? []);
      } catch {
        if (!cancelled) setError('加载用户相册列表失败，请稍后重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (userId) fetchTrips();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) return <div role="status" aria-label="加载中">加载中...</div>;
  if (error) return <div role="alert">{error}</div>;

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px 16px' }}>
      <Link to="/admin" style={{ display: 'inline-block', marginBottom: '16px' }}>
        ← 返回管理后台
      </Link>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '16px' }}>
        用户相册
      </h1>
      {trips.length === 0 ? (
        <p>该用户还没有创建相册。</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '16px',
          }}
        >
          {trips.map((trip) => (
            <Link
              key={trip.id}
              to={`/my/trips/${trip.id}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <article
                style={{
                  border: '1px solid #ddd',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    background: trip.visibility === 'public' ? '#e8f5e9' : '#fff3e0',
                    color: trip.visibility === 'public' ? '#2e7d32' : '#e65100',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    zIndex: 1,
                  }}
                >
                  {trip.visibility === 'public' ? '公开' : '不公开'}
                </span>
                <img
                  src={trip.coverImageUrl}
                  alt={`${trip.title} 封面`}
                  style={{ width: '100%', height: '180px', objectFit: 'cover' }}
                />
                <div style={{ padding: '12px' }}>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: '1.1rem' }}>{trip.title}</h2>
                  <span style={{ fontSize: '0.85rem', color: '#999' }}>
                    {trip.mediaCount ?? 0} 个素材
                  </span>
                </div>
              </article>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
