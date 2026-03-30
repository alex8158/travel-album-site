import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

export interface TripSummary {
  id: string;
  title: string;
  descriptionExcerpt?: string;
  coverImageUrl: string;
  mediaCount: number;
  createdAt: string;
}

export default function HomePage() {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchTrips() {
      try {
        const res = await axios.get<TripSummary[]>('/api/trips');
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

  if (loading) {
    return <div role="status" aria-label="加载中">加载中...</div>;
  }

  if (error) {
    return <div role="alert">{error}</div>;
  }

  if (trips.length === 0) {
    return <div aria-label="空状态">还没有旅行记录，快去创建一个吧！</div>;
  }

  return (
    <div
      aria-label="旅行列表"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: '16px',
        padding: '16px',
      }}
    >
      {trips.map((trip) => (
        <Link
          key={trip.id}
          to={`/trips/${trip.id}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
          data-testid={`trip-card-${trip.id}`}
        >
          <article
            aria-label={trip.title}
            style={{
              border: '1px solid #ddd',
              borderRadius: '8px',
              overflow: 'hidden',
            }}
          >
            <img
              src={trip.coverImageUrl}
              alt={`${trip.title} 封面`}
              style={{ width: '100%', height: '200px', objectFit: 'cover' }}
            />
            <div style={{ padding: '12px' }}>
              <h2 style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>{trip.title}</h2>
              {trip.descriptionExcerpt && (
                <p style={{ margin: '0 0 8px 0', color: '#666' }}>{trip.descriptionExcerpt}</p>
              )}
              <span style={{ fontSize: '0.85rem', color: '#999' }}>{trip.mediaCount} 个素材</span>
            </div>
          </article>
        </Link>
      ))}
    </div>
  );
}
