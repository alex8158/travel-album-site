import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import GalleryPage, { GalleryData } from './GalleryPage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// Mock the api module for getHighlightPhotos and getTierPhotos
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return {
    ...actual,
    getTierPhotos: vi.fn().mockRejectedValue(new Error('not found')),
    getHighlightPhotos: vi.fn().mockRejectedValue(new Error('not found')),
  };
});

import { getTierPhotos, getHighlightPhotos } from '../api';
const mockedGetTierPhotos = vi.mocked(getTierPhotos);
const mockedGetHighlightPhotos = vi.mocked(getHighlightPhotos);

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

  describe('Gallery Mode Tabs (全部/精华)', () => {
    const publicTripData: GalleryData = {
      trip: {
        ...sampleData.trip,
        visibility: 'public',
      },
      images: sampleData.images,
      videos: sampleData.videos,
    };

    const highlightPhotosMock = [
      { id: 'hl-1', filePath: '/path/hl-1.jpg', thumbnailUrl: '/api/media/hl-1/thumbnail', originalUrl: '/api/media/hl-1/original', category: 'animal', reason: 'nice' },
      { id: 'hl-2', filePath: '/path/hl-2.jpg', thumbnailUrl: '/api/media/hl-2/thumbnail', originalUrl: '/api/media/hl-2/original', category: 'landscape', reason: 'beautiful' },
    ];

    const tierPhotosMock = [
      { id: 'tier-1', filePath: '/path/tier-1.jpg', thumbnailUrl: '/api/media/tier-1/thumbnail', originalUrl: '/api/media/tier-1/original', category: 'animal', reason: 'top' },
    ];

    it('shows gallery mode tabs for public trips', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: null });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('gallery-mode-tabs')).toBeDefined();
      });

      const tabs = screen.getByTestId('gallery-mode-tabs');
      expect(tabs.querySelectorAll('button')).toHaveLength(2);
      expect(screen.getByText('精选')).toBeDefined();
      expect(screen.getByText('精华')).toBeDefined();
    });

    it('defaults to "全部" tab being active', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: null });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('gallery-mode-tabs')).toBeDefined();
      });

      const allTab = screen.getByText('精选');
      expect(allTab.className).toContain('active');
      const tierTab = screen.getByText('精华');
      expect(tierTab.className).not.toContain('active');
    });

    it('does not show gallery mode tabs for unlisted trips', async () => {
      const unlistedData: GalleryData = {
        trip: { ...sampleData.trip, visibility: 'unlisted' },
        images: sampleData.images,
        videos: sampleData.videos,
      };
      mockedAxios.get.mockResolvedValueOnce({ data: unlistedData });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByText('该相册未公开')).toBeDefined();
      });
      expect(screen.queryByTestId('gallery-mode-tabs')).toBeNull();
    });

    it('shows highlight photos grid when "全部" tab is active', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: null });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('highlight-photos-grid')).toBeDefined();
      });

      expect(screen.getByTestId('highlight-photo-hl-1')).toBeDefined();
      expect(screen.getByTestId('highlight-photo-hl-2')).toBeDefined();
    });

    it('shows tier photos and slideshow when "精华" tab is clicked', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: '/slideshow/test.mp4' });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('gallery-mode-tabs')).toBeDefined();
      });

      // Click "精华" tab
      fireEvent.click(screen.getByText('精华'));

      await waitFor(() => {
        expect(screen.getByTestId('tier-photos-grid')).toBeDefined();
      });

      expect(screen.getByTestId('tier-photo-tier-1')).toBeDefined();
      expect(screen.getByTestId('tier-slideshow-video')).toBeDefined();
    });

    it('hides highlight grid and shows tier content when switching to "精华" tab', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: null });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('highlight-photos-grid')).toBeDefined();
      });

      // Switch to "精华" tab
      fireEvent.click(screen.getByText('精华'));

      expect(screen.queryByTestId('highlight-photos-grid')).toBeNull();
      expect(screen.getByTestId('tier-photos-grid')).toBeDefined();
    });

    it('uses pill-tabs styling for gallery mode tabs', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: publicTripData });
      mockedGetHighlightPhotos.mockResolvedValueOnce({ photos: highlightPhotosMock });
      mockedGetTierPhotos.mockResolvedValueOnce({ photos: tierPhotosMock, slideshowUrl: null });
      renderGalleryPage();

      await waitFor(() => {
        expect(screen.getByTestId('gallery-mode-tabs')).toBeDefined();
      });

      const tabBar = screen.getByTestId('gallery-mode-tabs');
      expect(tabBar.className).toContain('pill-tabs');

      const buttons = tabBar.querySelectorAll('button');
      buttons.forEach(btn => {
        expect(btn.className).toContain('pill-tab');
      });
    });
  });
});
