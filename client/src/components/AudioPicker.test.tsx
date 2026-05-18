import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AudioPicker from './AudioPicker';

// Mock AudioLibraryPanel
vi.mock('./AudioLibraryPanel', () => ({
  default: ({ onSelect }: { onSelect?: (track: any) => void; selectable?: boolean }) => (
    <div data-testid="audio-library-panel">
      <button
        data-testid="mock-select-track"
        onClick={() =>
          onSelect?.({
            id: 'track-1',
            userId: 'user-1',
            title: 'Test Song',
            filePath: 'audio/user-1/track-1.mp3',
            format: 'mp3',
            duration: 180,
            fileSize: 5000000,
            source: 'upload',
            createdAt: '2024-01-01T00:00:00Z',
          })
        }
      >
        Select Track
      </button>
    </div>
  ),
  AudioTrack: {},
}));

// Mock WaveformTrimmer
vi.mock('./WaveformTrimmer', () => ({
  default: ({ trackId, audioDuration, videoDuration, onChange }: any) => {
    return (
      <div data-testid="waveform-trimmer" data-track-id={trackId} data-audio-duration={audioDuration} data-video-duration={videoDuration}>
        <button data-testid="mock-trim-change" onClick={() => onChange(10, 40)}>
          Set Trim
        </button>
      </div>
    );
  },
}));

describe('AudioPicker', () => {
  const defaultProps = {
    mediaId: 'media-1',
    videoDuration: 30,
    onApply: vi.fn(),
    onRemove: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with "暂无背景音乐" when no audio is applied', () => {
    render(<AudioPicker {...defaultProps} />);
    expect(screen.getByText('暂无背景音乐')).toBeDefined();
  });

  it('renders with applied status when currentAudioTrackId is set', () => {
    render(<AudioPicker {...defaultProps} currentAudioTrackId="track-1" />);
    expect(screen.getByText('✓ 已应用背景音乐')).toBeDefined();
  });

  it('shows "选择音乐" button', () => {
    render(<AudioPicker {...defaultProps} />);
    expect(screen.getByTestId('select-music-btn')).toBeDefined();
    expect(screen.getByTestId('select-music-btn').textContent).toBe('选择音乐');
  });

  it('toggles AudioLibraryPanel when "选择音乐" is clicked', async () => {
    render(<AudioPicker {...defaultProps} />);
    const user = userEvent.setup();

    // Initially hidden
    expect(screen.queryByTestId('audio-library-panel')).toBeNull();

    // Click to show
    await user.click(screen.getByTestId('select-music-btn'));
    expect(screen.getByTestId('audio-library-panel')).toBeDefined();
    expect(screen.getByTestId('select-music-btn').textContent).toBe('关闭音频库');

    // Click to hide
    await user.click(screen.getByTestId('select-music-btn'));
    expect(screen.queryByTestId('audio-library-panel')).toBeNull();
  });

  it('shows pending selection after selecting a track', async () => {
    render(<AudioPicker {...defaultProps} />);
    const user = userEvent.setup();

    // Open library
    await user.click(screen.getByTestId('select-music-btn'));

    // Select a track from the mocked library
    await user.click(screen.getByTestId('mock-select-track'));

    // Should show pending selection
    expect(screen.getByTestId('pending-selection')).toBeDefined();
    expect(screen.getByText('Test Song')).toBeDefined();
    expect(screen.getByText('3:00 · MP3')).toBeDefined();
  });

  it('shows Apply button after selecting a track and calls onApply', async () => {
    render(<AudioPicker {...defaultProps} />);
    const user = userEvent.setup();

    // Initially no Apply button
    expect(screen.queryByTestId('apply-audio-btn')).toBeNull();

    // Open library and select
    await user.click(screen.getByTestId('select-music-btn'));
    await user.click(screen.getByTestId('mock-select-track'));

    // Apply button should appear
    const applyBtn = screen.getByTestId('apply-audio-btn');
    expect(applyBtn).toBeDefined();
    expect(applyBtn.textContent).toBe('应用');

    // Click apply
    await user.click(applyBtn);
    expect(defaultProps.onApply).toHaveBeenCalledWith('track-1');
  });

  it('shows Remove button only when currentAudioTrackId is set', () => {
    const { rerender } = render(<AudioPicker {...defaultProps} />);
    expect(screen.queryByTestId('remove-audio-btn')).toBeNull();

    rerender(<AudioPicker {...defaultProps} currentAudioTrackId="track-1" />);
    expect(screen.getByTestId('remove-audio-btn')).toBeDefined();
  });

  it('calls onRemove when Remove button is clicked', async () => {
    render(<AudioPicker {...defaultProps} currentAudioTrackId="track-1" />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('remove-audio-btn'));
    expect(defaultProps.onRemove).toHaveBeenCalledTimes(1);
  });

  it('closes library panel after selecting a track', async () => {
    render(<AudioPicker {...defaultProps} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('select-music-btn'));
    expect(screen.getByTestId('audio-library-panel')).toBeDefined();

    await user.click(screen.getByTestId('mock-select-track'));
    // Library should be closed after selection
    expect(screen.queryByTestId('audio-library-panel')).toBeNull();
  });

  it('has proper aria-label for accessibility', () => {
    render(<AudioPicker {...defaultProps} />);
    expect(screen.getByLabelText('音频选择器')).toBeDefined();
  });

  describe('Manual Trim Integration', () => {
    it('shows manual trim toggle after selecting a track', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      // No toggle initially
      expect(screen.queryByTestId('manual-trim-toggle')).toBeNull();

      // Select a track
      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // Toggle should appear
      expect(screen.getByTestId('manual-trim-toggle')).toBeDefined();
    });

    it('does not show WaveformTrimmer when manual trim is disabled', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // WaveformTrimmer should not be visible
      expect(screen.queryByTestId('waveform-trimmer')).toBeNull();
    });

    it('shows WaveformTrimmer when manual trim is enabled', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // Enable manual trim
      await user.click(screen.getByTestId('manual-trim-checkbox'));

      // WaveformTrimmer should be visible
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();
    });

    it('passes correct props to WaveformTrimmer', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));
      await user.click(screen.getByTestId('manual-trim-checkbox'));

      const trimmer = screen.getByTestId('waveform-trimmer');
      expect(trimmer.getAttribute('data-track-id')).toBe('track-1');
      expect(trimmer.getAttribute('data-audio-duration')).toBe('180');
      expect(trimmer.getAttribute('data-video-duration')).toBe('30');
    });

    it('calls onApply with trim parameters when manual trim is enabled', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));
      await user.click(screen.getByTestId('manual-trim-checkbox'));

      // Simulate trim change from WaveformTrimmer
      await user.click(screen.getByTestId('mock-trim-change'));

      // Click apply
      await user.click(screen.getByTestId('apply-audio-btn'));
      expect(defaultProps.onApply).toHaveBeenCalledWith('track-1', 10, 40);
    });

    it('calls onApply without trim parameters when manual trim is disabled', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // Apply without enabling manual trim
      await user.click(screen.getByTestId('apply-audio-btn'));
      expect(defaultProps.onApply).toHaveBeenCalledWith('track-1');
    });

    it('hides WaveformTrimmer when manual trim is toggled off', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // Enable then disable
      await user.click(screen.getByTestId('manual-trim-checkbox'));
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();

      await user.click(screen.getByTestId('manual-trim-checkbox'));
      expect(screen.queryByTestId('waveform-trimmer')).toBeNull();
    });

    it('resets manual trim state when selecting a new track', async () => {
      render(<AudioPicker {...defaultProps} />);
      const user = userEvent.setup();

      // Select first track and enable manual trim
      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));
      await user.click(screen.getByTestId('manual-trim-checkbox'));
      expect(screen.getByTestId('waveform-trimmer')).toBeDefined();

      // Select another track (re-open library and select again)
      await user.click(screen.getByTestId('select-music-btn'));
      await user.click(screen.getByTestId('mock-select-track'));

      // Manual trim should be reset (unchecked)
      expect(screen.queryByTestId('waveform-trimmer')).toBeNull();
      const checkbox = screen.getByTestId('manual-trim-checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });
  });
});
