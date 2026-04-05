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
  blurDetect: '模糊检测',
  dedup: '图片去重',
  analyze: '图片分析',
  optimize: '自动修图',
  classify: '自动分类',
  thumbnail: '缩略图生成',
  videoAnalysis: '视频分析',
  videoEdit: '视频编辑',
  cover: '封面图选择',
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
            width: `${percent}%`,
            height: 20,
            backgroundColor: '#4caf50',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>{label}</span>
        <span>步骤 {stepIndex}/{totalSteps}</span>
        <span>{percent}%</span>
      </div>
    </div>
  );
}
