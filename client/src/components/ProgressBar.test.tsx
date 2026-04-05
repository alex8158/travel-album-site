import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressBar, { getStepLabel } from './ProgressBar';

describe('getStepLabel', () => {
  it('maps dedup to 图片去重', () => {
    expect(getStepLabel('dedup')).toBe('图片去重');
  });

  it('maps blurDetect to 模糊检测', () => {
    expect(getStepLabel('blurDetect')).toBe('模糊检测');
  });

  it('maps thumbnail to 缩略图生成', () => {
    expect(getStepLabel('thumbnail')).toBe('缩略图生成');
  });

  it('maps cover to 封面图选择', () => {
    expect(getStepLabel('cover')).toBe('封面图选择');
  });

  it('returns unknown identifiers as-is', () => {
    expect(getStepLabel('unknown_step')).toBe('unknown_step');
  });
});

describe('ProgressBar', () => {
  it('renders nothing when status is idle', () => {
    const { container } = render(
      <ProgressBar
        status="idle"
        currentStep={null}
        stepIndex={0}
        totalSteps={4}
        percent={0}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders progress bar with step info when processing', () => {
    render(
      <ProgressBar
        status="processing"
        currentStep="dedup"
        stepIndex={1}
        totalSteps={4}
        percent={0}
      />
    );

    expect(screen.getByText('图片去重')).toBeDefined();
    expect(screen.getByText('步骤 1/4')).toBeDefined();
    expect(screen.getByText('0%')).toBeDefined();
  });

  it('displays correct percent and step for mid-processing', () => {
    render(
      <ProgressBar
        status="processing"
        currentStep="analyze"
        stepIndex={2}
        totalSteps={9}
        percent={50}
      />
    );

    expect(screen.getByText('图片分析')).toBeDefined();
    expect(screen.getByText('步骤 2/9')).toBeDefined();
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('shows completion message when status is complete', () => {
    render(
      <ProgressBar
        status="complete"
        currentStep={null}
        stepIndex={4}
        totalSteps={4}
        percent={100}
      />
    );

    expect(screen.getByText('处理完成')).toBeDefined();
  });

  it('shows error message with role="alert" when status is error', () => {
    render(
      <ProgressBar
        status="error"
        currentStep="dedup"
        stepIndex={1}
        totalSteps={4}
        percent={0}
        errorMessage="去重处理失败"
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('去重处理失败');
  });

  it('shows default error text when errorMessage is not provided', () => {
    render(
      <ProgressBar
        status="error"
        currentStep={null}
        stepIndex={0}
        totalSteps={4}
        percent={0}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('处理出错');
  });

  it('shows disconnected message when status is disconnected', () => {
    render(
      <ProgressBar
        status="disconnected"
        currentStep={null}
        stepIndex={0}
        totalSteps={4}
        percent={0}
      />
    );

    expect(screen.getByText('连接中断，请重新处理')).toBeDefined();
  });

  it('has CSS transition on the progress bar fill', () => {
    render(
      <ProgressBar
        status="processing"
        currentStep="thumbnail"
        stepIndex={3}
        totalSteps={4}
        percent={75}
      />
    );

    const fill = screen.getByTestId('progress-bar-fill');
    expect(fill.style.transition).toContain('width');
  });

  it('sets progress bar width according to percent', () => {
    render(
      <ProgressBar
        status="processing"
        currentStep="cover"
        stepIndex={4}
        totalSteps={4}
        percent={100}
      />
    );

    const fill = screen.getByTestId('progress-bar-fill');
    expect(fill.style.width).toBe('100%');
  });
});
