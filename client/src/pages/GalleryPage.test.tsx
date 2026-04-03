import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import GalleryPage, { GalleryData } from './GalleryPage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

function renderGalleryPage(tripId = 'trip-1') {
  return render(
    <MemoryRouter initialEntries={[`/trips/${tripId}`]}>
      <Routes>
        <Route path="/trips/:id" element={<GalleryPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const sampleData: GalleryData = {
  trip: {
    id: 'trip-1',
    title: '东京之旅',
    description: '樱花季的美好回忆',
    coverImageId: 'img-1',
    userId: 'user-owner-1',
    createdAt: '2024-03-15T10:00:00.000Z',
    updatedAt: '2024-03-15T10:00:00.000Z',
  },
  images: [
    {
      item: {
        id: 'img-1',
        tripId: 'trip-1',
        filePath: '/uploads/trip-1/originals/img-1.jpg',
        thumbnailPath: '/uploads/trip-1/thumbnails/img-1_thumb.webp',
        mediaType: 'image',
        mimeType: 'image/jpeg',
        originalFilename: 'sakura.jpg',
        fileSize: 2048000,
        width: 1920,
        height: 1080,
      },
      isDefault: true,
      thumbnailUrl: '/api/media/img-1/thumbnail',
      originalUrl: '/api/media/img-1/original',
    },
    {
      item: {
        id: 'img-2',
        tripId: 'trip-1',
        filePath: '/uploads/trip-1/originals/img-2.jpg',
        mediaType: 'image',
        mimeType: 'image/jpeg',
        originalFilename: 'temple.jpg',
        fileSize: 1500000,
        width: 1600,
        height: 1200,
      },
      isDefault: false,
      duplicateGroup: {
        id: 'group-1',
        tripId: 'trip-1',
        defaultImageId: 'img-1',
        imageCount: 2,
      },
      thumbnailUrl: '/api/media/img-2/thumbnail',
      originalUrl: '/api/media/img-2/original',
    },
  ],
  videos: [
    {
      id: 'vid-1',
      tripId: 'trip-1',
      filePath: '/uploads/trip-1/originals/vid-1.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'sunset.mp4',
      fileSize: 52428800,
      thumbnailUrl: '/api/media/vid-1/thumbnail',
    },
  ],
};

describe('GalleryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockedAxios.get.mockReturnValue(new Promise(() => {}));
    renderGalleryPage();
    expect(screen.getByRole('status', { name: /加载中/ })).toBeDefined();
  });

  it('fetches gallery data from GET /api/trips/:id/gallery on mount', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage('trip-1');

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith('/api/trips/trip-1/gallery');
    });
  });

  it('displays trip title and description', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });
    expect(screen.getByText('樱花季的美好回忆')).toBeDefined();
  });

  it('renders images in a grid layout', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('image-grid')).toBeDefined();
    });

    const grid = screen.getByTestId('image-grid');
    expect(grid.style.display).toBe('grid');
    expect(grid.style.gridTemplateColumns).toContain('repeat');

    const images = screen.getAllByRole('img');
    const thumbnails = images.filter(img => img.getAttribute('src')?.includes('/thumbnail'));
    expect(thumbnails).toHaveLength(3);
    expect(thumbnails[0]).toHaveAttribute('src', '/api/media/img-1/thumbnail');
    expect(thumbnails[1]).toHaveAttribute('src', '/api/media/img-2/thumbnail');
    expect(thumbnails[2]).toHaveAttribute('src', '/api/media/vid-1/thumbnail');
  });

  it('renders videos in a grid layout', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('video-grid')).toBeDefined();
    });

    const grid = screen.getByTestId('video-grid');
    expect(grid.style.display).toBe('grid');
    expect(grid.style.gridTemplateColumns).toContain('repeat');

    expect(screen.getByTestId('video-vid-1')).toBeDefined();
    expect(screen.getByTestId('play-icon-vid-1')).toBeDefined();
  });

  it('shows error message when fetch fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network Error'));
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(screen.getByText(/加载相册数据失败/)).toBeDefined();
  });

  it('shows empty state when no images or videos', async () => {
    const emptyData: GalleryData = {
      trip: { ...sampleData.trip },
      images: [],
      videos: [],
    };
    mockedAxios.get.mockResolvedValueOnce({ data: emptyData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByLabelText('空状态')).toBeDefined();
    });
    expect(screen.getByText(/还没有素材/)).toBeDefined();
  });

  it('shows images section heading with count', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('图片 (2)')).toBeDefined();
    });
  });

  it('shows videos section heading with count', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('视频 (1)')).toBeDefined();
    });
  });

  it('hides images section when no images', async () => {
    const noImagesData: GalleryData = {
      trip: { ...sampleData.trip },
      images: [],
      videos: sampleData.videos,
    };
    mockedAxios.get.mockResolvedValueOnce({ data: noImagesData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('video-grid')).toBeDefined();
    });
    expect(screen.queryByLabelText('图片区域')).toBeNull();
  });

  it('hides videos section when no videos', async () => {
    const noVideosData: GalleryData = {
      trip: { ...sampleData.trip },
      images: sampleData.images,
      videos: [],
    };
    mockedAxios.get.mockResolvedValueOnce({ data: noVideosData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('image-grid')).toBeDefined();
    });
    expect(screen.queryByLabelText('视频区域')).toBeNull();
  });

  it('renders a back link to homepage', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText(/返回首页/)).toBeDefined();
    });
    expect(screen.getByText(/返回首页/).closest('a')).toHaveAttribute('href', '/');
  });

  it('does not show description when trip has none', async () => {
    const noDescData: GalleryData = {
      trip: { ...sampleData.trip, description: undefined },
      images: sampleData.images,
      videos: sampleData.videos,
    };
    mockedAxios.get.mockResolvedValueOnce({ data: noDescData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });
    expect(screen.queryByText('樱花季的美好回忆')).toBeNull();
  });

  it('does not render any edit controls (read-only mode)', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });

    expect(screen.queryByTestId('edit-trip-btn')).toBeNull();
    expect(screen.queryByTestId('append-media-btn')).toBeNull();
    expect(screen.queryByTestId('change-cover-btn')).toBeNull();
    expect(screen.queryByTestId('trash-zone')).toBeNull();
  });
});
