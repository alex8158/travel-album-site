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
    return <div role="status" aria-label="加载中" style={{ padding: '48px 24px', textAlign: 'center' }}>加载中...</div>;
  }

  if (error) {
    return <div role="alert" style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--color-danger)' }}>{error}</div>;
  }

  if (trips.length === 0) {
    return (
      <div aria-label="空状态" style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--color-text-secondary)' }}>
        还没有公开的旅行记录。
      </div>
    );
  }

  return (
    <div>
      <section className="hero">
        <h1>🌍 旅行相册</h1>
        <p>记录每一段旅途的美好瞬间</p>
      </section>
      <div
        aria-label="旅行列表"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '24px',
          padding: '0 24px 24px',
          maxWidth: '1200px',
          margin: '0 auto',
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
              className="trip-card"
            >
              <img
                src={trip.coverImageUrl}
                alt={`${trip.title} 封面`}
                style={{ width: '100%', height: '200px', objectFit: 'cover' }}
              />
              <div className="trip-card-body">
                <h2>{trip.title}</h2>
                {trip.descriptionExcerpt && (
                  <p>{trip.descriptionExcerpt}</p>
                )}
                <span>{trip.mediaCount} 个素材</span>
              </div>
            </article>
          </Link>
        ))}
      </div>
    </div>
  );
}
