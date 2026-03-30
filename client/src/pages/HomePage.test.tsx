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
    createdAt: '2024-03-15T10:00:00.000Z',
  },
  {
    id: 'trip-2',
    title: '巴黎之旅',
    coverImageUrl: '/api/media/img2/thumbnail',
    mediaCount: 18,
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
});
