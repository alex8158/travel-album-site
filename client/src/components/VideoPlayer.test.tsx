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

  it('contains fallback text for unsupported browsers', () => {
    render(<VideoPlayer videoUrl="/api/media/v1/original" mimeType="video/mp4" />);
    const video = screen.getByTestId('video-element');
    expect(video.textContent).toContain('您的浏览器不支持视频播放');
  });
});
