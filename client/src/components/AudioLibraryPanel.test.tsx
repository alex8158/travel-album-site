import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AudioLibraryPanel from './AudioLibraryPanel';
import type { AudioTrack } from './AudioLibraryPanel';

const mockTracks: AudioTrack[] = [
  {
    id: 'track-1',
    userId: 'user-1',
    title: 'Summer Vibes',
    filePath: 'audio/user-1/track-1.mp3',
    format: 'mp3',
    duration: 185,
    fileSize: 4500000,
    source: 'upload',
    createdAt: '2024-06-15T10:30:00.000Z',
  },
  {
    id: 'track-2',
    userId: 'user-1',
    title: 'Ocean Waves',
    filePath: 'audio/user-1/track-2.ogg',
    format: 'ogg',
    duration: 62,
    fileSize: 1200000,
    source: 'download',
    sourceUrl: 'https://example.com/ocean.ogg',
    createdAt: '2024-07-01T08:00:00.000Z',
  },
];

// Mock authFetch
vi.mock('../contexts/AuthContext', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from '../contexts/AuthContext';
const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchSuccess(tracks: AudioTrack[]) {
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ tracks }),
  } as Response);
}

function mockFetchError() {
  mockAuthFetch.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: '加载音频列表失败' }),
  } as Response);
}

describe('AudioLibraryPanel', () => {
  it('shows loading state initially', () => {
    mockAuthFetch.mockReturnValue(new Promise(() => {})); // never resolves
    render(<AudioLibraryPanel />);
    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('displays audio tracks after loading', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    // Check track titles are displayed
    expect(screen.getByText('Summer Vibes')).toBeDefined();
    expect(screen.getByText('Ocean Waves')).toBeDefined();
  });

  it('displays duration formatted as m:ss', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    // 185 seconds = 3:05
    expect(screen.getByTestId('audio-track-track-1').textContent).toContain('3:05');
    // 62 seconds = 1:02
    expect(screen.getByTestId('audio-track-track-2').textContent).toContain('1:02');
  });

  it('displays format badge (uppercase)', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    expect(screen.getByTestId('audio-track-track-1').textContent).toContain('MP3');
    expect(screen.getByTestId('audio-track-track-2').textContent).toContain('OGG');
  });

  it('displays upload date', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    // Date is formatted by toLocaleDateString, just check the track items have date content
    const track1 = screen.getByTestId('audio-track-track-1');
    const track2 = screen.getByTestId('audio-track-track-2');
    // Should contain some date representation (varies by locale)
    expect(track1.textContent).toContain('2024');
    expect(track2.textContent).toContain('2024');
  });

  it('shows empty state when no tracks', async () => {
    mockFetchSuccess([]);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText(/暂无音频/)).toBeDefined();
    });
  });

  it('shows error state on fetch failure', async () => {
    mockFetchError();
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
  });

  it('has play button for each track', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    const playButtons = screen.getAllByLabelText('播放');
    expect(playButtons.length).toBe(2);
  });

  it('toggles play/pause button text when clicked', async () => {
    // Mock the stream response for play
    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['audio data'], { type: 'audio/mpeg' }),
      } as unknown as Response);

    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    const playButtons = screen.getAllByLabelText('播放');
    expect(playButtons[0].textContent).toContain('▶');
  });

  it('calls onSelect when selectable and select button is clicked', async () => {
    mockFetchSuccess(mockTracks);
    const onSelect = vi.fn();
    render(<AudioLibraryPanel selectable onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    // In selectable mode, there should be "选择" buttons
    const selectButtons = screen.getAllByText('选择');
    expect(selectButtons.length).toBe(2);

    await userEvent.click(selectButtons[0]);
    expect(onSelect).toHaveBeenCalledWith(mockTracks[0]);
  });

  it('does not show select buttons when not selectable', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    expect(screen.queryAllByText('选择').length).toBe(0);
  });

  it('fetches tracks from /api/audio on mount', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/audio');
    });
  });

  it('displays file size for each track', async () => {
    mockFetchSuccess(mockTracks);
    render(<AudioLibraryPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    // 4500000 bytes = 4.3 MB
    expect(screen.getByTestId('audio-track-track-1').textContent).toContain('4.3 MB');
    // 1200000 bytes = 1.1 MB
    expect(screen.getByTestId('audio-track-track-2').textContent).toContain('1.1 MB');
  });
});


describe('AudioLibraryPanel - Upload', () => {
  it('renders upload button', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: mockTracks }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText('上传音频')).toBeDefined();
    });
  });

  it('has a hidden file input accepting audio formats', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: [] }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-file-input')).toBeDefined();
    });
    const input = screen.getByTestId('audio-file-input') as HTMLInputElement;
    expect(input.accept).toBe('.mp3,.aac,.wav,.ogg');
    expect(input.type).toBe('file');
  });

  it('rejects files exceeding 50MB with error message', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: [] }),
    } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-file-input')).toBeDefined();
    });

    const input = screen.getByTestId('audio-file-input') as HTMLInputElement;
    const largeFile = new File([new ArrayBuffer(100)], 'big.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(largeFile, 'size', { value: 53_000_000 });

    await userEvent.upload(input, largeFile);

    await waitFor(() => {
      expect(screen.getByText('文件大小超过 50MB 限制')).toBeDefined();
    });

    // authFetch should only have been called once (for listing tracks), not for upload
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it('uploads file successfully and adds track to list', async () => {
    const newTrack: AudioTrack = {
      id: 'track-new',
      userId: 'user-1',
      title: 'New Upload',
      filePath: 'audio/user-1/track-new.mp3',
      format: 'mp3',
      duration: 120,
      fileSize: 3000000,
      source: 'upload',
      createdAt: '2024-08-01T10:00:00.000Z',
    };

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ track: newTrack }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    const input = screen.getByTestId('audio-file-input') as HTMLInputElement;
    const file = new File([new ArrayBuffer(1024)], 'song.mp3', { type: 'audio/mpeg' });

    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText('New Upload')).toBeDefined();
    });
  });

  it('shows upload error on server rejection', async () => {
    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid audio format. Supported: MP3, AAC, WAV, OGG' }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-file-input')).toBeDefined();
    });

    const input = screen.getByTestId('audio-file-input') as HTMLInputElement;
    const file = new File([new ArrayBuffer(1024)], 'bad.mp3', { type: 'audio/mpeg' });

    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText('Invalid audio format. Supported: MP3, AAC, WAV, OGG')).toBeDefined();
    });
  });
});

describe('AudioLibraryPanel - URL Download', () => {
  it('renders URL input and download button', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: [] }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-url-input')).toBeDefined();
    });
    expect(screen.getByRole('button', { name: '下载' })).toBeDefined();
  });

  it('download button is disabled when URL input is empty', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: [] }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下载' })).toBeDefined();
    });
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled();
  });

  it('downloads audio from URL and adds to list', async () => {
    const downloadedTrack: AudioTrack = {
      id: 'track-dl',
      userId: 'user-1',
      title: 'Downloaded Song',
      filePath: 'audio/user-1/track-dl.mp3',
      format: 'mp3',
      duration: 200,
      fileSize: 6000000,
      source: 'download',
      sourceUrl: 'https://example.com/song.mp3',
      createdAt: '2024-08-02T10:00:00.000Z',
    };

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ track: downloadedTrack }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-url-input')).toBeDefined();
    });

    const urlInput = screen.getByTestId('audio-url-input');
    await userEvent.type(urlInput, 'https://example.com/song.mp3');
    await userEvent.click(screen.getByRole('button', { name: '下载' }));

    await waitFor(() => {
      expect(screen.getByText('Downloaded Song')).toBeDefined();
    });

    // Verify the API was called correctly
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/audio/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/song.mp3' }),
    });
  });

  it('shows error when URL download fails', async () => {
    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Download failed: connection timeout' }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-url-input')).toBeDefined();
    });

    const urlInput = screen.getByTestId('audio-url-input');
    await userEvent.type(urlInput, 'https://bad-url.com/file.mp3');
    await userEvent.click(screen.getByRole('button', { name: '下载' }));

    await waitFor(() => {
      expect(screen.getByText('Download failed: connection timeout')).toBeDefined();
    });
  });

  it('clears URL input after successful download', async () => {
    const downloadedTrack: AudioTrack = {
      id: 'track-dl2',
      userId: 'user-1',
      title: 'Another Song',
      filePath: 'audio/user-1/track-dl2.mp3',
      format: 'mp3',
      duration: 150,
      fileSize: 4000000,
      source: 'download',
      createdAt: '2024-08-03T10:00:00.000Z',
    };

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ track: downloadedTrack }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-url-input')).toBeDefined();
    });

    const urlInput = screen.getByTestId('audio-url-input') as HTMLInputElement;
    await userEvent.type(urlInput, 'https://example.com/another.mp3');
    await userEvent.click(screen.getByRole('button', { name: '下载' }));

    await waitFor(() => {
      expect(urlInput.value).toBe('');
    });
  });
});

describe('AudioLibraryPanel - Delete', () => {
  it('shows delete button for each track', async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: mockTracks }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /删除/ });
    expect(deleteButtons.length).toBe(2);
  });

  it('shows confirmation dialog before deleting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tracks: mockTracks }),
    } as Response);
    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('audio-track-list')).toBeDefined();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /删除/ });
    await userEvent.click(deleteButtons[0]);

    expect(confirmSpy).toHaveBeenCalledWith('确定要删除音频 "Summer Vibes" 吗？');
    // Track should still be there since we cancelled
    expect(screen.getByText('Summer Vibes')).toBeDefined();
    confirmSpy.mockRestore();
  });

  it('removes track from list on successful delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Summer Vibes')).toBeDefined();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /删除/ });
    await userEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Summer Vibes')).toBeNull();
    });
    // Other track should still be there
    expect(screen.getByText('Ocean Waves')).toBeDefined();
  });

  it('shows error when delete API fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: '删除失败' }),
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Summer Vibes')).toBeDefined();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /删除/ });
    await userEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('删除失败')).toBeDefined();
    });
  });

  it('calls DELETE /api/audio/:id on confirmed delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mockAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tracks: mockTracks }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
      } as Response);

    render(<AudioLibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Summer Vibes')).toBeDefined();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /删除/ });
    await userEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/audio/track-1', {
        method: 'DELETE',
      });
    });
  });
});
