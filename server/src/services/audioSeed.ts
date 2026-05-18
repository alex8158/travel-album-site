/**
 * Seeds default audio tracks into the database on server startup.
 * These are system-provided background music tracks available to all users.
 * They are stored with user_id = 'system' and are visible to everyone.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { getStorageProvider } from '../storage/factory';

interface DefaultTrack {
  filename: string;
  title: string;
  duration: number; // seconds
}

const DEFAULT_TRACKS: DefaultTrack[] = [
  { filename: 'gentle-morning.mp3', title: '清晨微光', duration: 30 },
  { filename: 'ocean-breeze.mp3', title: '海风轻拂', duration: 45 },
  { filename: 'sunset-glow.mp3', title: '落日余晖', duration: 60 },
];

const SYSTEM_USER_ID = 'system';

/**
 * Seed default audio tracks if they haven't been seeded yet.
 * Called during database initialization.
 */
export async function seedDefaultAudioTracks(db: Database.Database): Promise<void> {
  // Check if system tracks already exist
  const existing = db.prepare(
    'SELECT COUNT(*) as count FROM audio_tracks WHERE user_id = ?'
  ).get(SYSTEM_USER_ID) as { count: number };

  if (existing.count >= DEFAULT_TRACKS.length) {
    return; // Already seeded
  }

  const defaultAudioDir = path.join(__dirname, '..', '..', 'data', 'default-audio');
  if (!fs.existsSync(defaultAudioDir)) {
    console.warn('[AudioSeed] Default audio directory not found, skipping seed');
    return;
  }

  const storageProvider = getStorageProvider();

  for (const track of DEFAULT_TRACKS) {
    const filePath = path.join(defaultAudioDir, track.filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`[AudioSeed] File not found: ${track.filename}, skipping`);
      continue;
    }

    // Check if this specific track already exists
    const existingTrack = db.prepare(
      'SELECT id FROM audio_tracks WHERE user_id = ? AND title = ?'
    ).get(SYSTEM_USER_ID, track.title) as { id: string } | undefined;

    if (existingTrack) {
      continue; // Already seeded this track
    }

    const trackId = crypto.randomUUID();
    const ext = path.extname(track.filename).replace('.', '');
    const storagePath = `audio/${SYSTEM_USER_ID}/${trackId}.${ext}`;

    // Read file and upload to storage
    const buffer = fs.readFileSync(filePath);
    await storageProvider.save(storagePath, buffer);

    // Insert database record
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO audio_tracks (id, user_id, title, file_path, format, duration, file_size, source, source_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', NULL, ?)
    `).run(trackId, SYSTEM_USER_ID, track.title, storagePath, ext, track.duration, buffer.length, now);

    console.log(`[AudioSeed] Seeded default track: ${track.title}`);
  }
}
