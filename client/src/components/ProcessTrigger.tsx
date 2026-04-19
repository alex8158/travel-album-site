import { useState, useEffect, useRef } from 'react';
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
  const [totalSteps, setTotalSteps] = useState(9);
  const [percent, setPercent] = useState(0);
  const [processed, setProcessed] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      handleProcess();
    }
  }, [autoStart]);

  function handleProcess() {
    // Reset state
    setStatus('processing');
    setCurrentStep(null);
    setStepIndex(0);
    setPercent(0);
    setProcessed(null);
    setTotal(null);
    setResult(null);
    setErrorMessage('');

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/trips/${tripId}/process/stream`);
    eventSourceRef.current = es;

    es.addEventListener('progress', (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      setCurrentStep(data.step);
      setStepIndex(data.stepIndex);
      setTotalSteps(data.totalSteps);
      setPercent(data.percent);
      if (data.processed != null) setProcessed(data.processed);
      if (data.total != null) setTotal(data.total);
    });

    es.addEventListener('complete', (event: MessageEvent) => {
      const data = JSON.parse(event.data) as ProcessResult;
      setResult(data);
      setStatus('complete');
      onProcessed?.(data);
      es.close();
      eventSourceRef.current = null;
    });

    es.addEventListener('error', (event: MessageEvent) => {
      // SSE named 'error' event from server (with data)
      if (event.data) {
        const data = JSON.parse(event.data);
        setErrorMessage(data.message || '处理失败，请重试');
      } else {
        setErrorMessage('处理失败，请重试');
      }
      setStatus('error');
      es.close();
      eventSourceRef.current = null;
    });

    es.onerror = () => {
      // Connection-level error (disconnected)
      if (es.readyState === EventSource.CLOSED) {
        return; // Already closed normally
      }
      setStatus('disconnected');
      es.close();
      eventSourceRef.current = null;
    };
  }

  const isProcessing = status === 'processing';
  const canRetry = status === 'error' || status === 'disconnected';

  return (
    <div aria-label="素材处理">
      {!autoStart && !canRetry && (
        <button onClick={handleProcess} disabled={isProcessing}>
          {isProcessing ? '处理中...' : '开始处理'}
        </button>
      )}

      {canRetry && (
        <button onClick={handleProcess}>
          重新处理
        </button>
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
