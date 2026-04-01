import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import HomePage, { TripSummary } from './HomePage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

function renderHomePage() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

const sampleTrips: TripSummary[] = [
  {
    id: 'trip-1',
    title: '东京之旅',
    descriptionExcerpt: '樱花季的美好回忆',
    coverImageUrl: '/api/media/img1/thumbnail',
    mediaCount: 42,
    visibility: 'public',
    createdAt: '2024-03-15T10:00:00.000Z',
  },
  {
    id: 'trip-2',
    title: '巴黎之旅',
    coverImageUrl: '/api/media/img2/thumbnail',
    mediaCount: 18,
    visibility: 'public',
    createdAt: '2024-02-10T08:00:00.000Z',
  },
];

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockedAxios.get.mockReturnValue(new Promise(() => {})); // never resolves
    renderHomePage();
    expect(screen.getByRole('status', { name: /加载中/ })).toBeDefined();
  });

  it('fetches trips from GET /api/trips on mount', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith('/api/trips');
    });
  });

  it('displays trip cards with title, cover image, and media count', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });

    expect(screen.getByText('巴黎之旅')).toBeDefined();
    expect(screen.getByText('42 个素材')).toBeDefined();
    expect(screen.getByText('18 个素材')).toBeDefined();

    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', '/api/media/img1/thumbnail');
    expect(images[1]).toHaveAttribute('src', '/api/media/img2/thumbnail');
  });

  it('displays description excerpt when available', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText('樱花季的美好回忆')).toBeDefined();
    });
  });

  it('renders trip cards as links to /trips/:id', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByTestId('trip-card-trip-1')).toBeDefined();
    });

    const link1 = screen.getByTestId('trip-card-trip-1');
    const link2 = screen.getByTestId('trip-card-trip-2');
    expect(link1).toHaveAttribute('href', '/trips/trip-1');
    expect(link2).toHaveAttribute('href', '/trips/trip-2');
  });

  it('shows empty state when no trips exist', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByLabelText('空状态')).toBeDefined();
    });

    expect(screen.getByText(/还没有旅行记录/)).toBeDefined();
  });

  it('shows error message when fetch fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network Error'));
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });

    expect(screen.getByText(/加载旅行列表失败/)).toBeDefined();
  });

  it('uses responsive grid layout', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByLabelText('旅行列表')).toBeDefined();
    });

    const grid = screen.getByLabelText('旅行列表');
    expect(grid.style.display).toBe('grid');
    expect(grid.style.gridTemplateColumns).toContain('repeat');
  });

  it('shows "未公开" label on unlisted trip cards', async () => {
    const tripsWithUnlisted: TripSummary[] = [
      { ...sampleTrips[0], visibility: 'unlisted' },
      sampleTrips[1],
    ];
    mockedAxios.get.mockResolvedValueOnce({ data: tripsWithUnlisted });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText('未公开')).toBeDefined();
    });

    expect(screen.getByTestId('unlisted-label-trip-1')).toBeDefined();
  });

  it('does not show "未公开" label on public trip cards', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleTrips });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });

    expect(screen.queryByText('未公开')).toBeNull();
  });

  it('unlisted trip cards are not clickable (no link)', async () => {
    const tripsWithUnlisted: TripSummary[] = [
      { ...sampleTrips[0], visibility: 'unlisted' },
      sampleTrips[1],
    ];
    mockedAxios.get.mockResolvedValueOnce({ data: tripsWithUnlisted });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByTestId('trip-card-trip-1')).toBeDefined();
    });

    const unlistedCard = screen.getByTestId('trip-card-trip-1');
    expect(unlistedCard.tagName).toBe('DIV');
    expect(unlistedCard).not.toHaveAttribute('href');
  });

  it('public trip cards are clickable links', async () => {
    const tripsWithUnlisted: TripSummary[] = [
      { ...sampleTrips[0], visibility: 'unlisted' },
      sampleTrips[1],
    ];
    mockedAxios.get.mockResolvedValueOnce({ data: tripsWithUnlisted });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByTestId('trip-card-trip-2')).toBeDefined();
    });

    const publicCard = screen.getByTestId('trip-card-trip-2');
    expect(publicCard.tagName).toBe('A');
    expect(publicCard).toHaveAttribute('href', '/trips/trip-2');
  });

  it('unlisted trip cards have reduced opacity', async () => {
    const tripsWithUnlisted: TripSummary[] = [
      { ...sampleTrips[0], visibility: 'unlisted' },
      sampleTrips[1],
    ];
    mockedAxios.get.mockResolvedValueOnce({ data: tripsWithUnlisted });
    renderHomePage();

    await waitFor(() => {
      expect(screen.getByLabelText('东京之旅')).toBeDefined();
    });

    const unlistedArticle = screen.getByLabelText('东京之旅');
    expect(unlistedArticle.style.opacity).toBe('0.5');

    const publicArticle = screen.getByLabelText('巴黎之旅');
    expect(publicArticle.style.opacity).toBe('1');
  });
});
