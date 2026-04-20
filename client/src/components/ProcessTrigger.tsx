import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';
import ProgressBar from './ProgressBar';
import type { ProgressStatus } from './ProgressBar';

export interface ProcessResult {
  tripId: string;
  totalImages: number;
  totalVideos: number;
  blurryDeletedCount: number;
  dedupDeletedCount: number;
  analyzedCount: number;
  optimizedCount: number;
  classifiedCount: number;
  categoryStats: {
    people: number;
    animal: number;
    landscape: number;
    other: number;
  };
  compiledCount: number;
  failedCount: number;
  coverImageId?: string | null;
}

export interface ProcessTriggerProps {
  tripId: string;
  autoStart?: boolean;
  onProcessed?: (result: ProcessResult) => void;
}

export default function ProcessTrigger({ tripId, autoStart, onProcessed }: ProcessTriggerProps) {
  const [status, setStatus] = useState<ProgressStatus>('idle');
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [totalSteps] = useState(12);
  const [percent, setPercent] = useState(0);
  const [processed, setProcessed] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStartedRef = useRef(false);
  const jobIdRef = useRef<string | null>(null);
  const failCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const fetchResult = useCallback(async (jobId: string) => {
    const res = await authFetch(`/api/process-jobs/${jobId}/result`);
    if (!res.ok) throw new Error('Failed to fetch result');
    return (await res.json()) as ProcessResult;
  }, []);

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await authFetch(`/api/process-jobs/${jobId}`);
      if (!res.ok) {
        // Treat non-ok as a network-level failure for retry logic
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!mountedRef.current) return;

      // Reset fail count on success
      failCountRef.current = 0;
      setWarningMessage('');

      // Update progress state
      if (data.currentStep) setCurrentStep(data.currentStep);
      if (data.percent != null) setPercent(data.percent);
      if (data.processed != null) setProcessed(data.processed);
      if (data.total != null) setTotal(data.total);

      // Compute stepIndex from percent and totalSteps for ProgressBar
      // The backend sets percent = Math.round((stepIndex / totalSteps) * 100)
      // We can approximate stepIndex from percent
      if (data.percent != null) {
        const approxIndex = Math.round((data.percent / 100) * totalSteps);
        setStepIndex(approxIndex);
      }

      if (data.status === 'completed') {
        stopPolling();
        try {
          const resultData = await fetchResult(jobId);
          if (!mountedRef.current) return;
          setResult(resultData);
          setStatus('complete');
          onProcessed?.(resultData);
        } catch {
          if (!mountedRef.current) return;
          setStatus('complete');
        }
      } else if (data.status === 'failed') {
        stopPolling();
        setErrorMessage(data.errorMessage || '处理失败，请重试');
        setStatus('error');
      }
      // else: queued or running — keep polling
    } catch {
      if (!mountedRef.current) return;
      failCountRef.current += 1;

      if (failCountRef.current >= 3) {
        // Switch to slow retry mode with warning
        stopPolling();
        setWarningMessage('连接异常');
        // Retry every 10s
        retryTimeoutRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          startPolling(jobId, 10000);
        }, 10000);
      } else {
        // Exponential backoff: 2s, 4s, 8s
        const backoffMs = Math.pow(2, failCountRef.current) * 1000;
        stopPolling();
        retryTimeoutRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          startPolling(jobId);
        }, backoffMs);
      }
    }
  }, [totalSteps, stopPolling, fetchResult, onProcessed]);

  const startPolling = useCallback((jobId: string, intervalMs = 2000) => {
    stopPolling();
    // Do an immediate poll
    pollJob(jobId);
    pollingRef.current = setInterval(() => pollJob(jobId), intervalMs);
  }, [stopPolling, pollJob]);

  const activeJobCheckedRef = useRef(false);

  // Check for active job on mount (handles page refresh)
  useEffect(() => {
    let cancelled = false;
    async function checkActiveJob() {
      try {
        const res = await authFetch(`/api/trips/${tripId}/active-job`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (data.jobId) {
            jobIdRef.current = data.jobId;
            setStatus('processing');
            startPolling(data.jobId);
            activeJobCheckedRef.current = true;
            return;
          }
        }
        // 404 means no active job — stay idle
      } catch {
        // Network error on mount check — ignore, user can manually start
      }
      if (!cancelled) {
        activeJobCheckedRef.current = true;
      }
    }
    checkActiveJob();
    return () => { cancelled = true; };
  }, [tripId, startPolling]);

  // Auto-start (only after active job check completes to avoid race condition)
  useEffect(() => {
    if (autoStart && !autoStartedRef.current && status === 'idle' && activeJobCheckedRef.current) {
      autoStartedRef.current = true;
      handleProcess();
    }
  }, [autoStart, status]);

  async function handleProcess() {
    // Reset state
    setStatus('processing');
    setCurrentStep(null);
    setStepIndex(0);
    setPercent(0);
    setProcessed(null);
    setTotal(null);
    setResult(null);
    setErrorMessage('');
    setWarningMessage('');
    failCountRef.current = 0;
    stopPolling();

    try {
      const res = await authFetch(`/api/trips/${tripId}/process-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 409) {
        // Already processing — extract existingJobId and poll that
        const body = await res.json();
        const existingJobId = body?.error?.existingJobId;
        if (existingJobId) {
          jobIdRef.current = existingJobId;
          startPolling(existingJobId);
          return;
        }
        // No existingJobId in response — treat as error
        setErrorMessage('该旅行正在处理中');
        setStatus('error');
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMessage(body?.error?.message || '创建任务失败');
        setStatus('error');
        return;
      }

      const data = await res.json();
      jobIdRef.current = data.jobId;
      startPolling(data.jobId);
    } catch {
      setErrorMessage('网络错误，请重试');
      setStatus('error');
    }
  }

  const isProcessing = status === 'processing';
  const canRetry = status === 'error' || status === 'disconnected';

  return (
    <div aria-label="素材处理">
      {!autoStart && !canRetry && !isProcessing && status !== 'complete' && (
        <button onClick={handleProcess} disabled={isProcessing}>
          开始处理
        </button>
      )}

      {canRetry && (
        <button onClick={handleProcess}>
          重新处理
        </button>
      )}

      {warningMessage && (
        <p role="alert" style={{ color: 'orange' }}>{warningMessage}</p>
      )}

      <ProgressBar
        status={status}
        currentStep={currentStep}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        percent={percent}
        errorMessage={errorMessage}
      />

      {isProcessing && processed != null && total != null && (
        <p aria-label="处理计数">{processed}/{total}</p>
      )}

      {result && (
        <div aria-label="处理摘要">
          <p>模糊删除：{result.blurryDeletedCount} 张</p>
          <p>去重删除：{result.dedupDeletedCount} 张</p>
          <p>分析成功：{result.analyzedCount} 张</p>
          <p>优化成功：{result.optimizedCount} 张</p>
          <p>分类成功：{result.classifiedCount} 张</p>
          {result.categoryStats && (
            <ul>
              <li>人物：{result.categoryStats.people} 张</li>
              <li>动物：{result.categoryStats.animal} 张</li>
              <li>风景：{result.categoryStats.landscape} 张</li>
              <li>其他：{result.categoryStats.other} 张</li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
