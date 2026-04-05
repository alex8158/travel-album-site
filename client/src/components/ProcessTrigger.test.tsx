import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProcessTrigger from './ProcessTrigger';
import type { ProcessResult } from './ProcessTrigger';

// --- EventSource mock ---
type EventSourceListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState: number;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Record<string, EventSourceListener[]> = {};
  close = vi.fn(() => {
    this.readyState = 2; // CLOSED
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = 1; // OPEN
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventSourceListener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: EventSourceListener) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  // Test helper: emit a named event
  emit(type: string, data?: unknown) {
    const event = new MessageEvent(type, {
      data: data !== undefined ? JSON.stringify(data) : undefined,
    });
    (this.listeners[type] || []).forEach((fn) => fn(event));
  }

  // Test helper: trigger onerror
  triggerError() {
    this.readyState = 0; // CONNECTING (not CLOSED)
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

// Attach CLOSED constant
(MockEventSource as unknown as Record<string, number>).CLOSED = 2;

const mockResult: ProcessResult = {
  tripId: 'trip-1',
  totalImages: 10,
  totalVideos: 2,
  blurryDeletedCount: 1,
  dedupDeletedCount: 2,
  analyzedCount: 7,
  optimizedCount: 7,
  classifiedCount: 7,
  categoryStats: {
    people: 3,
    animal: 1,
    landscape: 2,
    other: 1,
  },
  compiledCount: 0,
  failedCount: 0,
  coverImageId: 'img-1',
};

describe('ProcessTrigger', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function latestES(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }

  it('renders the start processing button', () => {
    render(<ProcessTrigger tripId="trip-1" />);
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDefined();
  });

  it('creates EventSource to SSE endpoint on button click', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(latestES().url).toBe('/api/trips/trip-1/process/stream');
  });

  it('shows loading state while processing', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(screen.getByRole('button', { name: '处理中...' })).toBeDisabled();
  });

  it('updates progress on progress events', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('progress', {
        step: 'dedup',
        stepIndex: 1,
        totalSteps: 4,
        percent: 0,
      });
    });

    expect(screen.getByText('图片去重')).toBeDefined();
    expect(screen.getByText('步骤 1/4')).toBeDefined();
    expect(screen.getByText('0%')).toBeDefined();
  });

  it('displays processing summary after complete event', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('complete', mockResult);
    });

    expect(screen.getByText(/模糊删除：1 张/)).toBeDefined();
    expect(screen.getByText(/去重删除：2 张/)).toBeDefined();
  });

  it('closes EventSource on complete event', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    const es = latestES();
    await act(() => {
      es.emit('complete', mockResult);
    });

    expect(es.close).toHaveBeenCalled();
  });

  it('calls onProcessed callback with result on complete', async () => {
    const onProcessed = vi.fn();
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" onProcessed={onProcessed} />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('complete', mockResult);
    });

    expect(onProcessed).toHaveBeenCalledWith(mockResult);
  });

  it('displays error message on server error event', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('error', { message: '去重处理失败', step: 'dedup' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('去重处理失败');
  });

  it('closes EventSource on server error event', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    const es = latestES();
    await act(() => {
      es.emit('error', { message: '处理失败' });
    });

    expect(es.close).toHaveBeenCalled();
  });

  it('shows disconnected state on connection error', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().triggerError();
    });

    expect(screen.getByText('连接中断，请重新处理')).toBeDefined();
  });

  it('re-enables button after complete', async () => {
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('complete', mockResult);
    });

    expect(screen.getByRole('button', { name: '开始处理' })).not.toBeDisabled();
  });

  it('shows zero counts summary when nothing deleted', async () => {
    const cleanResult: ProcessResult = {
      tripId: 'trip-2',
      totalImages: 5,
      totalVideos: 0,
      blurryDeletedCount: 0,
      dedupDeletedCount: 0,
      analyzedCount: 5,
      optimizedCount: 5,
      classifiedCount: 5,
      categoryStats: {
        people: 0,
        animal: 0,
        landscape: 3,
        other: 2,
      },
      compiledCount: 0,
      failedCount: 0,
    };
    const user = userEvent.setup();
    render(<ProcessTrigger tripId="trip-2" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await act(() => {
      latestES().emit('complete', cleanResult);
    });

    expect(screen.getByText(/模糊删除：0 张/)).toBeDefined();
    expect(screen.getByText(/去重删除：0 张/)).toBeDefined();
  });

  it('closes EventSource on component unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    const es = latestES();
    unmount();

    expect(es.close).toHaveBeenCalled();
  });
});
