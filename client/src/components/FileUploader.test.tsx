import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import FileUploader, { isFormatSupported } from './FileUploader';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

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
  });

  it('renders file input and label', () => {
    render(<FileUploader tripId="trip-1" />);
    expect(screen.getByLabelText('选择文件')).toBeDefined();
  });

  it('shows unsupported format warnings and skips invalid files', () => {
    render(<FileUploader tripId="trip-1" />);

    const input = screen.getByLabelText('选择文件') as HTMLInputElement;
    const validFile = createFile('photo.jpg', 'image/jpeg');
    const invalidFile = createFile('doc.pdf', 'application/pdf');

    // Simulate selecting files that bypass the accept attribute (e.g. drag-and-drop)
    fireEvent.change(input, { target: { files: [validFile, invalidFile] } });

    expect(screen.getByText(/doc\.pdf.+格式不支持/)).toBeDefined();
    expect(screen.getByText('photo.jpg')).toBeDefined();
  });

  it('shows pending status and progress for selected files', async () => {
    const user = userEvent.setup();
    render(<FileUploader tripId="trip-1" />);

    const input = screen.getByLabelText('选择文件');
    await user.upload(input, [createFile('a.jpg', 'image/jpeg'), createFile('b.png', 'image/png')]);

    expect(screen.getByTestId('status-0')).toHaveTextContent('pending');
    expect(screen.getByTestId('progress-0')).toHaveTextContent('0%');
    expect(screen.getByTestId('status-1')).toHaveTextContent('pending');
    expect(screen.getByTestId('progress-1')).toHaveTextContent('0%');
  });

  it('uploads files one by one to POST /api/trips/:id/media', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 'media-1' } });
    mockedAxios.isAxiosError = vi.fn().mockReturnValue(false);

    const user = userEvent.setup();
    render(<FileUploader tripId="trip-42" />);

    const input = screen.getByLabelText('选择文件');
    await user.upload(input, [createFile('a.jpg', 'image/jpeg')]);

    const uploadBtn = screen.getByRole('button', { name: /开始上传/ });
    await user.click(uploadBtn);

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, data] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('/api/trips/trip-42/media');
      expect(data).toBeInstanceOf(FormData);
    });

    await waitFor(() => {
      expect(screen.getByTestId('status-0')).toHaveTextContent('completed');
      expect(screen.getByTestId('progress-0')).toHaveTextContent('100%');
    });
  });

  it('shows failed status and retry button on upload error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network Error'));
    mockedAxios.isAxiosError = vi.fn().mockReturnValue(false);

    const user = userEvent.setup();
    render(<FileUploader tripId="trip-1" />);

    const input = screen.getByLabelText('选择文件');
    await user.upload(input, [createFile('a.jpg', 'image/jpeg')]);

    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    await waitFor(() => {
      expect(screen.getByTestId('status-0')).toHaveTextContent('failed');
    });

    expect(screen.getByRole('button', { name: '重试' })).toBeDefined();
  });

  it('retries a failed upload when retry button is clicked', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: { id: 'media-1' } });
    mockedAxios.isAxiosError = vi.fn().mockReturnValue(false);

    const user = userEvent.setup();
    render(<FileUploader tripId="trip-1" />);

    const input = screen.getByLabelText('选择文件');
    await user.upload(input, [createFile('a.jpg', 'image/jpeg')]);

    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    await waitFor(() => {
      expect(screen.getByTestId('status-0')).toHaveTextContent('failed');
    });

    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(screen.getByTestId('status-0')).toHaveTextContent('completed');
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('preserves completed files when some uploads fail', async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { id: 'media-1' } })
      .mockRejectedValueOnce(new Error('Network Error'));
    mockedAxios.isAxiosError = vi.fn().mockReturnValue(false);

    const user = userEvent.setup();
    render(<FileUploader tripId="trip-1" />);

    const input = screen.getByLabelText('选择文件');
    await user.upload(input, [
      createFile('a.jpg', 'image/jpeg'),
      createFile('b.png', 'image/png'),
    ]);

    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    await waitFor(() => {
      expect(screen.getByTestId('status-0')).toHaveTextContent('completed');
      expect(screen.getByTestId('status-1')).toHaveTextContent('failed');
    });
  });
});
