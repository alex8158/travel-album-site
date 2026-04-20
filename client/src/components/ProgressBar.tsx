export type ProgressStatus = 'idle' | 'processing' | 'complete' | 'error' | 'disconnected';

export interface ProgressBarProps {
  status: ProgressStatus;
  currentStep: string | null;
  stepIndex: number;
  totalSteps: number;
  percent: number;
  errorMessage?: string;
}

const STEP_LABELS: Record<string, string> = {
  collectInputs: '收集图片',
  classify: '分类',
  blur: '模糊检测',
  blurDetect: '模糊检测',
  dedup: '去重',
  reduce: '汇总',
  write: '写入',
  analyze: '分析',
  optimize: '优化',
  thumbnail: '缩略图',
  videoAnalysis: '视频分析',
  videoEdit: '视频编辑',
  cover: '封面',
};

export function getStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

export default function ProgressBar({
  status,
  currentStep,
  stepIndex,
  totalSteps,
  percent,
  errorMessage,
}: ProgressBarProps) {
  if (status === 'idle') {
    return null;
  }

  if (status === 'complete') {
    return (
      <div aria-label="处理进度">
        <p>处理完成</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div aria-label="处理进度">
        <p role="alert" style={{ color: 'red' }}>
          {errorMessage || '处理出错'}
        </p>
      </div>
    );
  }

  if (status === 'disconnected') {
    return (
      <div aria-label="处理进度">
        <p>连接中断，请重新处理</p>
      </div>
    );
  }

  // processing status
  const label = currentStep ? getStepLabel(currentStep) : '';

  return (
    <div aria-label="处理进度">
      <div
        style={{
          width: '100%',
          backgroundColor: '#e0e0e0',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          data-testid="progress-bar-fill"
          style={{
            width: `${Math.max(percent, 2)}%`,
            height: 20,
            backgroundColor: '#4caf50',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>{stepIndex === 0 ? '准备中...' : label}</span>
        <span>{stepIndex === 0 ? '准备中...' : `步骤 ${stepIndex}/${totalSteps}`}</span>
        <span>{percent}%</span>
      </div>
    </div>
  );
}
