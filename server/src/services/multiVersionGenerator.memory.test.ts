/**
 * Integration tests for MultiVersionGenerator memory protection behavior.
 *
 * Tests cover:
 * - Serial generation order (highlight → summary → extended)
 * - Memory pressure check before each version
 * - Critical pressure: wait up to 60s for recovery, skip on timeout
 * - Shared segment extraction and reuse across versions
 * - Cleanup of shared segment files after all versions complete
 * - Version failure cleanup and continuation
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateVersions, VersionProfile } from './multiVersionGenerator';
import { VideoSegment } from './videoAnalyzer';
import { MemoryManager, MemoryManagerConfig, MemoryPressureLevel, MemoryStatus, MemorySummary } from './memoryManager';
import { StreamProcessor, StreamTransferResult } from './streamProcessor';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

// Mock ffmpeg (fluent-ffmpeg)
vi.mock('fluent-ffmpeg', () => {
  const mockFfmpeg: any = (input?: string) => {
    const chain: any = {
      seekInput: () => chain,
      duration: () => chain,
      output: (outputPath: string) => {
        chain._outputPath = outputPath;
        return chain;
      },
      outputOptions: () => chain,
      input: (inputPath: string) => {
        chain._inputPath = inputPath;
        return chain;
      },
      inputOptions: () => chain,
      on: (event: string, handler: Function) => {
        if (event === 'end') chain._onEnd = handler;
        if (event === 'error') chain._onError = handler;
        return chain;
      },
      run: () => {
        // Simulate successful ffmpeg execution
        // Create the output file so fs.statSync works
        if (chain._outputPath) {
          const dir = path.dirname(chain._outputPath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(chain._outputPath, Buffer.alloc(1024)); // 1KB dummy file
        }
        if (chain._onEnd) {
          setTimeout(() => chain._onEnd(), 0);
        }
      },
      _outputPath: null as string | null,
      _inputPath: null as string | null,
      _onEnd: null as Function | null,
      _onError: null as Function | null,
    };
    return chain;
  };
  return { default: mockFfmpeg };
});

// Mock audioNormalizer
vi.mock('./audioNormalizer', () => ({
  normalizeSegments: vi.fn(async (segmentPaths: string[], outputDir: string) => {
    fs.mkdirSync(outputDir, { recursive: true });
    return segmentPaths.map((p) => ({
      skipped: true,
      normalizedPath: null,
    }));
  }),
}));

// Mock storage factory
const mockStorage = {
  save: vi.fn(async () => {}),
  read: vi.fn(async () => Buffer.alloc(0)),
  delete: vi.fn(async () => {}),
  exists: vi.fn(async () => false),
  getUrl: vi.fn(async () => ''),
  downloadToTemp: vi.fn(async () => ''),
  initMultipartUpload: vi.fn(async () => ''),
  getPresignedPartUrl: vi.fn(async () => ''),
  completeMultipartUpload: vi.fn(async () => {}),
  abortMultipartUpload: vi.fn(async () => {}),
  listParts: vi.fn(async () => []),
  getPresignedUploadUrl: vi.fn(async () => ''),
};

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => mockStorage,
}));

// Mock database
const mockDbRun = vi.fn();
vi.mock('../database', () => ({
  getDb: () => ({
    prepare: () => ({
      run: mockDbRun,
    }),
  }),
}));

// Mock uuid
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSegment(overrides: Partial<VideoSegment> & { index: number; startTime: number; endTime: number; duration: number; overallScore: number }): VideoSegment {
  return {
    sharpnessScore: 70,
    stabilityScore: 80,
    exposureScore: 60,
    label: 'good',
    ...overrides,
  };
}

function createMockMemoryManager(overrides?: Partial<MemoryManager>): MemoryManager {
  const defaultConfig: MemoryManagerConfig = {
    memoryLimitMB: 1024,
    warningRatio: 0.7,
    criticalRatio: 0.85,
    checkIntervalMs: 5000,
    debounceDurationMs: 5000,
  };

  return {
    getConfig: () => defaultConfig,
    getCurrentStatus: () => ({
      rssBytes: 500 * 1024 * 1024,
      rssMB: 500,
      pressureLevel: 'normal' as MemoryPressureLevel,
      limitMB: 1024,
      usageRatio: 0.5,
    }),
    getPressureLevel: () => 'normal' as MemoryPressureLevel,
    getRssMB: () => 500,
    startMonitoring: () => {},
    stopMonitoring: () => ({
      peakRssMB: 500,
      avgRssMBByStage: {},
      gcTriggerCount: 0,
      skippedVideos: [],
    }),
    checkBetweenStages: async () => {},
    getFrameSampleCount: (d: number) => d,
    getMaxConcurrency: (d: number) => d,
    shouldPauseTasks: () => false,
    waitForRecovery: async () => true,
    recordSkippedVideo: () => {},
    notifyTaskCompleted: () => {},
    ...overrides,
  };
}

function createMockStreamProcessor(overrides?: Partial<StreamProcessor>): StreamProcessor {
  return {
    transferToStorage: vi.fn(async (tempFilePath: string, storagePath: string) => {
      // Simulate successful transfer and delete temp file
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // File may not exist in test
      }
      return {
        success: true,
        bytesTransferred: 1024,
        durationMs: 100,
      } as StreamTransferResult;
    }),
    verifyCleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

// Standard test segments (source duration = 120s, enough for highlight and summary)
const testSegments: VideoSegment[] = [
  makeSegment({ index: 0, startTime: 0, endTime: 15, duration: 15, overallScore: 90 }),
  makeSegment({ index: 1, startTime: 15, endTime: 30, duration: 15, overallScore: 85 }),
  makeSegment({ index: 2, startTime: 30, endTime: 50, duration: 20, overallScore: 80 }),
  makeSegment({ index: 3, startTime: 50, endTime: 70, duration: 20, overallScore: 75 }),
  makeSegment({ index: 4, startTime: 70, endTime: 90, duration: 20, overallScore: 70 }),
  makeSegment({ index: 5, startTime: 90, endTime: 120, duration: 30, overallScore: 65 }),
];

const testProfiles: VersionProfile[] = [
  { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
  { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
  { name: 'extended', targetDuration: 300, selectionStrategy: 'comprehensive' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiVersionGenerator Memory Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Serial generation (Requirement 10.1)', () => {
    it('generates versions in serial order (highlight → summary → extended)', async () => {
      const generationOrder: string[] = [];
      const mockStreamProcessor = createMockStreamProcessor({
        transferToStorage: vi.fn(async (tempFilePath: string, storagePath: string) => {
          // Track which profile is being stored
          const match = storagePath.match(/media-1_(\w+)\.mp4/);
          if (match) {
            generationOrder.push(match[1]);
          }
          try { fs.unlinkSync(tempFilePath); } catch {}
          return { success: true, bytesTransferred: 1024, durationMs: 100 };
        }),
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-1',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: mockStreamProcessor,
        },
      );

      // Verify serial order
      expect(generationOrder).toEqual(['highlight', 'summary']);
    });
  });

  describe('Memory pressure check before each version (Requirement 10.3)', () => {
    it('checks memory pressure level before each version generation', async () => {
      const getPressureLevelCalls: number[] = [];
      let callCount = 0;

      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => {
          callCount++;
          getPressureLevelCalls.push(callCount);
          return 'normal';
        },
      });

      await generateVersions(
        '/fake/video.mp4',
        'media-pressure-check',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // getPressureLevel should be called at least once per profile
      expect(getPressureLevelCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Critical pressure wait and timeout (Requirements 10.4, 10.5)', () => {
    it('waits for recovery when pressure is critical and recovers', async () => {
      let waitForRecoveryCalled = false;

      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => 'critical',
        waitForRecovery: async (timeoutMs: number) => {
          waitForRecoveryCalled = true;
          expect(timeoutMs).toBe(60000);
          return true; // Recovered
        },
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-critical-recover',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      expect(waitForRecoveryCalled).toBe(true);
      // Should proceed with generation after recovery
      const highlightVersion = result.versions.find(v => v.profile.name === 'highlight');
      expect(highlightVersion?.status).toBe('ready');
    });

    it('skips version with memory_pressure_timeout when recovery fails', async () => {
      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => 'critical',
        waitForRecovery: async (timeoutMs: number) => {
          expect(timeoutMs).toBe(60000);
          return false; // Timeout - did not recover
        },
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-critical-timeout',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // Both versions should be skipped due to memory pressure timeout
      expect(result.versions.length).toBe(2);
      expect(result.versions[0].status).toBe('skipped');
      expect(result.versions[0].skipReason).toBe('memory_pressure_timeout');
      expect(result.versions[1].status).toBe('skipped');
      expect(result.versions[1].skipReason).toBe('memory_pressure_timeout');
    });

    it('skips only the version where pressure is critical, continues with next', async () => {
      let callIndex = 0;

      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => {
          callIndex++;
          // First version: critical (will timeout)
          // Second version: normal
          return callIndex === 1 ? 'critical' : 'normal';
        },
        waitForRecovery: async () => {
          return false; // Timeout for first version
        },
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-partial-skip',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // First version skipped, second version should proceed
      expect(result.versions[0].status).toBe('skipped');
      expect(result.versions[0].skipReason).toBe('memory_pressure_timeout');
      expect(result.versions[1].status).toBe('ready');
    });
  });

  describe('StreamProcessor integration (Requirement 10.2)', () => {
    it('uses StreamProcessor.transferToStorage instead of fs.readFileSync', async () => {
      const transferCalls: Array<{ tempFilePath: string; storagePath: string }> = [];

      const mockStreamProcessor = createMockStreamProcessor({
        transferToStorage: vi.fn(async (tempFilePath: string, storagePath: string) => {
          transferCalls.push({ tempFilePath, storagePath });
          try { fs.unlinkSync(tempFilePath); } catch {}
          return { success: true, bytesTransferred: 1024, durationMs: 100 };
        }),
      });

      await generateVersions(
        '/fake/video.mp4',
        'media-stream',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: mockStreamProcessor,
        },
      );

      // StreamProcessor should have been called
      expect(transferCalls.length).toBe(1);
      expect(transferCalls[0].storagePath).toBe('trip-1/versions/media-stream_highlight.mp4');
      // The temp file path should contain the profile name
      expect(transferCalls[0].tempFilePath).toContain('highlight_output.mp4');
    });

    it('does not call storage.save directly (no buffer loading)', async () => {
      await generateVersions(
        '/fake/video.mp4',
        'media-no-buffer',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // storage.save should NOT be called directly
      expect(mockStorage.save).not.toHaveBeenCalled();
    });
  });

  describe('Segment file reuse (Requirement 10.7)', () => {
    it('extracts each segment only once across multiple versions', async () => {
      const extractedPaths = new Set<string>();

      // We'll track ffmpeg calls by monitoring file creation in the shared segments dir
      // Since ffmpeg is mocked, we can check that the same segment index file is not created twice
      const originalWriteFileSync = fs.writeFileSync;
      const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync');

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-reuse',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // Check that shared segment files were created (seg_X.mp4 pattern)
      const segmentFileWrites = writeFileSyncSpy.mock.calls
        .map(call => call[0] as string)
        .filter(p => p.includes('shared_segments_') && p.includes('seg_'));

      // Each segment index should appear at most once in the shared dir
      const segmentIndices = segmentFileWrites.map(p => {
        const match = p.match(/seg_(\d+)\.mp4/);
        return match ? match[1] : null;
      }).filter(Boolean);

      const uniqueIndices = new Set(segmentIndices);
      // Each index should only be extracted once (no duplicates)
      expect(segmentIndices.length).toBe(uniqueIndices.size);

      writeFileSyncSpy.mockRestore();
    });
  });

  describe('Shared segment cleanup (Requirement 10.8)', () => {
    it('cleans up shared segment directory after all versions complete', async () => {
      const rmSyncSpy = vi.spyOn(fs, 'rmSync');

      await generateVersions(
        '/fake/video.mp4',
        'media-cleanup',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // Verify rmSync was called with the shared segments directory
      const sharedDirCleanups = rmSyncSpy.mock.calls.filter(
        call => (call[0] as string).includes('shared_segments_media-cleanup'),
      );
      expect(sharedDirCleanups.length).toBeGreaterThanOrEqual(1);

      rmSyncSpy.mockRestore();
    });

    it('cleans up shared segments even when all versions fail', async () => {
      const rmSyncSpy = vi.spyOn(fs, 'rmSync');

      // Use a memory manager that always times out
      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => 'critical',
        waitForRecovery: async () => false,
      });

      await generateVersions(
        '/fake/video.mp4',
        'media-cleanup-fail',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // Shared dir should still be cleaned up
      const sharedDirCleanups = rmSyncSpy.mock.calls.filter(
        call => (call[0] as string).includes('shared_segments_media-cleanup-fail'),
      );
      expect(sharedDirCleanups.length).toBeGreaterThanOrEqual(1);

      rmSyncSpy.mockRestore();
    });
  });

  describe('Version failure cleanup and continuation (Requirement 10.6)', () => {
    it('continues to next version when current version fails', async () => {
      let transferCallCount = 0;

      const mockStreamProcessor = createMockStreamProcessor({
        transferToStorage: vi.fn(async (tempFilePath: string, storagePath: string) => {
          transferCallCount++;
          if (transferCallCount === 1) {
            // First version transfer fails
            throw new Error('Storage write failed');
          }
          try { fs.unlinkSync(tempFilePath); } catch {}
          return { success: true, bytesTransferred: 1024, durationMs: 100 };
        }),
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-fail-continue',
        'trip-1',
        testSegments,
        [
          { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
          { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
        ],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: mockStreamProcessor,
        },
      );

      // First version should have an error
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].profile).toBe('highlight');
      expect(result.errors[0].error).toContain('Storage write failed');

      // Second version should succeed
      const summaryVersion = result.versions.find(v => v.profile.name === 'summary');
      expect(summaryVersion?.status).toBe('ready');
    });

    it('cleans up version temp dir even when version fails', async () => {
      const rmSyncSpy = vi.spyOn(fs, 'rmSync');

      const mockStreamProcessor = createMockStreamProcessor({
        transferToStorage: vi.fn(async () => {
          throw new Error('Transfer failed');
        }),
      });

      await generateVersions(
        '/fake/video.mp4',
        'media-cleanup-on-fail',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: createMockMemoryManager(),
          streamProcessor: mockStreamProcessor,
        },
      );

      // Version temp dir should be cleaned up
      const versionDirCleanups = rmSyncSpy.mock.calls.filter(
        call => (call[0] as string).includes('version_media-cleanup-on-fail_highlight'),
      );
      expect(versionDirCleanups.length).toBeGreaterThanOrEqual(1);

      rmSyncSpy.mockRestore();
    });
  });

  describe('Warning pressure does not trigger wait (Requirement 10.3)', () => {
    it('proceeds normally when pressure is warning (not critical)', async () => {
      const waitForRecoveryCalled = vi.fn();

      const mockMemoryManager = createMockMemoryManager({
        getPressureLevel: () => 'warning',
        waitForRecovery: async () => {
          waitForRecoveryCalled();
          return true;
        },
      });

      const result = await generateVersions(
        '/fake/video.mp4',
        'media-warning',
        'trip-1',
        testSegments,
        [{ name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }],
        {
          memoryManager: mockMemoryManager,
          streamProcessor: createMockStreamProcessor(),
        },
      );

      // waitForRecovery should NOT be called for warning level
      expect(waitForRecoveryCalled).not.toHaveBeenCalled();
      // Version should be generated normally
      expect(result.versions[0].status).toBe('ready');
    });
  });
});
