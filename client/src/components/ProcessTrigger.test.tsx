import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import ProcessTrigger from './ProcessTrigger';
import type { ProcessResult } from './ProcessTrigger';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

const mockResult: ProcessResult = {
  tripId: 'trip-1',
  totalImages: 10,
  duplicateGroups: [
    { groupId: 'g1', imageCount: 3 },
    { groupId: 'g2', imageCount: 2 },
  ],
  totalGroups: 2,
  coverImageId: 'img-1',
};

describe('ProcessTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the start processing button', () => {
    render(<ProcessTrigger tripId="trip-1" />);
    expect(screen.getByRole('button', { name: '开始处理' })).toBeDefined();
  });

  it('calls POST /api/trips/:id/process on button click', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: mockResult });
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/trips/trip-1/process');
    });
  });

  it('shows loading state while processing', async () => {
    let resolvePost: (value: unknown) => void;
    mockedAxios.post.mockReturnValueOnce(
      new Promise((resolve) => { resolvePost = resolve; })
    );
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    expect(screen.getByRole('button', { name: '处理中...' })).toBeDisabled();

    resolvePost!({ data: mockResult });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '开始处理' })).not.toBeDisabled();
    });
  });

  it('displays dedup summary after processing', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: mockResult });
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(screen.getByText('共检测到 2 个重复组')).toBeDefined();
    });

    expect(screen.getByText(/组 g1：3 张图片/)).toBeDefined();
    expect(screen.getByText(/组 g2：2 张图片/)).toBeDefined();
  });

  it('calls onProcessed callback with result', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: mockResult });
    const onProcessed = vi.fn();
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-1" onProcessed={onProcessed} />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(onProcessed).toHaveBeenCalledWith(mockResult);
    });
  });

  it('displays error message on API failure', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { error: { message: '旅行不存在' } } },
    });
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="bad-id" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('旅行不存在');
    });
  });

  it('displays generic error on non-axios failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network Error'));
    vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-1" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('处理失败，请重试');
    });
  });

  it('shows zero groups summary when no duplicates found', async () => {
    const noDupsResult: ProcessResult = {
      tripId: 'trip-2',
      totalImages: 5,
      duplicateGroups: [],
      totalGroups: 0,
    };
    mockedAxios.post.mockResolvedValueOnce({ data: noDupsResult });
    const user = userEvent.setup();

    render(<ProcessTrigger tripId="trip-2" />);
    await user.click(screen.getByRole('button', { name: '开始处理' }));

    await waitFor(() => {
      expect(screen.getByText('共检测到 0 个重复组')).toBeDefined();
    });
  });
});
