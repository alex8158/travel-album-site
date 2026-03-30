import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Lightbox, { LightboxImage } from './Lightbox';

const images: LightboxImage[] = [
  { originalUrl: '/api/media/img-1/original', alt: 'photo1.jpg' },
  { originalUrl: '/api/media/img-2/original', alt: 'photo2.jpg' },
  { originalUrl: '/api/media/img-3/original', alt: 'photo3.jpg' },
];

function setup(index = 0) {
  const onClose = vi.fn();
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const utils = render(
    <Lightbox
      images={images}
      currentIndex={index}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
    />,
  );
  return { onClose, onPrev, onNext, ...utils };
}

describe('Lightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a dialog with correct ARIA attributes', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '图片灯箱');
  });

  it('displays the current image at original resolution', () => {
    setup(1);
    const img = screen.getByTestId('lightbox-image');
    expect(img).toHaveAttribute('src', '/api/media/img-2/original');
    expect(img).toHaveAttribute('alt', 'photo2.jpg');
  });

  it('calls onClose when close button is clicked', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByTestId('lightbox-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onPrev when prev button is clicked', async () => {
    const { onPrev } = setup(1);
    await userEvent.click(screen.getByTestId('lightbox-prev'));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('calls onNext when next button is clicked', async () => {
    const { onNext } = setup(1);
    await userEvent.click(screen.getByTestId('lightbox-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('hides prev button on first image', () => {
    setup(0);
    expect(screen.queryByTestId('lightbox-prev')).toBeNull();
    expect(screen.getByTestId('lightbox-next')).toBeDefined();
  });

  it('hides next button on last image', () => {
    setup(2);
    expect(screen.getByTestId('lightbox-prev')).toBeDefined();
    expect(screen.queryByTestId('lightbox-next')).toBeNull();
  });

  it('shows both nav buttons on middle image', () => {
    setup(1);
    expect(screen.getByTestId('lightbox-prev')).toBeDefined();
    expect(screen.getByTestId('lightbox-next')).toBeDefined();
  });

  it('calls onClose when Escape key is pressed', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onPrev when ArrowLeft key is pressed (not on first)', () => {
    const { onPrev } = setup(1);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('does not call onPrev when ArrowLeft on first image', () => {
    const { onPrev } = setup(0);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('calls onNext when ArrowRight key is pressed (not on last)', () => {
    const { onNext } = setup(1);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('does not call onNext when ArrowRight on last image', () => {
    const { onNext } = setup(2);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();
  });

  it('calls onClose when clicking the overlay background', async () => {
    const { onClose } = setup();
    const overlay = screen.getByTestId('lightbox-overlay');
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking the image itself', async () => {
    const { onClose } = setup();
    const img = screen.getByTestId('lightbox-image');
    await userEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('works with a single image (no nav buttons)', () => {
    const onClose = vi.fn();
    render(
      <Lightbox
        images={[{ originalUrl: '/single.jpg', alt: 'single' }]}
        currentIndex={0}
        onClose={onClose}
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('lightbox-prev')).toBeNull();
    expect(screen.queryByTestId('lightbox-next')).toBeNull();
    expect(screen.getByTestId('lightbox-image')).toHaveAttribute('src', '/single.jpg');
  });
});
