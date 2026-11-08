import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VideoPlayer from './VideoPlayer';

describe('VideoPlayer', () => {
  it('renders a video element with correct source', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);

    const video = screen.getByTestId('video-element');
    expect(video).toBeDefined();
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');

    const source = video.querySelector('source');
    expect(source).not.toBeNull();
    expect(source!.getAttribute('src')).toBe('/api/media/v1/original');
    expect(source!.getAttribute('type')).toBe('video/mp4');
  });

  it('has proper ARIA attributes', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);

    const region = screen.getByRole('region', { name: '视频播放器' });
    expect(region).toBeDefined();

    const video = screen.getByTestId('video-element');
    expect(video).toHaveAttribute('aria-label', '视频内容');
  });

  it('renders close button when onClose is provided', async () => {
    const onClose = vi.fn();
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" onClose={onClose} />);

    const closeBtn = screen.getByTestId('video-player-close');
    expect(closeBtn).toBeDefined();
    expect(closeBtn).toHaveAttribute('aria-label', '关闭播放器');

    await userEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render close button when onClose is not provided', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);
    expect(screen.queryByTestId('video-player-close')).toBeNull();
  });

  it('uses the native controls attribute for play/pause, progress, and volume', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);
    const video = screen.getByTestId('video-element');
    expect(video).toHaveAttribute('controls');
  });

  it('renders with different mimeType', () => {
    render(<VideoPlayer videoUrl="/api/media/v2/original" mimeType="video/quicktime" />);
    const source = screen.getByTestId('video-element').querySelector('source');
    expect(source!.getAttribute('type')).toBe('video/quicktime');
    expect(source!.getAttribute('src')).toBe('/api/media/v2/original');
  });

  it('default mode never fetches: plain <source src> keeps Range streaming', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('authorized mode fetches with the token only when mounted and plays the blob; close aborts and revokes', async () => {
    const store = new Map<string, string>([['auth_token', 'owner-token']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, status: 200, blob: async () => ({}) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const revoke = vi.fn();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:owner-video') as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
    try {
      const { unmount } = render(<VideoPlayer authorized videoUrl="/api/media/v9/original" mimeType="video/mp4" />);
      const video = await screen.findByTestId('video-element');
      expect(video.getAttribute('src')).toBe('blob:owner-video');
      expect(video.querySelector('source')).toBeNull();
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer owner-token');
      unmount();
      expect((init.signal as AbortSignal).aborted).toBe(true);
      expect(revoke).toHaveBeenCalledWith('blob:owner-video');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('contains fallback text for unsupported browsers', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);
    const video = screen.getByTestId('video-element');
    expect(video.textContent).toContain('您的浏览器不支持视频播放');
  });
});
