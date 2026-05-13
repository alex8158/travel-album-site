import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SegmentAdjuster from './SegmentAdjuster';

// Mock authFetch
vi.mock('../contexts/AuthContext', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from '../contexts/AuthContext';
const mockAuthFetch = vi.mocked(authFetch);

const mockSegments = [
  { index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85, label: 'good' },
  { index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 72, label: 'good' },
  { index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 20, label: 'severely_blurry' },
  { index: 3, startTime: 15, endTime: 20, duration: 5, overallScore: 60, label: 'slightly_shaky' },
  { index: 4, startTime: 20, endTime: 25, duration: 5, overallScore: 10, label: 'severely_shaky' },
];

function mockFetchSuccess(segments = mockSegments) {
  mockAuthFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ mediaId: 'test-media', segments }),
  } as Response);
}

describe('SegmentAdjuster', () => {
  const defaultProps = {
    mediaId: 'test-media-id',
    onClose: vi.fn(),
    onCompileStarted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockAuthFetch.mockReturnValueOnce(new Promise(() => {})); // never resolves
    render(<SegmentAdjuster {...defaultProps} />);
    expect(screen.getByTestId('segment-adjuster-loading')).toBeDefined();
  });

  it('shows error state when fetch fails', async () => {
    mockAuthFetch.mockResolvedValueOnce({ ok: false } as Response);
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster-error')).toBeDefined();
    });
  });

  it('renders all segments after loading', async () => {
    mockFetchSuccess();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });
    // All 5 segments should be rendered
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`adjuster-segment-${i}`)).toBeDefined();
    }
  });

  it('shows time range, duration, and quality score for each segment', async () => {
    mockFetchSuccess();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });
    // Check score display
    expect(screen.getByTestId('adjuster-score-0').textContent).toBe('85分');
    expect(screen.getByTestId('adjuster-score-2').textContent).toBe('20分');
  });

  it('shows low quality badge for severe labels and low scores', async () => {
    mockFetchSuccess();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });
    // Severely blurry segment should have badge
    expect(screen.getByTestId('adjuster-low-quality-2')).toBeDefined();
    // Severely shaky segment should have badge
    expect(screen.getByTestId('adjuster-low-quality-4')).toBeDefined();
    // Good segments should not have badge
    expect(screen.queryByTestId('adjuster-low-quality-0')).toBeNull();
  });

  it('pre-selects non-severe, high-score segments', async () => {
    mockFetchSuccess();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });
    // Segments 0, 1, 3 should be selected (good/slightly_shaky with score >= 30)
    const check0 = screen.getByTestId('adjuster-check-0') as HTMLInputElement;
    const check1 = screen.getByTestId('adjuster-check-1') as HTMLInputElement;
    const check2 = screen.getByTestId('adjuster-check-2') as HTMLInputElement;
    const check3 = screen.getByTestId('adjuster-check-3') as HTMLInputElement;
    expect(check0.checked).toBe(true);
    expect(check1.checked).toBe(true);
    expect(check2.checked).toBe(false); // severely_blurry
    expect(check3.checked).toBe(true);
  });

  it('allows toggling segment selection', async () => {
    mockFetchSuccess();
    const user = userEvent.setup();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    const check0 = screen.getByTestId('adjuster-check-0') as HTMLInputElement;
    expect(check0.checked).toBe(true);

    // Uncheck
    await user.click(check0);
    expect(check0.checked).toBe(false);

    // Re-check
    await user.click(check0);
    expect(check0.checked).toBe(true);
  });

  it('enforces max 50 selection limit', async () => {
    // Create 51 segments
    const manySegments = Array.from({ length: 51 }, (_, i) => ({
      index: i,
      startTime: i * 5,
      endTime: (i + 1) * 5,
      duration: 5,
      overallScore: 80,
      label: 'good',
    }));
    mockFetchSuccess(manySegments);
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    // Only first 50 should be selected
    const check50 = screen.getByTestId('adjuster-check-50') as HTMLInputElement;
    expect(check50.checked).toBe(false);
    // The checkbox should be disabled since we're at max
    expect(check50.disabled).toBe(true);
  });

  it('calls POST /compile with segmentIndices on submit', async () => {
    mockFetchSuccess();
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobId: 'job-123', status: 'queued' }),
    } as Response);

    const user = userEvent.setup();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    await user.click(screen.getByTestId('adjuster-submit'));

    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/media/test-media-id/compile',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('segmentIndices'),
      }),
    );
    expect(defaultProps.onCompileStarted).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows error when submit fails', async () => {
    mockFetchSuccess();
    mockAuthFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: '并发冲突' } }),
    } as Response);

    const user = userEvent.setup();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    await user.click(screen.getByTestId('adjuster-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('adjuster-submit-error').textContent).toBe('并发冲突');
    });
  });

  it('calls onClose when cancel button is clicked', async () => {
    mockFetchSuccess();
    const user = userEvent.setup();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    await user.click(screen.getByTestId('adjuster-cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('disables submit button when no segments are selected', async () => {
    // All segments are severe/low quality
    const badSegments = [
      { index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 10, label: 'severely_blurry' },
    ];
    mockFetchSuccess(badSegments);
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });

    const submitBtn = screen.getByTestId('adjuster-submit') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('shows selected count in header', async () => {
    mockFetchSuccess();
    render(<SegmentAdjuster {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('segment-adjuster')).toBeDefined();
    });
    // 3 segments should be pre-selected (indices 0, 1, 3)
    expect(screen.getByText('已选 3/50 个片段')).toBeDefined();
  });
});
