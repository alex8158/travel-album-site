import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompilationPreview from './CompilationPreview';

// Mock authFetch
vi.mock('../contexts/AuthContext', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from '../contexts/AuthContext';
const mockAuthFetch = vi.mocked(authFetch);

describe('CompilationPreview', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no compiledPath and no segments', () => {
    const { container } = render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={false}
        isProcessing={false}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders "剪辑预览" button when compiledPath exists', () => {
    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath="/some/path.mp4"
        hasSegments={true}
        isProcessing={false}
      />
    );
    const btn = screen.getByTestId('compile-preview-btn');
    expect(btn).toBeDefined();
    expect(btn.textContent).toBe('剪辑预览');
  });

  it('shows VideoPlayer when "剪辑预览" button is clicked', async () => {
    vi.useRealTimers();
    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath="/some/path.mp4"
        hasSegments={true}
        isProcessing={false}
      />
    );

    await userEvent.click(screen.getByTestId('compile-preview-btn'));

    const videoPlayer = screen.getByTestId('video-player');
    expect(videoPlayer).toBeDefined();
  });

  it('renders "生成剪辑" button when no compiledPath but has segments', () => {
    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={false}
      />
    );
    const btn = screen.getByTestId('compile-generate-btn');
    expect(btn).toBeDefined();
    expect(btn.textContent).toBe('生成剪辑');
  });

  it('shows progress indicator when isProcessing is true', async () => {
    vi.useRealTimers();

    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'running', percent: 45 }),
    } as Response);

    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={true}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('正在生成剪辑...')).toBeDefined();
    });
    expect(screen.getByText('45%')).toBeDefined();
  });

  it('shows error and retry button when job fails', async () => {
    vi.useRealTimers();

    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'failed', percent: 0, error: 'FFmpeg 超时' }),
    } as Response);

    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={true}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('FFmpeg 超时')).toBeDefined();
    });
    expect(screen.getByTestId('compile-retry-btn')).toBeDefined();
  });

  it('starts compile when "生成剪辑" button is clicked', async () => {
    vi.useRealTimers();

    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobId: 'job1', status: 'queued' }),
    } as Response);

    // Poll response
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'running', percent: 20 }),
    } as Response);

    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={false}
      />
    );

    await userEvent.click(screen.getByTestId('compile-generate-btn'));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/media/m1/compile', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('polls every 2 seconds and stops when completed', async () => {
    vi.useRealTimers();

    let callCount = 0;
    mockAuthFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ status: 'running', percent: 50 }) } as Response;
      }
      return { ok: true, json: async () => ({ status: 'completed', percent: 100 }) } as Response;
    });

    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={true}
      />
    );

    // First poll fires immediately - shows running state
    await waitFor(() => {
      expect(screen.getByText('50%')).toBeDefined();
    });

    // After next poll interval, should complete and show preview button
    await waitFor(() => {
      expect(screen.getByTestId('compile-preview-btn')).toBeDefined();
    }, { timeout: 5000 });
  });

  it('calls retry when retry button is clicked after failure', async () => {
    vi.useRealTimers();

    // Initial poll: failed
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'failed', percent: 0, error: '出错了' }),
    } as Response);

    render(
      <CompilationPreview
        mediaId="m1"
        compiledPath={null}
        hasSegments={true}
        isProcessing={true}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('compile-retry-btn')).toBeDefined();
    });

    // Mock the retry POST call
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobId: 'job2', status: 'queued' }),
    } as Response);
    // Mock the subsequent poll
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'running', percent: 10 }),
    } as Response);

    await userEvent.click(screen.getByTestId('compile-retry-btn'));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/media/m1/compile', expect.objectContaining({
        method: 'POST',
      }));
    });
  });
});
