import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

const DEFAULT_EXPIRE_HOURS = 72;

export async function cleanupExpiredUploads(): Promise<number> {
  const expireHours = parseInt(process.env.UPLOAD_EXPIRE_HOURS || '', 10) || DEFAULT_EXPIRE_HOURS;
  const db = getDb();
  const storage = getStorageProvider();

  const cutoff = new Date(Date.now() - expireHours * 60 * 60 * 1000).toISOString();

  const expired = db.prepare(
    `SELECT id, media_id, storage_key FROM upload_sessions WHERE status = 'active' AND updated_at < ?`
  ).all(cutoff) as Array<{ id: string; media_id: string; storage_key: string }>;

  let cleaned = 0;
  const now = new Date().toISOString();

  for (const session of expired) {
    try {
      await storage.abortMultipartUpload(session.storage_key, session.id);
    } catch (err) {
      console.error(`[uploadCleanup] abortMultipartUpload failed for session ${session.id}:`, err);
    }

    db.prepare(`UPDATE upload_sessions SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, session.id);
    db.prepare(`UPDATE media_items SET processing_status = 'expired' WHERE id = ?`).run(session.media_id);
    cleaned++;
  }

  if (cleaned > 0) {
    console.log(`[uploadCleanup] Cleaned ${cleaned} expired upload session(s)`);
  }

  return cleaned;
}
