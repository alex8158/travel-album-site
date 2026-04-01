import { describe, it, expect, vi } from 'vitest';
import { ProgressReporter, StepName } from './progressReporter';
import type { Response } from 'express';

function createMockResponse() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((key: string, value: string) => { headers[key] = value; }),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); }),
    end: vi.fn(),
    _chunks: chunks,
    _headers: headers,
  };
  return res as unknown as Response & { _chunks: string[]; _headers: Record<string, string> };
}

describe('ProgressReporter', () => {
  describe('initSSE', () => {
    it('should set correct SSE response headers', () => {
      const res = createMockResponse();
      const reporter = new ProgressReporter(res);

      reporter.initSSE();

      expect(res._headers['Content-Type']).toBe('text/event-stream');
      expect(res._headers['Cache-Control']).toBe('no-cache');
      expect(res._headers['Connection']).toBe('keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
    });
  });

  describe('sendStepStart', () => {
    it('should send progress event with correct percent for each step', () => {
      const steps: StepName[] = ['dedup', 'quality', 'blurDetect', 'trashDuplicates', 'imageOptimize', 'thumbnail', 'videoAnalysis', 'videoEdit', 'cover'];
      const expectedPercents = [0, 11, 22, 33, 44, 56, 67, 78, 89];

      steps.forEach((step, i) => {
        const res = createMockResponse();
        const reporter = new ProgressReporter(res);

        reporter.sendStepStart(step);

        const written = res._chunks[0];
        const data = JSON.parse(written.split('data: ')[1].split('\n')[0]);
        expect(data.step).toBe(step);
        expect(data.stepIndex).toBe(i + 1);
        expect(data.totalSteps).toBe(9);
        expect(data.percent).toBe(expectedPercents[i]);
      });
    });
  });

  describe('sendStepComplete', () => {
    it('should send progress event with correct percent for each step', () => {
      const steps: StepName[] = ['dedup', 'quality', 'blurDetect', 'trashDuplicates', 'imageOptimize', 'thumbnail', 'videoAnalysis', 'videoEdit', 'cover'];
      const expectedPercents = [11, 22, 33, 44, 56, 67, 78, 89, 100];

      steps.forEach((step, i) => {
        const res = createMockResponse();
        const reporter = new ProgressReporter(res);

        reporter.sendStepComplete(step);

        const written = res._chunks[0];
        const data = JSON.parse(written.split('data: ')[1].split('\n')[0]);
        expect(data.step).toBe(step);
        expect(data.stepIndex).toBe(i + 1);
        expect(data.totalSteps).toBe(9);
        expect(data.percent).toBe(expectedPercents[i]);
      });
    });
  });

  describe('sendComplete', () => {
    it('should send complete event and close connection', () => {
      const res = createMockResponse();
      const reporter = new ProgressReporter(res);
      const result = {
        tripId: 'trip-1',
        totalImages: 10,
        duplicateGroups: [{ groupId: 'g1', imageCount: 3 }],
        totalGroups: 1,
        coverImageId: 'img-1',
      };

      reporter.sendComplete(result);

      const written = res._chunks[0];
      expect(written).toContain('event: complete');
      const data = JSON.parse(written.split('data: ')[1].split('\n')[0]);
      expect(data.tripId).toBe('trip-1');
      expect(data.totalImages).toBe(10);
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('sendError', () => {
    it('should send error event with message and step, then close connection', () => {
      const res = createMockResponse();
      const reporter = new ProgressReporter(res);

      reporter.sendError({ message: '去重处理失败', step: 'dedup' });

      const written = res._chunks[0];
      expect(written).toContain('event: error');
      const data = JSON.parse(written.split('data: ')[1].split('\n')[0]);
      expect(data.message).toBe('去重处理失败');
      expect(data.step).toBe('dedup');
      expect(res.end).toHaveBeenCalled();
    });

    it('should send error event without step field', () => {
      const res = createMockResponse();
      const reporter = new ProgressReporter(res);

      reporter.sendError({ message: '未知错误' });

      const written = res._chunks[0];
      const data = JSON.parse(written.split('data: ')[1].split('\n')[0]);
      expect(data.message).toBe('未知错误');
      expect(data.step).toBeUndefined();
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('SSE format', () => {
    it('should output events in correct SSE format: event: {type}\\ndata: {json}\\n\\n', () => {
      const res = createMockResponse();
      const reporter = new ProgressReporter(res);

      reporter.sendStepStart('dedup');

      const written = res._chunks[0];
      const lines = written.split('\n');
      expect(lines[0]).toMatch(/^event: progress$/);
      expect(lines[1]).toMatch(/^data: \{.*\}$/);
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe('');
    });
  });
});
