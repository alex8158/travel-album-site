import { Response } from 'express';

export type StepName = 'dedup' | 'quality' | 'thumbnail' | 'cover';

const STEPS: StepName[] = ['dedup', 'quality', 'thumbnail', 'cover'];
const TOTAL_STEPS = 4;

export interface ProgressEvent {
  step: StepName;
  stepIndex: number;
  totalSteps: number;
  percent: number;
}

export interface CompleteEvent {
  tripId: string;
  totalImages: number;
  duplicateGroups: { groupId: string; imageCount: number }[];
  totalGroups: number;
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

  sendStepStart(step: StepName): void {
    const stepIndex = STEPS.indexOf(step) + 1;
    const percent = (stepIndex - 1) * 25;
    const data: ProgressEvent = { step, stepIndex, totalSteps: TOTAL_STEPS, percent };
    this.writeSSE('progress', data);
  }

  sendStepComplete(step: StepName): void {
    const stepIndex = STEPS.indexOf(step) + 1;
    const percent = stepIndex * 25;
    const data: ProgressEvent = { step, stepIndex, totalSteps: TOTAL_STEPS, percent };
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
