import { getDb } from '../database';
import type { PipelineStage, PipelineProgressCallback } from './pipeline/types';

// Map PipelineStage to human-readable Chinese step names
const STEP_LABELS: Partial<Record<PipelineStage, string>> = {
  collectInputs: '收集图片',
  classify: '分类',
  blur: '模糊检测',
  dedup: '去重',
  reduce: '汇总决策',
  write: '写入数据库',
  analyze: '分析',
  optimize: '优化',
  thumbnail: '生成缩略图',
  videoAnalysis: '视频分析',
  videoEdit: '视频编辑',
  cover: '选择封面',
};

const TOTAL_STEPS = Object.keys(STEP_LABELS).length;

export class JobProgressReporter {
  private jobId: string;
  private nextSeq: number = 1;

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  markRunning(): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE processing_jobs SET status = 'running', started_at = ? WHERE id = ?`
    ).run(now, this.jobId);
  }

  onStepBegin(step: string, totalSteps: number, stepIndex: number): void {
    const db = getDb();
    const now = new Date().toISOString();
    const label = STEP_LABELS[step as PipelineStage] ?? step;
    const percent = Math.round(((stepIndex - 1) / totalSteps) * 100);

    // Insert event
    db.prepare(
      `INSERT INTO processing_job_events (job_id, seq, level, step, message, created_at)
       VALUES (?, ?, 'info', ?, ?, ?)`
    ).run(this.jobId, this.nextSeq++, step, `开始${label}`, now);

    // Update job: current_step, percent, reset processed/total for new step
    db.prepare(
      `UPDATE processing_jobs SET current_step = ?, percent = ?, processed = 0, total = 0 WHERE id = ?`
    ).run(step, percent, this.jobId);
  }

  onStepComplete(step: string, totalSteps: number, stepIndex: number): void {
    const db = getDb();
    const now = new Date().toISOString();
    const label = STEP_LABELS[step as PipelineStage] ?? step;
    const percent = Math.round((stepIndex / totalSteps) * 100);

    // Insert completion event
    db.prepare(
      `INSERT INTO processing_job_events (job_id, seq, level, step, message, created_at)
       VALUES (?, ?, 'info', ?, ?, ?)`
    ).run(this.jobId, this.nextSeq++, step, `${label}完成`, now);

    // Update percent
    db.prepare(
      `UPDATE processing_jobs SET percent = ? WHERE id = ?`
    ).run(percent, this.jobId);
  }

  onItemProgress(processed: number, total: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE processing_jobs SET processed = ?, total = ? WHERE id = ?`
    ).run(processed, total, this.jobId);
  }

  markCompleted(resultJson: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO processing_job_events (job_id, seq, level, step, message, created_at)
       VALUES (?, ?, 'info', NULL, '处理完成', ?)`
    ).run(this.jobId, this.nextSeq++, now);

    db.prepare(
      `UPDATE processing_jobs SET status = 'completed', percent = 100, result_json = ?, finished_at = ? WHERE id = ?`
    ).run(resultJson, now, this.jobId);
  }

  markFailed(errorMessage: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO processing_job_events (job_id, seq, level, step, message, created_at)
       VALUES (?, ?, 'error', NULL, ?, ?)`
    ).run(this.jobId, this.nextSeq++, errorMessage, now);

    db.prepare(
      `UPDATE processing_jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`
    ).run(errorMessage, now, this.jobId);
  }

  /**
   * Returns a PipelineProgressCallback that maps pipeline stage events
   * to job progress database writes.
   */
  toPipelineCallback(): PipelineProgressCallback {
    let stepIndex = 0;
    const totalSteps = TOTAL_STEPS;

    return (stage: PipelineStage, status: 'start' | 'complete' | 'progress', _detail?: string) => {
      if (status === 'start') {
        stepIndex++;
        this.onStepBegin(stage, totalSteps, stepIndex);
      } else if (status === 'complete') {
        this.onStepComplete(stage, totalSteps, stepIndex);
      }
      // 'progress' status is handled by onItemProgress called separately
    };
  }
}
