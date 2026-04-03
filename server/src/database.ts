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
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
