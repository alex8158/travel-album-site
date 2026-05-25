import { describe, it, expect } from 'vitest';
import {
  calculateOutputResolution,
  buildSlideshowArgs,
  buildAudioMixArgs,
} from './slideshowGenerator';

describe('SlideshowGenerator', () => {
  describe('calculateOutputResolution', () => {
    it('returns max dimensions from photos', () => {
      const dims = [
        { width: 800, height: 600 },
        { width: 1200, height: 900 },
        { width: 1000, height: 700 },
      ];
      const result = calculateOutputResolution(dims);
      expect(result.width).toBe(1200);
      expect(result.height).toBe(900);
    });

    it('caps at 1920x1080 when photos exceed max', () => {
      const dims = [{ width: 3840, height: 2160 }];
      const result = calculateOutputResolution(dims);
      expect(result.width).toBeLessThanOrEqual(1920);
      expect(result.height).toBeLessThanOrEqual(1080);
    });

    it('scales proportionally when exceeding max', () => {
      // 4000x2000 → scale = min(1920/4000, 1080/2000) = min(0.48, 0.54) = 0.48
      // → 4000*0.48=1920, 2000*0.48=960
      const dims = [{ width: 4000, height: 2000 }];
      const result = calculateOutputResolution(dims);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(960);
    });

    it('ensures even dimensions', () => {
      const dims = [{ width: 801, height: 601 }];
      const result = calculateOutputResolution(dims);
      expect(result.width % 2).toBe(0);
      expect(result.height % 2).toBe(0);
    });

    it('handles empty dimensions array with defaults', () => {
      const result = calculateOutputResolution([]);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it('respects custom max dimensions', () => {
      const dims = [{ width: 1000, height: 800 }];
      const result = calculateOutputResolution(dims, 640, 480);
      expect(result.width).toBeLessThanOrEqual(640);
      expect(result.height).toBeLessThanOrEqual(480);
    });
  });

  describe('buildSlideshowArgs', () => {
    it('includes all photo paths as inputs with -loop 1 -t duration', () => {
      const paths = ['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg'];
      const args = buildSlideshowArgs(paths, '/out/video.mp4', { width: 1920, height: 1080 }, 2);

      // Each photo should have -loop 1 -t 2 -i <path>
      for (const p of paths) {
        const idx = args.indexOf(p);
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx - 1]).toBe('-i');
        expect(args[idx - 2]).toBe('2');
        expect(args[idx - 3]).toBe('-t');
        expect(args[idx - 4]).toBe('1');
        expect(args[idx - 5]).toBe('-loop');
      }
    });

    it('preserves photo order in inputs', () => {
      const paths = ['/tmp/first.jpg', '/tmp/second.jpg', '/tmp/third.jpg'];
      const args = buildSlideshowArgs(paths, '/out/video.mp4', { width: 1920, height: 1080 });

      const inputIndices = paths.map((p) => args.indexOf(p));
      for (let i = 1; i < inputIndices.length; i++) {
        expect(inputIndices[i]).toBeGreaterThan(inputIndices[i - 1]);
      }
    });

    it('includes filter_complex with scale+pad+concat', () => {
      const paths = ['/tmp/a.jpg', '/tmp/b.jpg'];
      const args = buildSlideshowArgs(paths, '/out/video.mp4', { width: 1280, height: 720 });

      const fcIdx = args.indexOf('-filter_complex');
      expect(fcIdx).toBeGreaterThan(-1);

      const filterComplex = args[fcIdx + 1];
      expect(filterComplex).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
      expect(filterComplex).toContain('pad=1280:720');
      expect(filterComplex).toContain('concat=n=2:v=1:a=0');
    });

    it('outputs with libx264, yuv420p, no audio', () => {
      const paths = ['/tmp/a.jpg'];
      const args = buildSlideshowArgs(paths, '/out/video.mp4', { width: 1920, height: 1080 });

      expect(args).toContain('-c:v');
      expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
      expect(args).toContain('-pix_fmt');
      expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
      expect(args).toContain('-an');
    });

    it('starts with -y for overwrite', () => {
      const paths = ['/tmp/a.jpg'];
      const args = buildSlideshowArgs(paths, '/out/video.mp4', { width: 1920, height: 1080 });
      expect(args[0]).toBe('-y');
    });

    it('ends with output path', () => {
      const paths = ['/tmp/a.jpg'];
      const outputPath = '/out/video.mp4';
      const args = buildSlideshowArgs(paths, outputPath, { width: 1920, height: 1080 });
      expect(args[args.length - 1]).toBe(outputPath);
    });
  });

  describe('buildAudioMixArgs', () => {
    it('uses -stream_loop -1 when audio is shorter than video', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 5);
      const loopIdx = args.indexOf('-stream_loop');
      expect(loopIdx).toBeGreaterThan(-1);
      expect(args[loopIdx + 1]).toBe('-1');
    });

    it('does not use -stream_loop when audio is longer than video', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 20);
      expect(args).not.toContain('-stream_loop');
    });

    it('does not use -stream_loop when audio equals video duration', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 10);
      expect(args).not.toContain('-stream_loop');
    });

    it('truncates at video duration with -t', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 12, 20);
      const tIdx = args.lastIndexOf('-t');
      expect(tIdx).toBeGreaterThan(-1);
      expect(args[tIdx + 1]).toBe('12');
    });

    it('maps video from input 0 and audio from input 1', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 5);
      expect(args).toContain('-map');
      expect(args).toContain('0:v');
      expect(args).toContain('1:a');
    });

    it('copies video codec and encodes audio as aac 128k', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 5);
      expect(args).toContain('-c:v');
      expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
      expect(args).toContain('-c:a');
      expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
      expect(args).toContain('-b:a');
      expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
    });

    it('includes -movflags +faststart', () => {
      const args = buildAudioMixArgs('/v.mp4', '/a.mp3', '/out.mp4', 10, 5);
      expect(args).toContain('-movflags');
      expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
    });
  });
});
