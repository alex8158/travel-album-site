import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { authFetch } from '../contexts/AuthContext';

interface Trip {
  id: string;
  title: string;
  coverImageUrl: string;
  mediaCount: number;
  visibility: string;
  createdAt: string;
}

export default function UserSpacePage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchTrips() {
      try {
        const res = await authFetch('/api/users/me/trips');
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

  if (loading) return <div role="status" aria-label="加载中">加载中...</div>;
  if (error) return <div role="alert">{error}</div>;

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '16px' }}>我的空间</h1>
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
            <Link
              key={trip.id}
              to={`/trips/${trip.id}`}
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
                {trip.visibility !== 'public' && (
                  <span
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      background: 'rgba(0,0,0,0.6)',
                      color: '#fff',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      zIndex: 1,
                    }}
                  >
                    未公开
                  </span>
                )}
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
