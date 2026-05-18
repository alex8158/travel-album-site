import { useState, useCallback } from 'react';
import AudioLibraryPanel, { AudioTrack } from './AudioLibraryPanel';
import WaveformTrimmer from './WaveformTrimmer';

export interface AudioPickerProps {
  mediaId: string;
  videoDuration: number;
  currentAudioTrackId?: string;
  onApply: (trackId: string, trimStart?: number, trimEnd?: number) => void;
  onRemove: () => void;
}

export default function AudioPicker({
  mediaId: _mediaId,
  videoDuration,
  currentAudioTrackId,
  onApply,
  onRemove,
}: AudioPickerProps) {
  const [showLibrary, setShowLibrary] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<AudioTrack | null>(null);
  const [applying, setApplying] = useState(false);
  const [manualTrim, setManualTrim] = useState(false);
  const [trimStart, setTrimStart] = useState<number | undefined>(undefined);
  const [trimEnd, setTrimEnd] = useState<number | undefined>(undefined);

  const handleSelectTrack = (track: AudioTrack) => {
    setSelectedTrack(track);
    setShowLibrary(false);
    // Reset trim state when selecting a new track
    setManualTrim(false);
    setTrimStart(undefined);
    setTrimEnd(undefined);
  };

  const handleTrimChange = useCallback((start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
  }, []);

  const handleApply = async () => {
    if (!selectedTrack) return;
    setApplying(true);
    try {
      if (manualTrim && trimStart !== undefined && trimEnd !== undefined) {
        onApply(selectedTrack.id, trimStart, trimEnd);
      } else {
        onApply(selectedTrack.id);
      }
    } finally {
      setApplying(false);
    }
  };

  const handleRemove = () => {
    onRemove();
    setSelectedTrack(null);
    setManualTrim(false);
    setTrimStart(undefined);
    setTrimEnd(undefined);
  };

  return (
    <div aria-label="音频选择器" style={{ padding: '12px', border: '1px solid #e0e0e0', borderRadius: '8px' }}>
      <h4 style={{ margin: '0 0 12px 0' }}>背景音乐</h4>

      {/* Current status */}
      <div style={{ marginBottom: '12px', color: '#555' }}>
        {currentAudioTrackId ? (
          <span>✓ 已应用背景音乐</span>
        ) : (
          <span>暂无背景音乐</span>
        )}
      </div>

      {/* Pending selection */}
      {selectedTrack && (
        <div
          style={{
            marginBottom: '12px',
            padding: '8px',
            backgroundColor: '#f0f7ff',
            borderRadius: '4px',
          }}
          data-testid="pending-selection"
        >
          <div style={{ fontWeight: 500 }}>{selectedTrack.title}</div>
          <div style={{ fontSize: '0.85em', color: '#666' }}>
            {formatDuration(selectedTrack.duration)} · {selectedTrack.format.toUpperCase()}
          </div>
        </div>
      )}

      {/* Manual trim toggle - only shown when a track is selected */}
      {selectedTrack && (
        <div style={{ marginBottom: '12px' }}>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
            data-testid="manual-trim-toggle"
          >
            <input
              type="checkbox"
              checked={manualTrim}
              onChange={(e) => setManualTrim(e.target.checked)}
              data-testid="manual-trim-checkbox"
            />
            <span>手动裁剪</span>
          </label>
        </div>
      )}

      {/* WaveformTrimmer - shown when track is selected AND manual trim is enabled */}
      {selectedTrack && manualTrim && (
        <div style={{ marginBottom: '12px' }} data-testid="waveform-trimmer-container">
          <WaveformTrimmer
            trackId={selectedTrack.id}
            audioDuration={selectedTrack.duration}
            videoDuration={videoDuration}
            onChange={handleTrimChange}
          />
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setShowLibrary(!showLibrary)}
          data-testid="select-music-btn"
        >
          {showLibrary ? '关闭音频库' : '选择音乐'}
        </button>

        {selectedTrack && (
          <button
            onClick={handleApply}
            disabled={applying}
            data-testid="apply-audio-btn"
            style={{ backgroundColor: '#4CAF50', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}
          >
            {applying ? '应用中...' : '应用'}
          </button>
        )}

        {currentAudioTrackId && (
          <button
            onClick={handleRemove}
            data-testid="remove-audio-btn"
            style={{ backgroundColor: '#f44336', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer' }}
          >
            移除音乐
          </button>
        )}
      </div>

      {/* Audio Library Panel (selectable mode) */}
      {showLibrary && (
        <div style={{ marginTop: '12px', borderTop: '1px solid #eee', paddingTop: '12px' }}>
          <AudioLibraryPanel selectable onSelect={handleSelectTrack} />
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
