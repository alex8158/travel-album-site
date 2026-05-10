import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AIEnhancementService, EnhancementParams } from './aiEnhancementService';

// --- Mocks for integration tests (analyzeForEnhancement, enhanceMedia) ---

let mockDb: Database.Database | null = null;

vi.mock('../database', () => {
  return {
    getDb: () => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        mockDb.exec(`
          CREATE TABLE media_items (
            id TEXT PRIMARY KEY,
            trip_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            media_type TEXT NOT NULL DEFAULT 'image',
            mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
            original_filename TEXT NOT NULL DEFAULT 'photo.jpg',
            file_size INTEGER NOT NULL DEFAULT 1000,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT '2024-01-01'
          );
          CREATE TABLE media_versions (
            id TEXT PRIMARY KEY,
            media_id TEXT NOT NULL,
            version_type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            model_name TEXT,
            params TEXT,
            status TEXT DEFAULT 'ready',
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_media_versions_media_id ON media_versions(media_id);
          CREATE TABLE media_analysis (
            id TEXT PRIMARY KEY,
            media_id TEXT NOT NULL,
            quality_score REAL,
            color_score REAL,
            reason TEXT,
            created_at TEXT NOT NULL
          );
          CREATE TABLE ai_invocations (
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
        `);
      }
      return mockDb;
    },
  };
});

const mockDownloadToTemp = vi.fn();
const mockSave = vi.fn();

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    downloadToTemp: mockDownloadToTemp,
    save: mockSave,
  }),
}));

const mockInvokeImageAnalysis = vi.fn();
const mockGetDefault = vi.fn();

vi.mock('./ai', () => ({
  getAIProviderRegistry: () => ({
    invokeImageAnalysis: mockInvokeImageAnalysis,
    getDefault: mockGetDefault,
  }),
}));

const mockResizeForAnalysis = vi.fn();

vi.mock('./bedrockClient', () => ({
  resizeForAnalysis: (...args: any[]) => mockResizeForAnalysis(...args),
}));

describe('AIEnhancementService', () => {
  const service = new AIEnhancementService();

  describe('parseAIResponse', () => {
    const validJson = JSON.stringify({
      brightness: 1.2,
      contrast: 1.1,
      saturation: 1.0,
      sharpenSigma: 1.5,
      noiseReduction: 3,
      colorCorrection: { r: 5, g: -3, b: -2 },
    });

    it('should parse plain JSON text', () => {
      const result = service.parseAIResponse(validJson);
      expect(result).not.toBeNull();
      expect(result!.brightness).toBe(1.2);
      expect(result!.contrast).toBe(1.1);
      expect(result!.saturation).toBe(1.0);
      expect(result!.sharpenSigma).toBe(1.5);
      expect(result!.noiseReduction).toBe(3);
      expect(result!.colorCorrection).toEqual({ r: 5, g: -3, b: -2 });
    });

    it('should parse JSON from markdown code block with json tag', () => {
      const response = `Here are the recommended parameters:\n\n\`\`\`json\n${validJson}\n\`\`\`\n\nThese should improve the image.`;
      const result = service.parseAIResponse(response);
      expect(result).not.toBeNull();
      expect(result!.brightness).toBe(1.2);
      expect(result!.contrast).toBe(1.1);
    });

    it('should parse JSON from markdown code block without json tag', () => {
      const response = `\`\`\`\n${validJson}\n\`\`\``;
      const result = service.parseAIResponse(response);
      expect(result).not.toBeNull();
      expect(result!.brightness).toBe(1.2);
    });

    it('should parse JSON object embedded in text', () => {
      const response = `Based on my analysis, I recommend: ${validJson} for this image.`;
      const result = service.parseAIResponse(response);
      expect(result).not.toBeNull();
      expect(result!.brightness).toBe(1.2);
    });

    it('should return null for empty string', () => {
      expect(service.parseAIResponse('')).toBeNull();
    });

    it('should return null for non-JSON text', () => {
      expect(service.parseAIResponse('This is just a text response with no JSON.')).toBeNull();
    });

    it('should return null when required fields are missing', () => {
      const incomplete = JSON.stringify({ brightness: 1.0, contrast: 1.0 });
      expect(service.parseAIResponse(incomplete)).toBeNull();
    });

    it('should return null when fields are not numbers', () => {
      const invalid = JSON.stringify({
        brightness: 'high',
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 1.0,
        noiseReduction: 3,
      });
      expect(service.parseAIResponse(invalid)).toBeNull();
    });

    it('should clamp out-of-bounds values', () => {
      const outOfBounds = JSON.stringify({
        brightness: 5.0,
        contrast: 0.1,
        saturation: 3.0,
        sharpenSigma: 10.0,
        noiseReduction: 8,
      });
      const result = service.parseAIResponse(outOfBounds);
      expect(result).not.toBeNull();
      expect(result!.brightness).toBe(2.0);
      expect(result!.contrast).toBe(0.5);
      expect(result!.saturation).toBe(2.0);
      expect(result!.sharpenSigma).toBe(3.0);
      expect(result!.noiseReduction).toBe(5);
    });

    it('should omit colorCorrection if not valid', () => {
      const noCC = JSON.stringify({
        brightness: 1.0,
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 1.0,
        noiseReduction: 3,
      });
      const result = service.parseAIResponse(noCC);
      expect(result).not.toBeNull();
      expect(result!.colorCorrection).toBeUndefined();
    });

    it('should return null for NaN or Infinity values', () => {
      // NaN can't be in JSON, but Infinity-like strings won't parse as valid numbers
      const withNull = JSON.stringify({
        brightness: null,
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 1.0,
        noiseReduction: 3,
      });
      expect(service.parseAIResponse(withNull)).toBeNull();
    });
  });

  describe('validateAndClampParams', () => {
    it('should pass through values already within bounds', () => {
      const params: EnhancementParams = {
        brightness: 1.0,
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 1.5,
        noiseReduction: 3,
        colorCorrection: { r: 0.1, g: -0.1, b: 0.0 },
      };
      const result = service.validateAndClampParams(params);
      expect(result.brightness).toBe(1.0);
      expect(result.contrast).toBe(1.0);
      expect(result.saturation).toBe(1.0);
      expect(result.sharpenSigma).toBe(1.5);
      expect(result.noiseReduction).toBe(3);
      expect(result.colorCorrection).toEqual({ r: 0.1, g: -0.1, b: 0.0 });
    });

    it('should clamp brightness (gamma) to [0.5, 2.0]', () => {
      const low = service.validateAndClampParams({ brightness: 0.1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 1 });
      expect(low.brightness).toBe(0.5);

      const high = service.validateAndClampParams({ brightness: 5.0, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 1 });
      expect(high.brightness).toBe(2.0);
    });

    it('should clamp contrast to [0.5, 2.0]', () => {
      const low = service.validateAndClampParams({ brightness: 1, contrast: 0.1, saturation: 1, sharpenSigma: 1, noiseReduction: 1 });
      expect(low.contrast).toBe(0.5);

      const high = service.validateAndClampParams({ brightness: 1, contrast: 10, saturation: 1, sharpenSigma: 1, noiseReduction: 1 });
      expect(high.contrast).toBe(2.0);
    });

    it('should clamp saturation to [0.5, 2.0]', () => {
      const low = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: -1, sharpenSigma: 1, noiseReduction: 1 });
      expect(low.saturation).toBe(0.5);

      const high = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 99, sharpenSigma: 1, noiseReduction: 1 });
      expect(high.saturation).toBe(2.0);
    });

    it('should clamp sharpenSigma to [0, 3.0]', () => {
      const low = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: -2, noiseReduction: 1 });
      expect(low.sharpenSigma).toBe(0);

      const high = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 10, noiseReduction: 1 });
      expect(high.sharpenSigma).toBe(3.0);
    });

    it('should clamp noiseReduction to [0, 5] and ensure odd', () => {
      // Value 0 is acceptable (no filtering)
      const zero = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 0 });
      expect(zero.noiseReduction).toBe(0);

      // Value 1 is odd, stays as 1
      const one = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 1 });
      expect(one.noiseReduction).toBe(1);

      // Value 3 is odd, stays as 3
      const three = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 3 });
      expect(three.noiseReduction).toBe(3);

      // Value 5 is odd, stays as 5
      const five = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 5 });
      expect(five.noiseReduction).toBe(5);

      // Value 2 is even, should round to nearest odd (1 or 3)
      const two = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 2 });
      expect(two.noiseReduction).toBe(1);

      // Value 4 is even, should round to nearest odd (3 or 5)
      const four = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 4 });
      expect(four.noiseReduction).toBe(3);
    });

    it('should clamp noiseReduction below 0 to 0', () => {
      const result = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: -5 });
      expect(result.noiseReduction).toBe(0);
    });

    it('should clamp noiseReduction above 5 to 5', () => {
      const result = service.validateAndClampParams({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 10 });
      expect(result.noiseReduction).toBe(5);
    });

    it('should preserve colorCorrection as-is', () => {
      const params: EnhancementParams = {
        brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 1,
        colorCorrection: { r: 100, g: -50, b: 0 },
      };
      const result = service.validateAndClampParams(params);
      expect(result.colorCorrection).toEqual({ r: 100, g: -50, b: 0 });
    });

    it('should handle undefined colorCorrection', () => {
      const params: EnhancementParams = {
        brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 1, noiseReduction: 1,
      };
      const result = service.validateAndClampParams(params);
      expect(result.colorCorrection).toBeUndefined();
    });
  });

  describe('analyzeForEnhancement (fallback logic)', () => {
    let db: Database.Database;

    beforeEach(async () => {
      const { getDb } = await import('../database');
      db = getDb();
      // Insert a test media item
      db.prepare(
        "INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('media-1', 'trip-1', 'trip-1/photo.jpg', 'image', 'image/jpeg', 'photo.jpg', 5000, 'active', '2024-01-01');

      mockDownloadToTemp.mockResolvedValue('/tmp/photo.jpg');
      mockResizeForAnalysis.mockResolvedValue('base64data');
      mockGetDefault.mockReturnValue({ metadata: { model: 'test-model' } });
    });

    afterEach(() => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
      vi.clearAllMocks();
    });

    it('should return AI-parsed params when AI response is valid', async () => {
      const validResponse = JSON.stringify({
        brightness: 1.3,
        contrast: 1.1,
        saturation: 1.2,
        sharpenSigma: 1.0,
        noiseReduction: 3,
      });
      mockInvokeImageAnalysis.mockResolvedValue({
        text: validResponse,
        inputTokens: 100,
        outputTokens: 50,
        elapsedMs: 800,
      });

      const result = await service.analyzeForEnhancement('media-1');
      expect(result.brightness).toBe(1.3);
      expect(result.contrast).toBe(1.1);
      expect(result.saturation).toBe(1.2);
      expect(result.sharpenSigma).toBe(1.0);
      expect(result.noiseReduction).toBe(3);
    });

    it('should fall back to conservative defaults when AI response cannot be parsed', async () => {
      mockInvokeImageAnalysis.mockResolvedValue({
        text: 'I cannot analyze this image properly.',
        inputTokens: 100,
        outputTokens: 20,
        elapsedMs: 500,
      });

      const result = await service.analyzeForEnhancement('media-1');
      // Conservative defaults
      expect(result.brightness).toBe(1.0);
      expect(result.contrast).toBe(1.0);
      expect(result.saturation).toBe(1.0);
      expect(result.sharpenSigma).toBe(0.25);
      expect(result.noiseReduction).toBe(0);
    });

    it('should fall back to conservative defaults when AI call throws an error', async () => {
      mockInvokeImageAnalysis.mockRejectedValue(new Error('Provider timeout'));

      const result = await service.analyzeForEnhancement('media-1');
      // Conservative defaults
      expect(result.brightness).toBe(1.0);
      expect(result.contrast).toBe(1.0);
      expect(result.saturation).toBe(1.0);
      expect(result.sharpenSigma).toBe(0.25);
      expect(result.noiseReduction).toBe(0);
    });

    it('should throw when media item does not exist', async () => {
      await expect(service.analyzeForEnhancement('nonexistent-id')).rejects.toThrow(
        'Media item not found: nonexistent-id'
      );
    });
  });

  describe('enhanceMedia (concurrency control)', () => {
    let db: Database.Database;

    beforeEach(async () => {
      const { getDb } = await import('../database');
      db = getDb();
      // Insert test media items
      db.prepare(
        "INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('img-1', 'trip-1', 'trip-1/img1.jpg', 'image', 'image/jpeg', 'img1.jpg', 5000, 'active', '2024-01-01');
      db.prepare(
        "INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('vid-1', 'trip-1', 'trip-1/vid1.mp4', 'video', 'video/mp4', 'vid1.mp4', 50000, 'active', '2024-01-01');

      mockDownloadToTemp.mockResolvedValue('/tmp/img1.jpg');
      mockSave.mockResolvedValue(undefined);
      mockResizeForAnalysis.mockResolvedValue('base64data');
      mockGetDefault.mockReturnValue({ metadata: { model: 'test-model' } });
    });

    afterEach(() => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
      vi.clearAllMocks();
    });

    it('should throw ENHANCEMENT_IN_PROGRESS when same mediaId is already being enhanced', async () => {
      // Make the AI call hang so the first call stays in progress
      let resolveFirst: (value: any) => void;
      const hangingPromise = new Promise((resolve) => { resolveFirst = resolve; });
      mockInvokeImageAnalysis.mockReturnValueOnce(hangingPromise);

      // Start first enhancement (will hang)
      const firstCall = service.enhanceMedia('img-1');

      // Second call should fail immediately with ENHANCEMENT_IN_PROGRESS
      await expect(service.enhanceMedia('img-1')).rejects.toThrow('ENHANCEMENT_IN_PROGRESS');

      // Clean up: resolve the hanging promise so the first call can finish
      resolveFirst!({
        text: JSON.stringify({ brightness: 1, contrast: 1, saturation: 1, sharpenSigma: 0, noiseReduction: 0 }),
        inputTokens: 10,
        outputTokens: 10,
        elapsedMs: 100,
      });
      // Let the first call finish (it may throw due to sharp mock, that's fine)
      try { await firstCall; } catch { /* expected — sharp not mocked */ }
    });

    it('should throw MEDIA_NOT_FOUND when media item does not exist', async () => {
      await expect(service.enhanceMedia('nonexistent-id')).rejects.toThrow('MEDIA_NOT_FOUND');
    });

    it('should throw INVALID_MEDIA_TYPE when media item is not an image', async () => {
      await expect(service.enhanceMedia('vid-1')).rejects.toThrow('INVALID_MEDIA_TYPE');
    });

    it('should release lock after successful enhancement', async () => {
      const validResponse = JSON.stringify({
        brightness: 1.0,
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 0,
        noiseReduction: 0,
      });
      mockInvokeImageAnalysis.mockResolvedValue({
        text: validResponse,
        inputTokens: 10,
        outputTokens: 10,
        elapsedMs: 100,
      });

      // Mock sharp processing by mocking applyEnhancement
      const applyMock = vi.spyOn(service, 'applyEnhancement').mockResolvedValue('trip-1/enhanced/img-1_enhanced.jpg');

      await service.enhanceMedia('img-1');

      // Lock should be released — calling again should NOT throw ENHANCEMENT_IN_PROGRESS
      // (it should proceed to the workflow again)
      applyMock.mockResolvedValue('trip-1/enhanced/img-1_enhanced.jpg');
      mockInvokeImageAnalysis.mockResolvedValue({
        text: validResponse,
        inputTokens: 10,
        outputTokens: 10,
        elapsedMs: 100,
      });

      // Should not throw ENHANCEMENT_IN_PROGRESS
      const result = await service.enhanceMedia('img-1');
      expect(result.mediaId).toBe('img-1');

      applyMock.mockRestore();
    });

    it('should release lock after failed enhancement', async () => {
      // Make the AI call fail
      mockInvokeImageAnalysis.mockRejectedValue(new Error('Provider error'));
      // analyzeForEnhancement catches AI errors and falls back, so we need applyEnhancement to fail
      const applyMock = vi.spyOn(service, 'applyEnhancement').mockRejectedValue(new Error('Sharp processing failed'));

      await expect(service.enhanceMedia('img-1')).rejects.toThrow('Sharp processing failed');

      // Lock should be released — calling again should NOT throw ENHANCEMENT_IN_PROGRESS
      const validResponse = JSON.stringify({
        brightness: 1.0,
        contrast: 1.0,
        saturation: 1.0,
        sharpenSigma: 0,
        noiseReduction: 0,
      });
      mockInvokeImageAnalysis.mockResolvedValue({
        text: validResponse,
        inputTokens: 10,
        outputTokens: 10,
        elapsedMs: 100,
      });
      applyMock.mockResolvedValue('trip-1/enhanced/img-1_enhanced.jpg');

      const result = await service.enhanceMedia('img-1');
      expect(result.mediaId).toBe('img-1');

      applyMock.mockRestore();
    });
  });
});
