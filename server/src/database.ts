import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initDefaultData } from './services/userService';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'travel-album.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initTables(db);
  initDefaultData(db);

  return db;
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'regular',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cover_image_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      perceptual_hash TEXT,
      quality_score REAL,
      sharpness_score REAL,
      duplicate_group_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (trip_id) REFERENCES trips(id),
      FOREIGN KEY (duplicate_group_id) REFERENCES duplicate_groups(id)
    );

    CREATE TABLE IF NOT EXISTS duplicate_groups (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      default_image_id TEXT,
      image_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_media_tags_media_id ON media_tags(media_id);
    CREATE INDEX IF NOT EXISTS idx_media_tags_tag_name ON media_tags(tag_name);

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step TEXT,
      percent INTEGER DEFAULT 0,
      processed INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      error_message TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE TABLE IF NOT EXISTS processing_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      step TEXT,
      message TEXT NOT NULL,
      processed INTEGER,
      total INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_processing_job_events_job_seq ON processing_job_events(job_id, seq);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_active_trip ON processing_jobs(trip_id) WHERE status IN ('queued', 'running');

    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      total_parts INTEGER,
      part_size INTEGER,
      file_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id),
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE INDEX IF NOT EXISTS idx_upload_sessions_media ON upload_sessions(media_id);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);

    CREATE TABLE IF NOT EXISTS video_segments (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      duration REAL NOT NULL,
      sharpness_score REAL,
      stability_score REAL,
      exposure_score REAL,
      overall_score REAL,
      label TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_segments_media_index ON video_segments(media_id, segment_index);
    CREATE INDEX IF NOT EXISTS idx_video_segments_media ON video_segments(media_id);

    CREATE TABLE IF NOT EXISTS media_versions (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      version_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      duration REAL,
      model_name TEXT,
      processor_name TEXT,
      params TEXT,
      status TEXT DEFAULT 'ready',
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_versions_media_id ON media_versions(media_id);

    CREATE TABLE IF NOT EXISTS media_analysis (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      blur_score REAL,
      sharpness_score REAL,
      exposure_score REAL,
      color_score REAL,
      noise_score REAL,
      aesthetic_score REAL,
      quality_score REAL,
      is_blurry INTEGER DEFAULT 0,
      is_overexposed INTEGER DEFAULT 0,
      is_underexposed INTEGER DEFAULT 0,
      is_duplicate INTEGER DEFAULT 0,
      is_recommended INTEGER DEFAULT 0,
      recommendation TEXT,
      reason TEXT,
      analysis_version TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_analysis_media_id ON media_analysis(media_id);

    CREATE TABLE IF NOT EXISTS duplicate_group_items (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      similarity_score REAL,
      quality_score REAL,
      recommendation TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES duplicate_groups(id),
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_duplicate_group_items_group_id ON duplicate_group_items(group_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_group_items_group_media ON duplicate_group_items(group_id, media_id);

    CREATE TABLE IF NOT EXISTS ai_invocations (
      id TEXT PRIMARY KEY,
      media_id TEXT,
      segment_id TEXT,
      provider TEXT,
      model_name TEXT,
      task_type TEXT,
      request_payload TEXT,
      response_payload TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost REAL,
      status TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_invocations_media_id ON ai_invocations(media_id);
    CREATE INDEX IF NOT EXISTS idx_ai_invocations_task_type ON ai_invocations(task_type);

    CREATE TABLE IF NOT EXISTS segment_ai_analysis (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      scene_description TEXT,
      emotion_tags TEXT,
      narrative_score INTEGER,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_segment_ai_media_index
      ON segment_ai_analysis(media_id, segment_index);
    CREATE INDEX IF NOT EXISTS idx_segment_ai_media
      ON segment_ai_analysis(media_id);

    CREATE TABLE IF NOT EXISTS ai_edit_plans (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      pace TEXT,
      total_duration REAL,
      segment_count INTEGER,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      fallback_used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_edit_plans_media
      ON ai_edit_plans(media_id);

    CREATE TABLE IF NOT EXISTS ai_generated_texts (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      text_type TEXT NOT NULL,
      style TEXT,
      content_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_generated_texts_media
      ON ai_generated_texts(media_id);
    CREATE INDEX IF NOT EXISTS idx_ai_generated_texts_type
      ON ai_generated_texts(media_id, text_type);

    CREATE TABLE IF NOT EXISTS ai_usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      media_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      call_type TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      estimated_cost REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_trip ON ai_usage_records(trip_id);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_type ON ai_usage_records(call_type);

    CREATE TABLE IF NOT EXISTS ai_budget_configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      monthly_limit REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_budget_user
      ON ai_budget_configs(user_id);
  `);

  // Migration: add visibility column to existing trips table
  try {
    db.exec(`ALTER TABLE trips ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add status column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add trashed_reason column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN trashed_reason TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add processing_error column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN processing_error TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add processing_status column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN processing_status TEXT DEFAULT 'none'`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add optimized_path column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN optimized_path TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add compiled_path column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN compiled_path TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add user_id column to trips table
  try {
    db.exec(`ALTER TABLE trips ADD COLUMN user_id TEXT REFERENCES users(id)`);
  } catch {
    // Column already exists
  }

  // Migration: add user_id column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN user_id TEXT REFERENCES users(id)`);
  } catch {
    // Column already exists
  }

  // Migration: add visibility column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  } catch {
    // Column already exists
  }

  // Migration: add blur_status column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN blur_status TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add exposure_score column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN exposure_score REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add contrast_score column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN contrast_score REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add noise_score column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN noise_score REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add phash column to media_items table
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN phash TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add avg_brightness column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN avg_brightness REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add contrast_level column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN contrast_level REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add color_cast_r column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN color_cast_r REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add color_cast_g column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN color_cast_g REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add color_cast_b column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN color_cast_b REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add noise_level column to media_items table (image analysis)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN noise_level REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add category column to media_items table (image classification)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN category TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add upload_id column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN upload_id TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add upload_mode column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN upload_mode TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add storage_key column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN storage_key TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add video_duration column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN video_duration REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add video_width column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN video_width INTEGER`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add video_height column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN video_height INTEGER`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add video_codec column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN video_codec TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add video_bitrate column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN video_bitrate INTEGER`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add preview_proxy_path column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN preview_proxy_path TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add edit_proxy_path column to media_items table (video upload pipeline)
  try {
    db.exec(`ALTER TABLE media_items ADD COLUMN edit_proxy_path TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: clean orphan duplicate_group_id references
  // The new pipeline doesn't maintain duplicate_groups table, but old data may have
  // dangling references that cause FOREIGN KEY constraint failures on UPDATE.
  try {
    const cleaned = db.prepare(
      `UPDATE media_items SET duplicate_group_id = NULL
       WHERE duplicate_group_id IS NOT NULL
       AND duplicate_group_id NOT IN (SELECT id FROM duplicate_groups)`
    ).run();
    if (cleaned.changes > 0) {
      console.log(`[database] Cleaned ${cleaned.changes} orphan duplicate_group_id references`);
    }
  } catch {
    // Ignore — table might not exist yet
  }

  // Migration: add black_frame_score column to video_segments table (v2-video-processing)
  try {
    db.exec(`ALTER TABLE video_segments ADD COLUMN black_frame_score REAL`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add is_junk column to video_segments table (v2-video-processing)
  try {
    db.exec(`ALTER TABLE video_segments ADD COLUMN is_junk INTEGER DEFAULT 0`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Migration: add junk_reason column to video_segments table (v2-video-processing)
  try {
    db.exec(`ALTER TABLE video_segments ADD COLUMN junk_reason TEXT`);
  } catch {
    // Column already exists — ignore for idempotency
  }

  // Cleanup zombie processing jobs (running/queued) left from previous server instance
  try {
    const now = new Date().toISOString();
    const zombieJobs = db.prepare(
      `SELECT id FROM processing_jobs WHERE status IN ('running', 'queued')`
    ).all() as Array<{ id: string }>;

    if (zombieJobs.length > 0) {
      const updateJob = db.prepare(
        `UPDATE processing_jobs SET status = 'failed', error_message = '服务重启，任务中断', finished_at = ? WHERE id = ?`
      );
      const insertEvent = db.prepare(
        `INSERT INTO processing_job_events (job_id, seq, level, step, message, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM processing_job_events WHERE job_id = ?), 'error', NULL, '服务重启，任务中断', ?)`
      );

      const cleanup = db.transaction(() => {
        for (const job of zombieJobs) {
          updateJob.run(now, job.id);
          insertEvent.run(job.id, job.id, now);
        }
      });
      cleanup();

      console.log(`[database] Cleaned up ${zombieJobs.length} zombie processing job(s)`);
    }
  } catch {
    // Ignore — table might not exist yet
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
