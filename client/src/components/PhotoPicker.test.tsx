/**
 * Unit tests for PhotoPicker — task 6.2.
 *
 * Authority:
 *   - `.kiro/specs/manual-photo-management/requirements.md`
 *       2.1 (dialog opens), 2.2 (displays only Highlight_Pool photos),
 *       2.4 (selection closes the dialog), 2.6 / 3.3 (no Trashed_Photos)
 *   - `.kiro/specs/manual-photo-management/design.md` §Frontend Components 1
 *       "Fetches available photos from GET /api/my/trips/:id/highlight-pool /
 *        Displays photos in a grid with thumbnails / Clicking a photo triggers
 *        onSelect and closes the dialog / Shows loading state while fetching /
 *        Shows empty state message if no eligible photos remain"
 *
 * Scope note: the Highlight_Pool predicate (`is_highlight = 1` AND
 * `status = 'active'` AND not already a Tier_Photo) is enforced server-side and
 * is covered by the highlight-pool route tests. At component level the testable
 * obligation is that PhotoPicker sources exclusively from `getHighlightPool` and
 * renders exactly what that endpoint returns, adding no filtering of its own.
 *
 * Likewise Requirement 2.1's click-on-Empty_Slot half belongs to MyGalleryPage;
 * here we lock the half PhotoPicker owns — the `open` prop gating visibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhotoPicker from './PhotoPicker';
import type { TierPhotoItem } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return {
    ...actual,
    getHighlightPool: vi.fn(),
  };
});

import { getHighlightPool } from '../api';
const mockedGetHighlightPool = vi.mocked(getHighlightPool);

function makePhoto(id: string, overrides: Partial<TierPhotoItem> = {}): TierPhotoItem {
  return {
    id,
    filePath: `${id}/file.jpg`,
    thumbnailUrl: `/api/media/${id}/thumbnail`,
    originalUrl: `/api/media/${id}/original`,
    category: 'animal',
    reason: 'AI 评估：构图优秀',
    ...overrides,
  } as TierPhotoItem;
}

function renderPicker(props: Partial<React.ComponentProps<typeof PhotoPicker>> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <PhotoPicker tripId="trip-1" open onClose={onClose} onSelect={onSelect} {...props} />
  );
  return { onClose, onSelect, ...utils };
}

describe('PhotoPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetHighlightPool.mockResolvedValue({ photos: [] });
  });

  // =========================================================================
  // open / closed gating — Requirement 2.1 (component half)
  // =========================================================================
  describe('open / closed states', () => {
    it('2.1: renders nothing when open is false', () => {
      renderPicker({ open: false });

      expect(screen.queryByTestId('photo-picker-dialog')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('2.1: does not fetch the highlight pool while closed', () => {
      renderPicker({ open: false });

      expect(mockedGetHighlightPool).not.toHaveBeenCalled();
    });

    it('2.1: renders an accessible modal dialog when open is true', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1')] });
      renderPicker();

      const dialog = await screen.findByTestId('photo-picker-dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', '选择照片');
      expect(screen.getByRole('heading', { name: '选择照片' })).toBeInTheDocument();
    });

    it('2.1: fetches the highlight pool for the given trip once opened', async () => {
      renderPicker({ tripId: 'trip-42' });

      await waitFor(() => expect(mockedGetHighlightPool).toHaveBeenCalledWith('trip-42'));
    });

    it('2.1: re-fetches when the dialog is reopened', async () => {
      const { rerender, onClose, onSelect } = renderPicker({ open: false });
      expect(mockedGetHighlightPool).not.toHaveBeenCalled();

      rerender(
        <PhotoPicker tripId="trip-1" open onClose={onClose} onSelect={onSelect} />
      );

      await waitFor(() => expect(mockedGetHighlightPool).toHaveBeenCalledTimes(1));
    });
  });

  // =========================================================================
  // loading state — design §Frontend Components 1
  // =========================================================================
  describe('loading state', () => {
    it('shows the loading indicator while the pool request is pending', async () => {
      let resolvePool: (v: { photos: TierPhotoItem[] }) => void = () => {};
      mockedGetHighlightPool.mockReturnValue(
        new Promise((resolve) => {
          resolvePool = resolve;
        })
      );

      renderPicker();

      expect(await screen.findByTestId('photo-picker-loading')).toHaveTextContent('加载中...');
      // Neither the grid nor the empty state competes with the loading state.
      expect(screen.queryByTestId('photo-picker-grid')).toBeNull();
      expect(screen.queryByTestId('photo-picker-empty')).toBeNull();

      resolvePool({ photos: [makePhoto('p1')] });

      await waitFor(() => expect(screen.queryByTestId('photo-picker-loading')).toBeNull());
      expect(screen.getByTestId('photo-picker-grid')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // photo grid — Requirements 2.2 / 2.6 / 3.3 (component half)
  // =========================================================================
  describe('photo grid rendering', () => {
    it('2.2: renders one selectable tile per photo returned by getHighlightPool', async () => {
      mockedGetHighlightPool.mockResolvedValue({
        photos: [makePhoto('p1'), makePhoto('p2'), makePhoto('p3')],
      });

      renderPicker();

      expect(await screen.findByTestId('photo-picker-grid')).toBeInTheDocument();
      for (const id of ['p1', 'p2', 'p3']) {
        expect(screen.getByTestId(`photo-picker-item-${id}`)).toBeInTheDocument();
      }
    });

    it('2.2 / 2.6 / 3.3: adds no client-side filtering — the rendered set equals the endpoint response', async () => {
      // Eligibility (is_highlight = 1, status = 'active', not already tier) is a
      // server-side predicate. The component must not second-guess it, so the
      // tile count must match the response exactly.
      const photos = [makePhoto('a'), makePhoto('b', { category: 'people' }), makePhoto('c', { category: null })];
      mockedGetHighlightPool.mockResolvedValue({ photos });

      renderPicker();

      await screen.findByTestId('photo-picker-grid');
      const tiles = screen.getAllByTestId(/^photo-picker-item-/);
      expect(tiles).toHaveLength(photos.length);
    });

    it('renders each thumbnail with the photo category as alt text, falling back to 照片', async () => {
      mockedGetHighlightPool.mockResolvedValue({
        photos: [makePhoto('p1', { category: 'landscape' }), makePhoto('p2', { category: null })],
      });

      renderPicker();

      await screen.findByTestId('photo-picker-grid');
      expect(screen.getByAltText('landscape')).toHaveAttribute(
        'src',
        '/api/media/p1/thumbnail'
      );
      expect(screen.getByAltText('照片')).toHaveAttribute('src', '/api/media/p2/thumbnail');
    });
  });

  // =========================================================================
  // empty state — design §Frontend Components 1
  // =========================================================================
  describe('empty state', () => {
    it('shows the empty message when the highlight pool is exhausted', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [] });

      renderPicker();

      expect(await screen.findByTestId('photo-picker-empty')).toHaveTextContent(
        '没有可选择的照片'
      );
      expect(screen.queryByTestId('photo-picker-grid')).toBeNull();
    });
  });

  // =========================================================================
  // selection — Requirement 2.4 (component half)
  // =========================================================================
  describe('selection', () => {
    it('2.4: clicking a photo calls onSelect with that photo and then closes the dialog', async () => {
      const target = makePhoto('p2', { category: 'people' });
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1'), target] });
      const { onSelect, onClose } = renderPicker();

      await screen.findByTestId('photo-picker-grid');
      await userEvent.click(screen.getByTestId('photo-picker-item-p2'));

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(target);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('2.4: does not invoke onSelect for a photo the user did not click', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1'), makePhoto('p2')] });
      const { onSelect } = renderPicker();

      await screen.findByTestId('photo-picker-grid');
      await userEvent.click(screen.getByTestId('photo-picker-item-p1'));

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
      expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
    });
  });

  // =========================================================================
  // close paths
  // =========================================================================
  describe('close behaviour', () => {
    it('calls onClose when the header close button is clicked, without selecting anything', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1')] });
      const { onClose, onSelect } = renderPicker();

      await screen.findByTestId('photo-picker-grid');
      await userEvent.click(screen.getByTestId('photo-picker-close-btn'));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('calls onClose when the backdrop itself is clicked', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1')] });
      const { onClose } = renderPicker();

      const backdrop = await screen.findByTestId('photo-picker-dialog');
      await userEvent.click(backdrop);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when a click originates inside the dialog panel', async () => {
      mockedGetHighlightPool.mockResolvedValue({ photos: [makePhoto('p1')] });
      const { onClose } = renderPicker();

      // The heading sits inside the inner panel, so the backdrop handler's
      // `e.target === e.currentTarget` guard must suppress the close.
      await userEvent.click(await screen.findByRole('heading', { name: '选择照片' }));

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // error state — current production behaviour, read from the implementation
  // =========================================================================
  describe('error state (as implemented today)', () => {
    it('renders the rejection message when the pool request fails', async () => {
      mockedGetHighlightPool.mockRejectedValue(new Error('网络错误'));

      renderPicker();

      expect(await screen.findByTestId('photo-picker-error')).toHaveTextContent('网络错误');
      // The error replaces both the grid and the empty state.
      expect(screen.queryByTestId('photo-picker-grid')).toBeNull();
      expect(screen.queryByTestId('photo-picker-empty')).toBeNull();
      expect(screen.queryByTestId('photo-picker-loading')).toBeNull();
    });

    it('falls back to 加载失败 when the rejection carries no message', async () => {
      mockedGetHighlightPool.mockRejectedValue({});

      renderPicker();

      expect(await screen.findByTestId('photo-picker-error')).toHaveTextContent('加载失败');
    });

    it('keeps the dialog open and closable after a failure', async () => {
      mockedGetHighlightPool.mockRejectedValue(new Error('boom'));
      const { onClose } = renderPicker();

      await screen.findByTestId('photo-picker-error');
      expect(screen.getByTestId('photo-picker-dialog')).toBeInTheDocument();

      await userEvent.click(screen.getByTestId('photo-picker-close-btn'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
