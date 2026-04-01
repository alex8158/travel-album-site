import { Response } from 'express';

export type StepName = 'dedup' | 'quality' | 'blurDetect' | 'trashDuplicates' | 'imageOptimize' | 'thumbnail' | 'videoAnalysis' | 'videoEdit' | 'cover';

const STEPS: StepName[] = ['dedup', 'quality', 'blurDetect', 'trashDuplicates', 'imageOptimize', 'thumbnail', 'videoAnalysis', 'videoEdit', 'cover'];
const TOTAL_STEPS = 9;

export interface ProgressEvent {
  step: StepName;
  stepIndex: number;
  totalSteps: number;
  percent: number;
  processed?: number;
  total?: number;
}

export interface CompleteEvent {
  tripId: string;
  totalImages: number;
  totalVideos: number;
  duplicateGroups: { groupId: string; imageCount: number }[];
  totalGroups: number;
  blurryCount?: number;
  trashedDuplicateCount?: number;
  optimizedCount?: number;
  compiledCount?: number;
  failedCount?: number;
  coverImageId: string | null;
}

export interface ErrorEvent {
  message: string;
  step?: string;
}

export class ProgressReporter {
  private res: Response;

  constructor(res: Response) {
    this.res = res;
  }

  initSSE(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.flushHeaders();
  }

  sendStepStart(step: StepName, counts?: { processed?: number; total?: number }): void {
    const stepIndex = STEPS.indexOf(step) + 1;
    const percent = Math.round(((stepIndex - 1) / TOTAL_STEPS) * 100);
    const data: ProgressEvent = { step, stepIndex, totalSteps: TOTAL_STEPS, percent };
    if (counts?.processed !== undefined) data.processed = counts.processed;
    if (counts?.total !== undefined) data.total = counts.total;
    this.writeSSE('progress', data);
  }

  sendStepComplete(step: StepName, counts?: { processed?: number; total?: number }): void {
    const stepIndex = STEPS.indexOf(step) + 1;
    const percent = Math.round((stepIndex / TOTAL_STEPS) * 100);
    const data: ProgressEvent = { step, stepIndex, totalSteps: TOTAL_STEPS, percent };
    if (counts?.processed !== undefined) data.processed = counts.processed;
    if (counts?.total !== undefined) data.total = counts.total;
    this.writeSSE('progress', data);
  }

  sendComplete(result: CompleteEvent): void {
    this.writeSSE('complete', result);
    this.res.end();
  }

  sendError(error: ErrorEvent): void {
    this.writeSSE('error', error);
    this.res.end();
  }

  private writeSSE(eventType: string, data: unknown): void {
    this.res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
