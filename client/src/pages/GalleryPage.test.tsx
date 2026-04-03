import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import GalleryPage, { GalleryData } from './GalleryPage';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const TEST_OWNER_ID = 'user-owner-1';

// Mock AuthContext
const mockAuthFetch = vi.fn();
let mockAuthValue = {
  token: null as string | null,
  user: null as { userId: string; username: string; role: 'admin' | 'regular' } | null,
  isLoggedIn: false,
  login: vi.fn(),
  logout: vi.fn(),
  register: vi.fn(),
};

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => mockAuthValue,
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function setLoggedOut() {
  mockAuthValue = {
    token: null,
    user: null,
    isLoggedIn: false,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  };
}

function setLoggedInAsOwner() {
  mockAuthValue = {
    token: 'fake-token',
    user: { userId: TEST_OWNER_ID, username: 'owner', role: 'regular' },
    isLoggedIn: true,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  };
}

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
    userId: TEST_OWNER_ID,
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
    setLoggedOut();
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

  // --- Non-owner should not see edit controls ---
  it('hides edit/append/cover buttons for non-owner', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByText('东京之旅')).toBeDefined();
    });

    expect(screen.queryByTestId('edit-trip-btn')).toBeNull();
    expect(screen.queryByTestId('append-media-btn')).toBeNull();
    expect(screen.queryByTestId('change-cover-btn')).toBeNull();
  });

  // --- Owner can see edit controls ---
  it('shows edit button for trip owner and opens edit modal on click', async () => {
    setLoggedInAsOwner();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('edit-trip-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-modal')).toBeDefined();
    });
    expect(screen.getByLabelText('旅行标题 *')).toHaveValue('东京之旅');
    expect(screen.getByLabelText('旅行说明')).toHaveValue('樱花季的美好回忆');
  });

  it('saves edited trip info via authFetch PUT', async () => {
    setLoggedInAsOwner();
    const user = userEvent.setup();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });

    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...sampleData.trip, title: '大阪之旅', description: '美食天堂' }),
    });

    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('edit-trip-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-modal')).toBeDefined();
    });

    const titleInput = screen.getByLabelText('旅行标题 *');
    await user.clear(titleInput);
    await user.type(titleInput, '大阪之旅');

    const descInput = screen.getByLabelText('旅行说明');
    await user.clear(descInput);
    await user.type(descInput, '美食天堂');

    fireEvent.click(screen.getByTestId('edit-save-btn'));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/trips/trip-1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('大阪之旅')).toBeDefined();
    });
  });

  it('closes edit modal on cancel', async () => {
    setLoggedInAsOwner();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('edit-trip-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('edit-trip-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('edit-cancel-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('edit-trip-modal')).toBeNull();
    });
  });

  // --- Cover image picker tests ---
  it('shows change cover button for owner and opens cover picker', async () => {
    setLoggedInAsOwner();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-cover-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('change-cover-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('cover-picker-modal')).toBeDefined();
    });
    expect(screen.getByTestId('cover-pick-img-1')).toBeDefined();
    expect(screen.getByTestId('cover-pick-img-2')).toBeDefined();
  });

  it('calls PUT cover via authFetch when selecting a cover image', async () => {
    setLoggedInAsOwner();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });

    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-cover-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('change-cover-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('cover-picker-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('cover-pick-img-2'));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/trips/trip-1/cover',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  // --- Default image picker tests ---
  it('shows change default button for duplicate groups with multiple images', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-default-btn-group-1')).toBeDefined();
    });
  });

  it('opens default image picker and fetches group members', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-default-btn-group-1')).toBeDefined();
    });

    mockedAxios.get.mockResolvedValueOnce({
      data: {
        group: { id: 'group-1', tripId: 'trip-1', defaultImageId: 'img-1', imageCount: 2 },
        images: [
          { id: 'img-1', originalFilename: 'sakura.jpg', thumbnailUrl: '/api/media/img-1/thumbnail' },
          { id: 'img-3', originalFilename: 'sakura2.jpg', thumbnailUrl: '/api/media/img-3/thumbnail' },
        ],
      },
    });

    fireEvent.click(screen.getByTestId('change-default-btn-group-1'));

    await waitFor(() => {
      expect(screen.getByTestId('default-picker-modal')).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByTestId('default-pick-img-1')).toBeDefined();
      expect(screen.getByTestId('default-pick-img-3')).toBeDefined();
    });
  });

  it('calls PUT default via authFetch when selecting a default image', async () => {
    setLoggedInAsOwner();
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });
    renderGalleryPage();

    await waitFor(() => {
      expect(screen.getByTestId('change-default-btn-group-1')).toBeDefined();
    });

    mockedAxios.get.mockResolvedValueOnce({
      data: {
        group: { id: 'group-1', tripId: 'trip-1', defaultImageId: 'img-1', imageCount: 2 },
        images: [
          { id: 'img-1', originalFilename: 'sakura.jpg', thumbnailUrl: '/api/media/img-1/thumbnail' },
          { id: 'img-3', originalFilename: 'sakura2.jpg', thumbnailUrl: '/api/media/img-3/thumbnail' },
        ],
      },
    });

    fireEvent.click(screen.getByTestId('change-default-btn-group-1'));

    await waitFor(() => {
      expect(screen.getByTestId('default-pick-img-3')).toBeDefined();
    });

    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    // Mock the subsequent gallery refresh
    mockedAxios.get.mockResolvedValueOnce({ data: sampleData });

    fireEvent.click(screen.getByTestId('default-pick-img-3'));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/duplicate-groups/group-1/default',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });
});
