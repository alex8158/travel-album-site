/**
 * Unit tests for audioService — extractAudioMetadata, extractTitleFromUrl,
 * deleteAudioTrack, listUserTracks, getTrackById.
 *
 * Task 2.3: Verifies metadata extraction logic including title from tags,
 * fallback to filename, duration, format, and file size.
 *
 * Task 2.5: Verifies delete, list, and getById operations.
 *
 * **Validates: Requirements 2.4, 3.5, 4.1, 4.2, 4.3**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFfprobe = vi.fn();

vi.mock('fluent-ffmpeg', () => {
  const fn: any = () => ({});
  fn.ffprobe = (...args: any[]) => mockFfprobe(...args);
  return { default: fn };
});

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      promises: {
        ...actual.promises,
        stat: vi.fn().mockResolvedValue({ size: 1024000 }),
      },
    },
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      stat: vi.fn().mockResolvedValue({ size: 1024000 }),
    },
  };
});

vi.mock('crypto', () => ({
  default: { randomUUID: vi.fn().mockReturnValue('test-uuid-1234') },
  randomUUID: vi.fn().mockReturnValue('test-uuid-1234'),
}));

// Mock child_process.spawn for probeForAudioStream
const mockSpawnStdout = { on: vi.fn(), destroy: vi.fn() };
const mockSpawnStderr = { destroy: vi.fn() };
const mockSpawnProcess = {
  stdout: mockSpawnStdout,
  stderr: mockSpawnStderr,
  on: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn(), destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
    on: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp/test',
}));

const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockSave = vi.fn().mockResolvedValue(undefined);

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    delete: mockDelete,
    save: mockSave,
  }),
}));

const mockGet = vi.fn();
const mockAll = vi.fn();
const mockRun = vi.fn();
const mockPrepare = vi.fn().mockImplementation(() => ({
  get: mockGet,
  all: mockAll,
  run: mockRun,
}));

vi.mock('../database', () => ({
  getDb: () => ({
    prepare: mockPrepare,
  }),
}));

import { extractAudioMetadata, extractTitleFromUrl, deleteAudioTrack, listUserTracks, getTrackById, saveAudioTrack, downloadAudioFromUrl } from './audioService';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractAudioMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should extract title from ID3 tags (case-insensitive)', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 180.5,
          size: 4500000,
          tags: { TITLE: 'My Song Title' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/song.mp3');

    expect(result.title).toBe('My Song Title');
    expect(result.duration).toBe(180.5);
    expect(result.format).toBe('mp3');
    expect(result.fileSize).toBe(4500000);
  });

  it('should handle lowercase title tag', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 60,
          size: 2000000,
          tags: { title: 'Lowercase Title' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/track.ogg');

    expect(result.title).toBe('Lowercase Title');
    expect(result.format).toBe('ogg');
  });

  it('should handle mixed-case title tag (Title)', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 240,
          size: 8000000,
          tags: { Title: 'Mixed Case Title' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/music/album/track.wav');

    expect(result.title).toBe('Mixed Case Title');
    expect(result.format).toBe('wav');
  });

  it('should fall back to filename when no title tag exists', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 120,
          size: 3000000,
          tags: { artist: 'Some Artist' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/my-background-music.mp3');

    expect(result.title).toBe('my-background-music');
    expect(result.duration).toBe(120);
  });

  it('should fall back to filename when tags object is null', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 90,
          size: 1500000,
          tags: null,
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/audio/relaxing_piano.aac');

    expect(result.title).toBe('relaxing_piano');
    expect(result.format).toBe('aac');
  });

  it('should fall back to filename when title tag is empty string', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 45,
          size: 800000,
          tags: { title: '   ' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/untitled-track.mp3');

    expect(result.title).toBe('untitled-track');
  });

  it('should use fs.stat for file size when format.size is missing', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          duration: 200,
          tags: { title: 'No Size Info' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/song.mp3');

    expect(result.title).toBe('No Size Info');
    expect(result.fileSize).toBe(1024000); // from mocked fs.stat
  });

  it('should handle duration of 0 when format.duration is missing', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, {
        format: {
          size: 500000,
          tags: { title: 'Short Clip' },
        },
        streams: [],
      });
    });

    const result = await extractAudioMetadata('/path/to/clip.wav');

    expect(result.duration).toBe(0);
  });

  it('should reject when ffprobe fails', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(new Error('Not a valid audio file'));
    });

    await expect(extractAudioMetadata('/path/to/invalid.txt')).rejects.toThrow('Not a valid audio file');
  });
});

describe('extractTitleFromUrl', () => {
  it('should extract filename without extension from URL', () => {
    const title = extractTitleFromUrl('https://example.com/music/summer-vibes.mp3');
    expect(title).toBe('summer-vibes');
  });

  it('should strip query params from URL', () => {
    const title = extractTitleFromUrl('https://cdn.example.com/audio/track.ogg?token=abc123&expires=999');
    expect(title).toBe('track');
  });

  it('should decode URI-encoded characters', () => {
    const title = extractTitleFromUrl('https://example.com/music/my%20favorite%20song.mp3');
    expect(title).toBe('my favorite song');
  });

  it('should return Untitled for invalid URLs', () => {
    const title = extractTitleFromUrl('not-a-valid-url');
    expect(title).toBe('Untitled');
  });

  it('should return Untitled for URL with no filename', () => {
    const title = extractTitleFromUrl('https://example.com/');
    expect(title).toBe('Untitled');
  });

  it('should handle URL with nested path', () => {
    const title = extractTitleFromUrl('https://cdn.music.com/users/123/uploads/ocean-waves.wav');
    expect(title).toBe('ocean-waves');
  });
});


// ---------------------------------------------------------------------------
// deleteAudioTrack, listUserTracks, getTrackById tests
// ---------------------------------------------------------------------------

describe('deleteAudioTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete the track file and database record when track exists and belongs to user', async () => {
    const row = {
      id: 'track-1',
      user_id: 'user-1',
      title: 'My Track',
      file_path: 'audio/user-1/track-1.mp3',
      format: 'mp3',
      duration: 120,
      file_size: 5000000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00.000Z',
    };

    mockGet.mockReturnValue(row);
    mockRun.mockReturnValue({ changes: 1 });

    await deleteAudioTrack('track-1', 'user-1');

    expect(mockPrepare).toHaveBeenCalledWith('SELECT * FROM audio_tracks WHERE id = ?');
    expect(mockGet).toHaveBeenCalledWith('track-1');
    expect(mockDelete).toHaveBeenCalledWith('audio/user-1/track-1.mp3');
    expect(mockPrepare).toHaveBeenCalledWith('DELETE FROM audio_tracks WHERE id = ?');
    expect(mockRun).toHaveBeenCalledWith('track-1');
  });

  it('should throw error when track is not found', async () => {
    mockGet.mockReturnValue(undefined);

    await expect(deleteAudioTrack('nonexistent', 'user-1')).rejects.toThrow('Audio track not found');
  });

  it('should throw error when track does not belong to user', async () => {
    const row = {
      id: 'track-1',
      user_id: 'other-user',
      title: 'Other Track',
      file_path: 'audio/other-user/track-1.mp3',
      format: 'mp3',
      duration: 60,
      file_size: 2000000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00.000Z',
    };

    mockGet.mockReturnValue(row);

    await expect(deleteAudioTrack('track-1', 'user-1')).rejects.toThrow('Audio track not found');
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('listUserTracks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all tracks for the given user', async () => {
    const rows = [
      {
        id: 'track-1',
        user_id: 'user-1',
        title: 'Track One',
        file_path: 'audio/user-1/track-1.mp3',
        format: 'mp3',
        duration: 120,
        file_size: 5000000,
        source: 'upload',
        source_url: null,
        created_at: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'track-2',
        user_id: 'user-1',
        title: 'Track Two',
        file_path: 'audio/user-1/track-2.ogg',
        format: 'ogg',
        duration: 240,
        file_size: 8000000,
        source: 'download',
        source_url: 'https://example.com/track.ogg',
        created_at: '2024-01-02T00:00:00.000Z',
      },
    ];

    mockAll.mockReturnValue(rows);

    const result = await listUserTracks('user-1');

    expect(mockPrepare).toHaveBeenCalledWith('SELECT * FROM audio_tracks WHERE user_id = ?');
    expect(mockAll).toHaveBeenCalledWith('user-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('track-1');
    expect(result[0].userId).toBe('user-1');
    expect(result[0].title).toBe('Track One');
    expect(result[0].filePath).toBe('audio/user-1/track-1.mp3');
    expect(result[0].format).toBe('mp3');
    expect(result[1].id).toBe('track-2');
    expect(result[1].sourceUrl).toBe('https://example.com/track.ogg');
  });

  it('should return empty array when user has no tracks', async () => {
    mockAll.mockReturnValue([]);

    const result = await listUserTracks('user-no-tracks');

    expect(result).toEqual([]);
  });
});

describe('getTrackById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the track when found', async () => {
    const row = {
      id: 'track-1',
      user_id: 'user-1',
      title: 'My Track',
      file_path: 'audio/user-1/track-1.mp3',
      format: 'mp3',
      duration: 120,
      file_size: 5000000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00.000Z',
    };

    mockGet.mockReturnValue(row);

    const result = await getTrackById('track-1');

    expect(mockPrepare).toHaveBeenCalledWith('SELECT * FROM audio_tracks WHERE id = ?');
    expect(mockGet).toHaveBeenCalledWith('track-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('track-1');
    expect(result!.userId).toBe('user-1');
    expect(result!.title).toBe('My Track');
    expect(result!.duration).toBe(120);
  });

  it('should return null when track is not found', async () => {
    mockGet.mockReturnValue(undefined);

    const result = await getTrackById('nonexistent');

    expect(result).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// saveAudioTrack tests
// ---------------------------------------------------------------------------

describe('saveAudioTrack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error when validation fails (unsupported format)', async () => {
    // spawn mock will simulate ffprobe — but extension check happens first
    await expect(saveAudioTrack('user-1', Buffer.from('data'), 'file.txt'))
      .rejects.toThrow('Invalid audio format. Supported: MP3, AAC, WAV, OGG');
  });

  it('should throw error when file is empty', async () => {
    await expect(saveAudioTrack('user-1', Buffer.alloc(0), 'file.mp3'))
      .rejects.toThrow('File is empty');
  });

  it('should throw error when file exceeds 50MB', async () => {
    const bigBuffer = Buffer.alloc(52_428_801);
    await expect(saveAudioTrack('user-1', bigBuffer, 'file.mp3'))
      .rejects.toThrow('File size exceeds 50MB limit');
  });
});

// ---------------------------------------------------------------------------
// downloadAudioFromUrl tests
// ---------------------------------------------------------------------------

describe('downloadAudioFromUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error with descriptive message on invalid URL', async () => {
    await expect(downloadAudioFromUrl('user-1', 'not-a-url'))
      .rejects.toThrow(/Download failed/);
  });
});
