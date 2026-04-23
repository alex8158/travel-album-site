import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileUploader, { isFormatSupported } from './FileUploader';

const { mockApiPost, mockGetApiErrorMessage } = vi.hoisted(() => ({
  mockApiPost: vi.fn(),
  mockGetApiErrorMessage: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../api', () => ({
  apiPost: mockApiPost,
  getApiErrorMessage: mockGetApiErrorMessage,
}));

function createFile(name: string, type: string, size = 1024): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

describe('isFormatSupported', () => {
  it('accepts supported image MIME types', () => {
    expect(isFormatSupported(createFile('a.jpg', 'image/jpeg'))).toBe(true);
    expect(isFormatSupported(createFile('b.png', 'image/png'))).toBe(true);
    expect(isFormatSupported(createFile('c.webp', 'image/webp'))).toBe(true);
    expect(isFormatSupported(createFile('d.heic', 'image/heic'))).toBe(true);
  });

  it('accepts supported video MIME types', () => {
    expect(isFormatSupported(createFile('a.mp4', 'video/mp4'))).toBe(true);
    expect(isFormatSupported(createFile('b.mov', 'video/quicktime'))).toBe(true);
    expect(isFormatSupported(createFile('c.avi', 'video/x-msvideo'))).toBe(true);
    expect(isFormatSupported(createFile('d.mkv', 'video/x-matroska'))).toBe(true);
  });

  it('accepts files by extension when MIME type is empty', () => {
    expect(isFormatSupported(createFile('photo.jpg', ''))).toBe(true);
    expect(isFormatSupported(createFile('photo.jpeg', ''))).toBe(true);
    expect(isFormatSupported(createFile('video.mkv', ''))).toBe(true);
  });

  it('rejects unsupported formats', () => {
    expect(isFormatSupported(createFile('doc.pdf', 'application/pdf'))).toBe(false);
    expect(isFormatSupported(createFile('file.txt', 'text/plain'))).toBe(false);
    expect(isFormatSupported(createFile('noext', ''))).toBe(false);
  });
});

describe('FileUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiErrorMessage.mockReturnValue(undefined);
  });

  it('renders file and folder selection buttons', () => {
    render(<FileUploader tripId="trip-1" />);
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDefined();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDefined();
  });

  it('has a hidden file input', () => {
    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    expect(input.style.display).toBe('none');
    expect(input.type).toBe('file');
  });

  it('sets webkitdirectory attribute when folder button is clicked', () => {
    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;

    // Click folder button - should set webkitdirectory
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
  });

  it('removes webkitdirectory attribute when file button is clicked', () => {
    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;

    // First click folder to set it
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    expect(input.hasAttribute('webkitdirectory')).toBe(true);

    // Then click file to remove it
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    expect(input.hasAttribute('webkitdirectory')).toBe(false);
  });

  it('shows skipped count warning when some files are unsupported', () => {
    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    const validFile = createFile('photo.jpg', 'image/jpeg');
    const invalidFile1 = createFile('doc.pdf', 'application/pdf');
    const invalidFile2 = createFile('file.txt', 'text/plain');

    fireEvent.change(input, { target: { files: [validFile, invalidFile1, invalidFile2] } });

    expect(screen.getByText('已跳过 2 个不支持格式的文件')).toBeDefined();
  });

  it('shows "未找到支持格式的文件" when no files are supported', () => {
    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    const invalidFile = createFile('doc.pdf', 'application/pdf');
    fireEvent.change(input, { target: { files: [invalidFile] } });

    expect(screen.getByText('未找到支持格式的文件')).toBeDefined();
  });

  it('auto-starts upload after file selection and shows aggregate progress', async () => {
    mockApiPost.mockResolvedValue({ data: { id: 'media-1' } });

    render(<FileUploader tripId="trip-42" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('a.jpg', 'image/jpeg'), createFile('b.png', 'image/png')] },
    });

    // Should auto-upload without needing a manual button click
    await waitFor(() => {
      expect(mockApiPost.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-count')).toHaveTextContent('2/2');
      expect(screen.getByTestId('upload-percent')).toHaveTextContent('100%');
    });
  });

  it('does not render per-file upload list', async () => {
    mockApiPost.mockResolvedValue({ data: { id: 'media-1' } });

    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('a.jpg', 'image/jpeg')] },
    });

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledTimes(1);
    });

    // Should NOT have per-file upload list
    expect(screen.queryByRole('list', { name: '上传列表' })).toBeNull();
  });

  it('shows failed files below progress bar with retry button', async () => {
    mockApiPost
      .mockResolvedValueOnce({ data: { id: 'media-1' } })
      .mockRejectedValueOnce(new Error('Network Error'));

    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('a.jpg', 'image/jpeg'), createFile('b.png', 'image/png')] },
    });

    await waitFor(() => {
      expect(mockApiPost.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await waitFor(() => {
      // Progress should show 1/2
      expect(screen.getByTestId('upload-count')).toHaveTextContent('1/2');
    });

    // Failed file should be shown with name and retry button
    expect(screen.getByText('b.png')).toBeDefined();
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined();
  });

  it('retries a failed upload and calls onAllUploaded when all complete', async () => {
    const onAllUploaded = vi.fn();
    mockApiPost
      .mockResolvedValueOnce({ data: { id: 'media-1' } })
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: { id: 'media-2' } });

    render(<FileUploader tripId="trip-1" onAllUploaded={onAllUploaded} />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('a.jpg', 'image/jpeg'), createFile('b.png', 'image/png')] },
    });

    await waitFor(() => {
      expect(mockApiPost.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重试' })).toBeDefined();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledTimes(3);
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-count')).toHaveTextContent('2/2');
    });

    await waitFor(() => {
      expect(onAllUploaded).toHaveBeenCalledWith(2);
    });
  });

  it('calls onAllUploaded when all files upload successfully', async () => {
    const onAllUploaded = vi.fn();
    mockApiPost.mockResolvedValue({ data: { id: 'media-1' } });

    render(<FileUploader tripId="trip-1" onAllUploaded={onAllUploaded} />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('a.jpg', 'image/jpeg')] },
    });

    await waitFor(() => {
      expect(onAllUploaded).toHaveBeenCalledWith(1);
    });
  });

  it('shows processing status for video uploads - success', async () => {
    let resolveProcess: (value: unknown) => void;
    const processPromise = new Promise(resolve => { resolveProcess = resolve; });

    mockApiPost
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'vid-1', mediaType: 'video' } }))
      .mockImplementationOnce(() => processPromise);

    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('clip.mp4', 'video/mp4')] },
    });

    // Should show "处理中…" while processing
    await waitFor(() => {
      expect(screen.getByText('处理中…')).toBeDefined();
    });

    // Resolve the process call
    resolveProcess!({ data: { success: true } });

    // Should show "处理完成" after success
    await waitFor(() => {
      expect(screen.getByText('处理完成')).toBeDefined();
    });
  });

  it('shows processing failed status for video uploads', async () => {
    mockApiPost
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'vid-2', mediaType: 'video' } }))
      .mockImplementationOnce(() => Promise.reject(new Error('Processing error')));

    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('clip.mp4', 'video/mp4')] },
    });

    await waitFor(() => {
      expect(screen.getByText('处理失败')).toBeDefined();
    });
  });

  it('does not show processing status for image uploads', async () => {
    mockApiPost.mockResolvedValue({ data: { id: 'img-1', mediaType: 'image' } });

    render(<FileUploader tripId="trip-1" />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('photo.jpg', 'image/jpeg')] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-count')).toHaveTextContent('1/1');
    });

    expect(screen.queryByText('处理中…')).toBeNull();
    expect(screen.queryByText('处理完成')).toBeNull();
    expect(screen.queryByText('处理失败')).toBeNull();
  });

  it('calls onVideoUploaded for video files and tracks processing', async () => {
    const onVideoUploaded = vi.fn();
    mockApiPost
      .mockImplementationOnce(() => Promise.resolve({ data: { id: 'vid-3', mediaType: 'video' } }))
      .mockImplementationOnce(() => Promise.resolve({ data: { success: true } }));

    render(<FileUploader tripId="trip-1" onVideoUploaded={onVideoUploaded} />);
    const input = screen.getByTestId('file-input');

    fireEvent.change(input, {
      target: { files: [createFile('clip.mp4', 'video/mp4')] },
    });

    await waitFor(() => {
      expect(onVideoUploaded).toHaveBeenCalledWith('vid-3', 'video');
    });

    // Processing should complete
    await waitFor(() => {
      expect(screen.getByText('处理完成')).toBeDefined();
    });
  });
});
