import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { getTempDir } from '../helpers/tempDir';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { AudioTrackRow, rowToAudioTrack } from '../helpers/audioTrackRow';
import type { AudioTrack } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface AudioMetadata {
  title: string;
  duration: number;
  format: string;
  fileSize: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 52_428_800; // 50MB

/** Map of file extensions to accepted MIME types */
const SUPPORTED_FORMATS: Record<string, string[]> = {
  mp3: ['audio/mpeg'],
  aac: ['audio/aac', 'audio/mp4'],
  wav: ['audio/wav', 'audio/x-wav'],
  ogg: ['audio/ogg'],
};

const SUPPORTED_EXTENSIONS = Object.keys(SUPPORTED_FORMATS);

// ---------------------------------------------------------------------------
// Audio File Validation
// ---------------------------------------------------------------------------

/**
 * Validate an audio file buffer by checking:
 * 1. File size (≤ 50MB)
 * 2. File extension maps to a supported format
 * 3. Uses ffprobe to verify the file contains a valid audio stream
 *
 * This is the full async validation that includes ffprobe verification.
 */
export async function validateAudioFile(buffer: Buffer, filename: string): Promise<ValidationResult> {
  // 1. Check file size
  if (buffer.length > MAX_FILE_SIZE) {
    return { valid: false, error: 'File size exceeds 50MB limit' };
  }

  if (buffer.length === 0) {
    return { valid: false, error: 'File is empty' };
  }

  // 2. Check file extension
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: 'Invalid audio format. Supported: MP3, AAC, WAV, OGG',
    };
  }

  // 3. Write buffer to temp file and verify with ffprobe
  const tempDir = getTempDir();
  const tempFile = path.join(tempDir, `audio-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

  try {
    fs.writeFileSync(tempFile, buffer);

    const hasAudio = await probeForAudioStream(tempFile);
    if (!hasAudio) {
      return { valid: false, error: 'File is not a valid audio file' };
    }

    return { valid: true };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Use ffprobe to check if a file contains at least one audio stream.
 * Returns true if an audio stream is found, false otherwise.
 */
function probeForAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ];

    const proc = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', () => {
      if (typeof proc.stdout?.destroy === 'function') proc.stdout.destroy();
      if (typeof proc.stderr?.destroy === 'function') proc.stderr.destroy();
      resolve(false);
    });

    proc.on('close', (code) => {
      // Ensure stdio streams are destroyed to release file descriptors
      if (typeof proc.stdout?.destroy === 'function') proc.stdout.destroy();
      if (typeof proc.stderr?.destroy === 'function') proc.stderr.destroy();

      if (code === 0 && stdout.trim().includes('audio')) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Metadata Extraction
// ---------------------------------------------------------------------------

/**
 * Extract audio metadata from a file using ffprobe.
 *
 * Title extraction logic:
 * 1. Attempts to read title from audio file metadata (ID3 tags, Vorbis comments)
 *    via case-insensitive tag lookup on format.tags.title
 * 2. Falls back to filename without extension
 *
 * Duration: from format.duration
 * Format: from file extension
 * File size: from format.size or fs.stat
 */
export async function extractAudioMetadata(filePath: string): Promise<AudioMetadata> {
  const metadata = await probeAudioFile(filePath);

  // Extract title from tags (case-insensitive lookup)
  const title = extractTitleFromTags(metadata.format?.tags) ?? extractTitleFromFilename(filePath);

  // Duration in seconds
  const duration = metadata.format?.duration ?? 0;

  // Format from file extension
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const format = ext || 'unknown';

  // File size: prefer ffprobe's format.size, fall back to fs.stat
  let fileSize = 0;
  if (metadata.format?.size) {
    fileSize = Number(metadata.format.size);
  }
  if (!fileSize || isNaN(fileSize)) {
    const stat = await fs.promises.stat(filePath);
    fileSize = stat.size;
  }

  return { title, duration, format, fileSize };
}

/**
 * Extract title from URL path (strips query params, returns filename without extension).
 */
export function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const filename = path.basename(pathname);
    // Remove extension
    const name = path.parse(filename).name;
    // Decode URI components (e.g., %20 → space)
    return decodeURIComponent(name) || 'Untitled';
  } catch {
    return 'Untitled';
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Run ffprobe on an audio file and return the raw metadata.
 */
function probeAudioFile(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

/**
 * Case-insensitive lookup for 'title' in format tags.
 * ID3 tags may use 'TITLE', 'Title', or 'title'.
 * Returns the title string or null if not found.
 */
function extractTitleFromTags(tags: Record<string, string | number> | undefined | null): string | null {
  if (!tags) return null;

  for (const key of Object.keys(tags)) {
    if (key.toLowerCase() === 'title') {
      const value = String(tags[key] ?? '').trim();
      if (value) return value;
    }
  }

  return null;
}

/**
 * Extract title from filename by removing the extension.
 */
function extractTitleFromFilename(filePath: string): string {
  const basename = path.basename(filePath);
  const name = path.parse(basename).name;
  return name || 'Untitled';
}

// ---------------------------------------------------------------------------
// Save & Download
// ---------------------------------------------------------------------------

/**
 * Save an audio file to storage and create a database record.
 *
 * Steps:
 * 1. Validate the audio file (format + size + ffprobe)
 * 2. Generate a UUID for the track ID
 * 3. Determine file extension from filename
 * 4. Save the file to StorageProvider at path `audio/{userId}/{trackId}.{ext}`
 * 5. Write buffer to a temp file, call extractAudioMetadata to get title/duration/format/fileSize
 * 6. Insert a record into the audio_tracks database table
 * 7. Return the AudioTrack object
 */
export async function saveAudioTrack(userId: string, file: Buffer, filename: string): Promise<AudioTrack> {
  // 1. Validate
  const validation = await validateAudioFile(file, filename);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid audio file');
  }

  // 2. Generate track ID
  const trackId = crypto.randomUUID();

  // 3. Determine file extension
  const ext = path.extname(filename).toLowerCase().replace('.', '');

  // 4. Save to StorageProvider
  const storagePath = `audio/${userId}/${trackId}.${ext}`;
  const storageProvider = getStorageProvider();
  await storageProvider.save(storagePath, file);

  // 5. Write to temp file and extract metadata
  const tempDir = getTempDir();
  const tempFile = path.join(tempDir, `audio-meta-${trackId}.${ext}`);
  let metadata: AudioMetadata;
  try {
    fs.writeFileSync(tempFile, file);
    metadata = await extractAudioMetadata(tempFile);
  } finally {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }

  // 6. Insert database record
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    INSERT INTO audio_tracks (id, user_id, title, file_path, format, duration, file_size, source, source_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', NULL, ?)
  `).run(trackId, userId, metadata.title, storagePath, metadata.format, metadata.duration, metadata.fileSize, now);

  // 7. Return AudioTrack object
  return {
    id: trackId,
    userId,
    title: metadata.title,
    filePath: storagePath,
    format: metadata.format as AudioTrack['format'],
    duration: metadata.duration,
    fileSize: metadata.fileSize,
    source: 'upload',
    createdAt: now,
  };
}

/**
 * Download audio from a URL, validate, and save to the audio library.
 *
 * Steps:
 * 1. Download the URL content
 * 2. Validate the downloaded buffer (format + size)
 * 3. Extract title from URL using extractTitleFromUrl
 * 4. Save to storage and create database record (similar to saveAudioTrack)
 * 5. Set source: 'download' and sourceUrl in the database record
 * 6. Return the AudioTrack object
 * 7. Handle errors: network failures, invalid content, size exceeded
 */
export async function downloadAudioFromUrl(userId: string, url: string): Promise<AudioTrack> {
  // 1. Download the URL content
  let buffer: Buffer;
  try {
    buffer = await downloadBuffer(url);
  } catch (err: any) {
    throw new Error(`Download failed: ${err.message || 'Network error'}`);
  }

  // 2. Determine filename from URL for extension detection
  const urlTitle = extractTitleFromUrl(url);
  const parsedUrl = new URL(url);
  const urlFilename = path.basename(parsedUrl.pathname) || 'audio.mp3';

  // Validate the downloaded buffer
  const ext = path.extname(urlFilename).toLowerCase().replace('.', '');
  const filenameForValidation = ext && SUPPORTED_EXTENSIONS.includes(ext)
    ? urlFilename
    : `download.mp3`; // fallback — will be re-detected via ffprobe

  // If extension is not recognized, try to detect from content
  let effectiveFilename = filenameForValidation;
  if (!ext || !SUPPORTED_EXTENSIONS.includes(ext)) {
    // Try each supported extension with ffprobe
    const detectedExt = await detectAudioExtension(buffer);
    if (detectedExt) {
      effectiveFilename = `download.${detectedExt}`;
    } else {
      throw new Error('Downloaded content is not a supported audio format');
    }
  }

  const validation = await validateAudioFile(buffer, effectiveFilename);
  if (!validation.valid) {
    throw new Error(validation.error || 'Downloaded content is not a supported audio format');
  }

  // 3. Generate track ID and determine extension
  const trackId = crypto.randomUUID();
  const finalExt = path.extname(effectiveFilename).toLowerCase().replace('.', '');

  // 4. Save to StorageProvider
  const storagePath = `audio/${userId}/${trackId}.${finalExt}`;
  const storageProvider = getStorageProvider();
  await storageProvider.save(storagePath, buffer);

  // 5. Extract metadata from temp file
  const tempDir = getTempDir();
  const tempFile = path.join(tempDir, `audio-dl-${trackId}.${finalExt}`);
  let metadata: AudioMetadata;
  try {
    fs.writeFileSync(tempFile, buffer);
    metadata = await extractAudioMetadata(tempFile);
  } finally {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }

  // Use URL-derived title if metadata doesn't have one or it's just 'Untitled'
  const title = (metadata.title && metadata.title !== 'Untitled') ? metadata.title : urlTitle;

  // 6. Insert database record with source='download' and sourceUrl
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    INSERT INTO audio_tracks (id, user_id, title, file_path, format, duration, file_size, source, source_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'download', ?, ?)
  `).run(trackId, userId, title, storagePath, metadata.format, metadata.duration, metadata.fileSize, url, now);

  // 7. Return AudioTrack object
  return {
    id: trackId,
    userId,
    title,
    filePath: storagePath,
    format: metadata.format as AudioTrack['format'],
    duration: metadata.duration,
    fileSize: metadata.fileSize,
    source: 'download',
    sourceUrl: url,
    createdAt: now,
  };
}

/**
 * Download a URL and return the content as a Buffer.
 * Supports HTTP and HTTPS. Follows redirects (up to 5).
 */
function downloadBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      return reject(new Error('Too many redirects'));
    }

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.get(url, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume(); // Consume response to free up memory
        return downloadBuffer(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        // Abort early if exceeds max file size
        if (totalSize > MAX_FILE_SIZE) {
          req.destroy();
          return reject(new Error('File size exceeds 50MB limit'));
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    // Set a timeout for the request
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Try to detect the audio format of a buffer by writing it to temp files
 * with different extensions and probing with ffprobe.
 * Returns the detected extension or null if not a valid audio file.
 */
async function detectAudioExtension(buffer: Buffer): Promise<string | null> {
  const tempDir = getTempDir();

  for (const ext of SUPPORTED_EXTENSIONS) {
    const tempFile = path.join(tempDir, `audio-detect-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    try {
      fs.writeFileSync(tempFile, buffer);
      const hasAudio = await probeForAudioStream(tempFile);
      if (hasAudio) {
        return ext;
      }
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Delete an audio track: removes the file from StorageProvider and the database record.
 * Throws an error if the track is not found or does not belong to the specified user.
 */
export async function deleteAudioTrack(trackId: string, userId: string): Promise<void> {
  const db = getDb();

  const row = db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(trackId) as AudioTrackRow | undefined;

  if (!row) {
    throw new Error('Audio track not found');
  }

  if (row.user_id !== userId) {
    throw new Error('Audio track not found');
  }

  // Delete file from storage
  const storageProvider = getStorageProvider();
  await storageProvider.delete(row.file_path);

  // Delete database record
  db.prepare('DELETE FROM audio_tracks WHERE id = ?').run(trackId);
}

/**
 * List all audio tracks belonging to a user.
 */
export async function listUserTracks(userId: string): Promise<AudioTrack[]> {
  const db = getDb();

  // Include both user's own tracks and system default tracks
  const rows = db.prepare(
    'SELECT * FROM audio_tracks WHERE user_id = ? OR user_id = ? ORDER BY created_at DESC'
  ).all(userId, 'system') as AudioTrackRow[];

  return rows.map(rowToAudioTrack);
}

/**
 * Get a single audio track by ID.
 * Returns null if not found.
 */
export async function getTrackById(trackId: string): Promise<AudioTrack | null> {
  const db = getDb();

  const row = db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(trackId) as AudioTrackRow | undefined;

  if (!row) {
    return null;
  }

  return rowToAudioTrack(row);
}

// ---------------------------------------------------------------------------
// Waveform Generation
// ---------------------------------------------------------------------------

/** Target number of amplitude samples to return */
const WAVEFORM_SAMPLES = 200;

/**
 * Generate waveform data for an audio track.
 *
 * Returns ~200 normalized amplitude values (0-1) representing the audio's
 * visual waveform. Uses ffmpeg to decode the audio to raw 32-bit float PCM
 * (mono), then divides the samples into ~200 equal chunks and computes the
 * peak absolute amplitude for each chunk. All values are normalized by dividing
 * by the global maximum amplitude.
 *
 * Throws if the track is not found or ffmpeg fails.
 */
export async function generateWaveformData(trackId: string): Promise<number[]> {
  const db = getDb();

  const row = db.prepare('SELECT * FROM audio_tracks WHERE id = ?').get(trackId) as AudioTrackRow | undefined;
  if (!row) {
    throw new Error('Audio track not found');
  }

  // Download audio file to temp
  const storageProvider = getStorageProvider();
  const localPath = await storageProvider.downloadToTemp(row.file_path);

  // Use ffmpeg to extract raw PCM float32 mono samples
  const rawPcmPath = path.join(
    getTempDir(),
    `waveform-${trackId}-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`
  );

  try {
    await extractRawPcm(localPath, rawPcmPath);

    // Read raw PCM data (32-bit float, little-endian, mono)
    const rawBuffer = fs.readFileSync(rawPcmPath);
    const sampleCount = rawBuffer.length / 4; // 4 bytes per float32

    if (sampleCount === 0) {
      return new Array(WAVEFORM_SAMPLES).fill(0);
    }

    // Divide samples into ~200 equal chunks
    const samplesPerChunk = Math.max(1, Math.floor(sampleCount / WAVEFORM_SAMPLES));
    const chunks: number[] = [];

    for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
      const start = i * samplesPerChunk;
      const end = Math.min(start + samplesPerChunk, sampleCount);

      if (start >= sampleCount) {
        chunks.push(0);
        continue;
      }

      // Find peak absolute amplitude in this chunk
      let peak = 0;
      for (let j = start; j < end; j++) {
        const value = Math.abs(rawBuffer.readFloatLE(j * 4));
        if (value > peak) {
          peak = value;
        }
      }
      chunks.push(peak);
    }

    // Normalize all values to 0-1 range
    const maxAmplitude = Math.max(...chunks);
    if (maxAmplitude === 0) {
      return chunks; // All silence
    }

    return chunks.map((v) => v / maxAmplitude);
  } finally {
    // Clean up temp PCM file
    try {
      fs.unlinkSync(rawPcmPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Use ffmpeg to decode an audio file to raw 32-bit float PCM (mono, 8000 Hz).
 * Lower sample rate reduces data size while preserving waveform shape.
 */
function extractRawPcm(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-ac', '1',           // mono
      '-ar', '8000',        // 8kHz sample rate (sufficient for waveform visualization)
      '-f', 'f32le',        // 32-bit float, little-endian
      '-y',                 // overwrite output
      outputPath,
    ];

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}
