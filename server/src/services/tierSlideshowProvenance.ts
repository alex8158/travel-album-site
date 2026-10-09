/**
 * Tier slideshow provenance — naming, hashing and the publish protocol
 * (multi-user-system G-20, 需求 9 AC 12–15; highlight-tier 需求 6 AC 9).
 *
 * Every tier slideshow produced by a generation entry point is registered in
 * `tier_slideshow_artifacts` with a sealed, ordered manifest of the media ids that
 * were actually baked into the video (the generator's `skippedPhotos` removed).
 * The table's triggers (see database.ts) make rows immutable apart from the single
 * published → superseded transition, allow removal only via trip deletion, and stop
 * a referenced media id from being re-inserted or re-keyed.
 *
 * Two digests, never interchangeable:
 *   - manifest_sha256 = sha256(canonical JSON array of source ids, baked order)
 *   - file_sha256     = sha256(video bytes)
 * The published file name embeds artifact id + manifest_sha256. That binding is
 * hardening only; read decisions always re-check the sealed row, the current
 * state of every source and the full file hash (see tierSlideshowAccess.ts).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { generateSlideshow } from './slideshowGenerator';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Every file name with this prefix is reserved for registered C2 artifacts. */
export const ARTIFACT_FILE_PREFIX = 'tsa_';
export const ARTIFACT_FILE_RE = /^tsa_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{64})\.mp4$/;
export const CATEGORY_RE = /^[a-z0-9_-]{1,64}$/;
/** Same character set the DB insert guard enforces for manifest entries. */
const MEDIA_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
/** Name of the exclusive publish candidate inside the per-attempt staging dir. */
const CANDIDATE_NAME = 'publish-candidate.mp4';

export function getUploadsBase(): string {
  return path.resolve(__dirname, '..', '..', 'uploads');
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Canonical manifest text: minified JSON array of ids, in baked order. */
export function canonicalManifest(mediaIds: string[]): string {
  return JSON.stringify(mediaIds);
}

export function buildArtifactRelPath(
  tripId: string,
  category: string,
  artifactId: string,
  manifestSha256: string,
): string {
  return `${tripId}/tier-slideshow/${category}/${ARTIFACT_FILE_PREFIX}${artifactId}_${manifestSha256}.mp4`;
}

export function artifactUrl(tripId: string, category: string, relPath: string): string {
  return `/api/trips/${tripId}/tier-slideshow/${category}/${path.posix.basename(relPath)}`;
}

export interface TierArtifactRow {
  id: string;
  trip_id: string;
  category: string;
  status: 'published' | 'superseded';
  manifest_json: string;
  source_count: number;
  manifest_sha256: string;
  file_sha256: string;
  file_size: number;
  rel_path: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export interface FdDigest {
  sha256: string;
  size: number;
  ino: number;
  nlink: number;
  isFile: boolean;
}

/** fstat + sha256 of one open file descriptor, so every value describes the same file. */
export async function digestFd(fd: number): Promise<FdDigest> {
  const st = await new Promise<fs.Stats>((resolve, reject) => fs.fstat(fd, (e, s) => (e ? reject(e) : resolve(s))));
  const hash = crypto.createHash('sha256');
  if (st.isFile()) {
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = 0;
    for (;;) {
      const n = await new Promise<number>((resolve, reject) =>
        fs.read(fd, buf, 0, buf.length, pos, (e, bytes) => (e ? reject(e) : resolve(bytes))),
      );
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
    if (pos !== st.size) throw new Error(`file changed while hashing (${pos} != ${st.size})`);
  }
  return { sha256: hash.digest('hex'), size: st.size, ino: st.ino, nlink: st.nlink, isFile: st.isFile() };
}

/** Open read-only without following a final symlink. */
export function openNoFollow(filePath: string): number {
  return fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
}

/** Digest of a path, read through one descriptor that is closed before returning. */
export async function hashFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const fd = openNoFollow(filePath);
  try {
    const d = await digestFd(fd);
    return { sha256: d.sha256, size: d.size };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Publish protocol
// ---------------------------------------------------------------------------

export interface PublishTestHooks {
  /** After the exclusive candidate copy exists (before it is sealed and hashed). */
  afterCopy?: (ctx: { staged: string; candidate: string }) => void | Promise<void>;
  afterLink?: (ctx: { staged: string; candidate: string; final: string }) => void | Promise<void>;
  afterUnlink?: (ctx: { staged: string; final: string }) => void | Promise<void>;
  /** Runs inside the IMMEDIATE transaction, after supersede and before insert. */
  inTransaction?: () => void;
}

export interface PublishTierSlideshowInput {
  tripId: string;
  category: string;
  /** Downloaded sources, in the order they are handed to the generator. */
  sources: Array<{ mediaId: string; localPath: string }>;
  photoDuration: number;
  /** Test-only fault injection. Never set by production callers. */
  testHooks?: PublishTestHooks;
}

export type PublishStage = 'validate' | 'generate' | 'stage' | 'copy' | 'link' | 'unlink' | 'verify' | 'register';

export type PublishOutcome =
  | {
      ok: true;
      artifactId: string;
      relPath: string;
      url: string;
      manifest: string[];
      skippedMediaIds: string[];
      totalDuration: number;
      fileSha256: string;
    }
  | { ok: false; artifactId: string; stage: PublishStage; error: string };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Generate one category's tier slideshow and publish it with sealed provenance.
 *
 * 1. Generate into `uploads/<trip>/.tier-staging/<artifactId>/<category>/`. Continue only
 *    after the generator returned (ffmpeg exited and its stdio closed).
 * 2. Manifest = sources minus `skippedPhotos`, in baked order.
 * 3. Copy the generator output to an exclusive candidate `.tier-staging/<artifactId>/
 *    publish-candidate.mp4` (COPYFILE_EXCL). The candidate is a different inode, so any
 *    descriptor still open on the generator output can never reach published bytes.
 * 4. chmod 0444, fsync, then fstat + sha256 the candidate through one read-only fd.
 * 5. `link(candidate, final)` — never overwrites (EEXIST fails closed) — then unlink the
 *    candidate name, so `final` is the only name of that inode.
 * 6. Re-hash `final` through a fresh no-follow fd: same inode, one link, same sha/size.
 * 7. One IMMEDIATE transaction: supersede the category's published row, insert the new one.
 * 8. Remove this attempt's own generator output (exact path; not a directory sweep).
 * Any failure after step 5 leaves an unregistered `final` file. It is never listed or
 * served (it has no row). Nothing here deletes published, superseded or orphaned files,
 * and no general staging cleanup is performed.
 */
export async function publishTierSlideshow(input: PublishTierSlideshowInput): Promise<PublishOutcome> {
  const { tripId, category, sources, photoDuration, testHooks } = input;
  const artifactId = uuidv4();
  const log = (stage: string, msg: string) =>
    console.log(`[tier-provenance] tripId=${tripId} category=${category} artifactId=${artifactId} stage=${stage} ${msg}`);
  const fail = (stage: PublishStage, error: string): PublishOutcome => {
    console.warn(`[tier-provenance] tripId=${tripId} category=${category} artifactId=${artifactId} stage=${stage} failed: ${error}`);
    return { ok: false, artifactId, stage, error };
  };

  if (!CATEGORY_RE.test(category)) return fail('validate', `非法类别名: ${category}`);
  if (sources.length === 0) return fail('validate', '没有可用照片');
  if (!sources.every((s) => MEDIA_ID_RE.test(s.mediaId))) return fail('validate', '来源照片 id 非法');
  if (new Set(sources.map((s) => s.mediaId)).size !== sources.length) {
    return fail('validate', '来源照片重复');
  }

  const uploadsBase = getUploadsBase();
  const attemptDir = path.join(uploadsBase, tripId, '.tier-staging', artifactId);
  const stagingDir = path.join(attemptDir, category);

  // 1. Generate. The generator resolves only after ffmpeg's 'close' event.
  let result: Awaited<ReturnType<typeof generateSlideshow>>;
  try {
    result = await generateSlideshow({
      photoPaths: sources.map((s) => s.localPath),
      audioPath: null,
      outputDir: stagingDir,
      photoDuration,
    });
  } catch (err) {
    return fail('generate', errText(err));
  }
  if (!result.success || !result.outputPath) return fail('generate', result.error || '生成失败');

  // 2. Validate the staged output and derive the baked manifest.
  const staged = path.resolve(result.outputPath);
  if (path.dirname(staged) !== path.resolve(stagingDir)) return fail('stage', '生成结果不在暂存目录内');
  let stagedIno: number;
  try {
    const st = fs.lstatSync(staged);
    if (!st.isFile()) return fail('stage', '生成结果不是普通文件');
    stagedIno = st.ino;
  } catch {
    return fail('stage', '生成结果不存在');
  }
  const skipped = new Set<number>();
  for (const i of result.skippedPhotos ?? []) {
    if (!Number.isInteger(i) || i < 0 || i >= sources.length) return fail('stage', `跳过下标越界: ${i}`);
    skipped.add(i);
  }
  const baked = sources.filter((_, i) => !skipped.has(i));
  if (baked.length === 0) return fail('stage', '没有照片被写入视频');
  const manifest = baked.map((s) => s.mediaId);
  const manifestJson = canonicalManifest(manifest);
  const manifestSha256 = sha256Hex(manifestJson);

  // 3. Exclusive candidate copy: a new inode that no other process has open.
  const candidate = path.join(attemptDir, CANDIDATE_NAME);
  try {
    fs.copyFileSync(staged, candidate, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    return fail('copy', errText(err));
  }
  if (testHooks?.afterCopy) await testHooks.afterCopy({ staged, candidate });

  // 4. Seal and hash the candidate through one read-only descriptor.
  let cand: FdDigest;
  try {
    fs.chmodSync(candidate, 0o444);
    const fd = openNoFollow(candidate);
    try {
      fs.fsyncSync(fd);
      cand = await digestFd(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return fail('copy', `读取发布候选失败: ${errText(err)}`);
  }
  if (!cand.isFile) return fail('copy', '发布候选不是普通文件');
  if (cand.ino === stagedIno) return fail('copy', '发布候选与生成输出共享 inode');
  if (cand.size === 0) return fail('copy', '生成结果为空文件');

  // 5. Publish the candidate under the immutable name; never overwrite.
  const relPath = buildArtifactRelPath(tripId, category, artifactId, manifestSha256);
  const final = path.join(uploadsBase, relPath);
  try {
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.linkSync(candidate, final);
  } catch (err) {
    return fail('link', errText(err));
  }
  if (testHooks?.afterLink) await testHooks.afterLink({ staged, candidate, final });
  try {
    fs.unlinkSync(candidate);
  } catch (err) {
    // The candidate name still reaches the published inode: do not register.
    return fail('unlink', errText(err));
  }
  if (testHooks?.afterUnlink) await testHooks.afterUnlink({ staged, final });

  // 6. Re-verify the published bytes through a fresh descriptor.
  let fin: FdDigest;
  try {
    const fd = openNoFollow(final);
    try {
      fin = await digestFd(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return fail('verify', errText(err));
  }
  if (!fin.isFile || fin.ino !== cand.ino || fin.nlink !== 1 || fin.sha256 !== cand.sha256 || fin.size !== cand.size) {
    return fail('verify', '发布文件与发布候选不一致');
  }

  // 7. Register: supersede + insert, atomically.
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `UPDATE tier_slideshow_artifacts SET status = 'superseded'
         WHERE trip_id = ? AND category = ? AND status = 'published'`,
      ).run(tripId, category);
      testHooks?.inTransaction?.();
      db.prepare(
        `INSERT INTO tier_slideshow_artifacts
           (id, trip_id, category, status, manifest_json, source_count, manifest_sha256,
            file_sha256, file_size, rel_path, created_at)
         VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifactId, tripId, category, manifestJson, manifest.length, manifestSha256,
        fin.sha256, fin.size, relPath, new Date().toISOString(),
      );
    }).immediate();
  } catch (err) {
    return fail('register', errText(err));
  }

  // 8. This attempt's own generator output is no longer needed (different inode).
  try {
    fs.unlinkSync(staged);
  } catch (err) {
    log('cleanup', `generator output not removed: ${errText(err)}`);
  }

  const skippedMediaIds = sources.filter((_, i) => skipped.has(i)).map((s) => s.mediaId);
  log('published', `sources=${manifest.length} skipped=${skippedMediaIds.length} bytes=${fin.size}`);
  return {
    ok: true,
    artifactId,
    relPath,
    url: artifactUrl(tripId, category, relPath),
    manifest,
    skippedMediaIds,
    totalDuration: result.totalDuration,
    fileSha256: fin.sha256,
  };
}
