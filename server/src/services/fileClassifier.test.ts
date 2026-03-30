import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { classify } from './fileClassifier';

function tmpFile(name: string, content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, content);
  return fp;
}

const dirs: string[] = [];
function tracked(name: string, content: Buffer): string {
  const fp = tmpFile(name, content);
  dirs.push(path.dirname(fp));
  return fp;
}

afterEach(() => {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('FileClassifier.classify', () => {
  // --- Magic bytes detection ---
  it('should detect JPEG from magic bytes', async () => {
    // JPEG starts with FF D8 FF
    const buf = Buffer.alloc(64);
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
    const fp = tracked('test.dat', buf);
    const result = await classify(fp);
    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('should detect PNG from magic bytes', async () => {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const buf = Buffer.alloc(64);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fp = tracked('test.dat', buf);
    const result = await classify(fp);
    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/png');
  });

  // --- Extension fallback ---
  it('should fall back to extension for .jpg when magic bytes unrecognized', async () => {
    const buf = Buffer.from('not real image data');
    const fp = tracked('photo.jpg', buf);
    const result = await classify(fp);
    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('should fall back to extension for .mp4', async () => {
    const buf = Buffer.from('not real video data');
    const fp = tracked('clip.mp4', buf);
    const result = await classify(fp);
    expect(result.type).toBe('video');
    expect(result.mimeType).toBe('video/mp4');
  });

  it('should fall back to extension for .mov', async () => {
    const buf = Buffer.from('not real video data');
    const fp = tracked('clip.mov', buf);
    const result = await classify(fp);
    expect(result.type).toBe('video');
    expect(result.mimeType).toBe('video/quicktime');
  });

  it('should fall back to extension for .mkv', async () => {
    const buf = Buffer.from('not real video data');
    const fp = tracked('clip.mkv', buf);
    const result = await classify(fp);
    expect(result.type).toBe('video');
    expect(result.mimeType).toBe('video/x-matroska');
  });

  it('should fall back to extension for .webp', async () => {
    const buf = Buffer.from('not real webp data');
    const fp = tracked('img.webp', buf);
    const result = await classify(fp);
    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/webp');
  });

  it('should fall back to extension for .heic', async () => {
    const buf = Buffer.from('not real heic data');
    const fp = tracked('img.heic', buf);
    const result = await classify(fp);
    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/heic');
  });

  // --- Unknown ---
  it('should return unknown for unrecognized file', async () => {
    const buf = Buffer.from('random binary garbage');
    const fp = tracked('mystery.xyz', buf);
    const result = await classify(fp);
    expect(result.type).toBe('unknown');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('should return unknown for empty file with unknown extension', async () => {
    const fp = tracked('empty.zzz', Buffer.alloc(0));
    const result = await classify(fp);
    expect(result.type).toBe('unknown');
    expect(result.mimeType).toBe('application/octet-stream');
  });
});
