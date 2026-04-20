import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProcessTrigger from './ProcessTrigger';
import type { ProcessResult } from './ProcessTrigger';

// Mock authFetch
const mockAuthFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

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

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

function notFoundResponse() {
  return Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.resolve({ error: { code: 'NOT_FOUND' } }),
  } as Response);
}

describe('ProcessTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockAuthFetch.mockReset();
    // Default: no active job on mount
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      return notFoundResponse();
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the start processing button when no active job', async () => {
    render(<ProcessTrigger tripId="trip-1" />);
    // Wait for active-job check to complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDefined();
  });

  it('POSTs to create a job on button click and starts polling', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (typeof url === 'string' && url.includes('/process-jobs/job-1') && !url.includes('/result')) {
        return jsonResponse({
          id: 'job-1', tripId: 'trip-1', status: 'running',
          currentStep: 'classify', percent: 10, processed: 2, total: 10,
        });
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));

    // Wait for POST + immediate poll
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Verify POST was called
    expect(mockAuthFetch).toHaveBeenCalledWith(
      '/api/trips/trip-1/process-jobs',
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify poll was called
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/process-jobs/job-1');
  });

  it('handles 409 by polling the existing job', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: 'existing-job' } },
          409,
        );
      }
      if (typeof url === 'string' && url.includes('/process-jobs/existing-job') && !url.includes('/result')) {
        return jsonResponse({
          id: 'existing-job', tripId: 'trip-1', status: 'running',
          currentStep: 'dedup', percent: 33, processed: 5, total: 20,
        });
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Should be polling the existing job, not showing error
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/process-jobs/existing-job');
  });

  it('stops polling and shows result on completed status', async () => {
    const onProcessed = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    let pollCount = 0;
    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (typeof url === 'string' && url.match(/\/process-jobs\/job-1$/) ) {
        pollCount++;
        if (pollCount >= 2) {
          return jsonResponse({
            id: 'job-1', tripId: 'trip-1', status: 'completed',
            currentStep: 'cover', percent: 100, processed: 10, total: 10,
          });
        }
        return jsonResponse({
          id: 'job-1', tripId: 'trip-1', status: 'running',
          currentStep: 'classify', percent: 10, processed: 2, total: 10,
        });
      }
      if (typeof url === 'string' && url.includes('/process-jobs/job-1/result')) {
        return jsonResponse(mockResult);
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" onProcessed={onProcessed} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));

    // Wait for POST + first poll
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Advance to trigger second poll (completed)
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    // Should have fetched result and called onProcessed
    await waitFor(() => {
      expect(onProcessed).toHaveBeenCalledWith(mockResult);
    });

    expect(screen.getByText(/模糊删除：1 张/)).toBeDefined();
  });

  it('stops polling and shows error on failed status', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (typeof url === 'string' && url.match(/\/process-jobs\/job-1$/)) {
        return jsonResponse({
          id: 'job-1', tripId: 'trip-1', status: 'failed',
          errorMessage: '去重处理失败',
        });
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('alert')).toHaveTextContent('去重处理失败');
  });

  it('resumes polling on mount when active job exists', async () => {
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return jsonResponse({ jobId: 'active-job-1', status: 'running' });
      }
      if (typeof url === 'string' && url.match(/\/process-jobs\/active-job-1$/) ) {
        return jsonResponse({
          id: 'active-job-1', tripId: 'trip-1', status: 'running',
          currentStep: 'blur', percent: 20, processed: 3, total: 15,
        });
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);

    // Wait for active-job check + immediate poll
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Should be polling the active job
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/process-jobs/active-job-1');
    // Should not show start button (processing state)
    expect(screen.queryByRole('button', { name: '开始处理' })).toBeNull();
  });

  it('shows 连接异常 warning after 3 consecutive poll failures', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    let postDone = false;
    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        postDone = true;
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (postDone && typeof url === 'string' && url.match(/\/process-jobs\/job-1$/)) {
        return Promise.reject(new Error('Network error'));
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));

    // First poll fails immediately (fail count = 1), backoff 2s
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Second poll after 2s backoff (fail count = 2), backoff 4s
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    // Third poll after 4s backoff (fail count = 3) → warning
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });

    // Should show warning, NOT '处理失败'
    await waitFor(() => {
      expect(screen.getByText('连接异常')).toBeDefined();
    });
    expect(screen.queryByText('处理失败')).toBeNull();
  });

  it('never shows 处理失败 while retrying', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    let postDone = false;
    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        postDone = true;
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (postDone && typeof url === 'string' && url.match(/\/process-jobs\/job-1$/)) {
        return Promise.reject(new Error('Network error'));
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));

    // First failure
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.queryByText(/处理失败/)).toBeNull();

    // Second failure
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByText(/处理失败/)).toBeNull();
  });

  it('cleans up polling on unmount', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (typeof url === 'string' && url.match(/\/process-jobs\/job-1$/)) {
        return jsonResponse({
          id: 'job-1', tripId: 'trip-1', status: 'running',
          currentStep: 'classify', percent: 10, processed: 2, total: 10,
        });
      }
      return notFoundResponse();
    });

    const { unmount } = render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    const callCountBefore = mockAuthFetch.mock.calls.length;
    unmount();

    // Advance time — no more polls should happen
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockAuthFetch.mock.calls.length).toBe(callCountBefore);
  });

  it('shows retry button after error', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockAuthFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/active-job')) {
        return notFoundResponse();
      }
      if (typeof url === 'string' && url.includes('/process-jobs') && opts?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' });
      }
      if (typeof url === 'string' && url.match(/\/process-jobs\/job-1$/)) {
        return jsonResponse({
          id: 'job-1', tripId: 'trip-1', status: 'failed',
          errorMessage: '处理出错',
        });
      }
      return notFoundResponse();
    });

    render(<ProcessTrigger tripId="trip-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    await user.click(screen.getByRole('button', { name: '开始处理' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(screen.getByRole('button', { name: '重新处理' })).toBeDefined();
  });
});
