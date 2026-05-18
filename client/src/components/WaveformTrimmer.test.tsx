import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import WaveformTrimmer from './WaveformTrimmer';

// Mock authFetch
vi.mock('../contexts/AuthContext', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from '../contexts/AuthContext';
const mockAuthFetch = vi.mocked(authFetch);

// Mock canvas context
const mockCtx = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  scale: vi.fn(),
  fillStyle: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
  // Mock getBoundingClientRect
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 120,
    right: 800,
    bottom: 120,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWaveformSuccess(waveform?: number[]) {
  const data = waveform || Array.from({ length: 200 }, () => Math.random());
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ waveform: data }),
  } as Response);
}

function mockWaveformError() {
  mockAuthFetch.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Waveform generation failed' }),
  } as Response);
}

describe('WaveformTrimmer', () => {
  const defaultProps = {
    trackId: 'track-1',
    audioDuration: 180, // 3 minutes
    videoDuration: 30,  // 30 seconds
    onChange: vi.fn(),
  };

  it('shows loading state initially', () => {
    mockAuthFetch.mockReturnValue(new Promise(() => {})); // never resolves
    render(<WaveformTrimmer {...defaultProps} />);
    expect(screen.getByTestId('waveform-loading')).toBeDefined();
  });

  it('fetches waveform data from POST /api/audio/:id/waveform', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/audio/track-1/waveform', {
        method: 'POST',
      });
    });
  });

  it('renders canvas after loading waveform', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-canvas')).toBeDefined();
    });
  });

  it('shows error state on fetch failure', async () => {
    mockWaveformError();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-error')).toBeDefined();
      expect(screen.getByText('Waveform generation failed')).toBeDefined();
    });
  });

  it('displays start and end time labels', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} initialStart={10} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    // Start: 10 seconds = 0:10.0
    expect(screen.getByTestId('waveform-start-label').textContent).toContain('0:10.0');
    // End: 10 + 30 = 40 seconds = 0:40.0
    expect(screen.getByTestId('waveform-end-label').textContent).toContain('0:40.0');
  });

  it('constrains initialStart to valid range', async () => {
    mockWaveformSuccess();
    const onChange = vi.fn();
    // initialStart = 160, but audioDuration=180, videoDuration=30
    // maxStart = 180 - 30 = 150, so start should be clamped to 150
    render(
      <WaveformTrimmer
        {...defaultProps}
        initialStart={160}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    // Start should be clamped to 150 (maxStart)
    expect(screen.getByTestId('waveform-start-label').textContent).toContain('2:30.0');
    // End should be 150 + 30 = 180
    expect(screen.getByTestId('waveform-end-label').textContent).toContain('3:00.0');
  });

  it('constrains negative initialStart to 0', async () => {
    mockWaveformSuccess();
    render(
      <WaveformTrimmer
        {...defaultProps}
        initialStart={-5}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    expect(screen.getByTestId('waveform-start-label').textContent).toContain('0:00.0');
  });

  it('calls onChange with initial values on mount', async () => {
    mockWaveformSuccess();
    const onChange = vi.fn();
    render(
      <WaveformTrimmer
        {...defaultProps}
        initialStart={20}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(20, 50); // start=20, end=20+30=50
    });
  });

  it('draws waveform on canvas after data loads', async () => {
    const waveform = Array.from({ length: 200 }, (_, i) => i / 200);
    mockWaveformSuccess(waveform);
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-canvas')).toBeDefined();
    });

    // Canvas should have been drawn on
    expect(mockCtx.clearRect).toHaveBeenCalled();
    expect(mockCtx.fillRect).toHaveBeenCalled();
  });

  it('shows selected duration info', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    // Should show selected duration (videoDuration = 30s = 0:30.0)
    expect(screen.getByText(/选中时长.*0:30.0/)).toBeDefined();
  });

  it('shows total audio duration label', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    // Should show total duration (180s = 3:00.0)
    expect(screen.getByText('3:00.0')).toBeDefined();
  });

  it('changes cursor to ew-resize when hovering near start marker', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} initialStart={0} />);

    await waitFor(() => {
      expect(screen.getByTestId('waveform-canvas')).toBeDefined();
    });

    const canvas = screen.getByTestId('waveform-canvas');
    // Start marker at x=0 (startTime=0, audioDuration=180, canvas width=800)
    // markerX = (0/180) * 800 = 0
    fireEvent.mouseMove(canvas, { clientX: 2 });
    expect((canvas as HTMLCanvasElement).style.cursor).toBe('ew-resize');
  });

  it('updates start time when dragging marker', async () => {
    mockWaveformSuccess();
    const onChange = vi.fn();
    render(
      <WaveformTrimmer
        {...defaultProps}
        initialStart={0}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('waveform-canvas')).toBeDefined();
    });

    const canvas = screen.getByTestId('waveform-canvas');

    // Start drag near the start marker (at x=0)
    fireEvent.mouseDown(canvas, { clientX: 0 });

    // Move to x=100 (100/800 * 180 = 22.5 seconds)
    fireEvent(window, new MouseEvent('mousemove', { clientX: 100 }));

    // Release
    fireEvent(window, new MouseEvent('mouseup', {}));

    // onChange should have been called with new start
    await waitFor(() => {
      // The last call should reflect the dragged position
      const calls = onChange.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
    });
  });

  it('has accessible aria-label', async () => {
    mockWaveformSuccess();
    render(<WaveformTrimmer {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByLabelText('波形裁剪器')).toBeDefined();
    });
  });

  it('defaults initialStart to 0 when not provided', async () => {
    mockWaveformSuccess();
    const onChange = vi.fn();
    render(
      <WaveformTrimmer
        trackId="track-1"
        audioDuration={180}
        videoDuration={30}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(0, 30);
    });
  });
});
