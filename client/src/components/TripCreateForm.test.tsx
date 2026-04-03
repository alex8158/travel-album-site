import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TripCreateForm from './TripCreateForm';

const mockAuthFetch = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

describe('TripCreateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title input, description textarea, and submit button', () => {
    render(<TripCreateForm />);
    expect(screen.getByLabelText(/旅行标题/)).toBeDefined();
    expect(screen.getByLabelText(/旅行说明/)).toBeDefined();
    expect(screen.getByRole('button', { name: /创建旅行/ })).toBeDefined();
  });

  it('disables submit button when title is empty', () => {
    render(<TripCreateForm />);
    const button = screen.getByRole('button', { name: /创建旅行/ });
    expect(button).toBeDisabled();
  });

  it('disables submit button when title is whitespace only', async () => {
    const user = userEvent.setup();
    render(<TripCreateForm />);
    const input = screen.getByLabelText(/旅行标题/);
    await user.type(input, '   ');
    const button = screen.getByRole('button', { name: /创建旅行/ });
    expect(button).toBeDisabled();
  });

  it('shows validation message when title has only whitespace', async () => {
    const user = userEvent.setup();
    render(<TripCreateForm />);
    const input = screen.getByLabelText(/旅行标题/);
    await user.type(input, '   ');
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('标题不能为空')).toBeDefined();
  });

  it('enables submit button when title has non-whitespace content', async () => {
    const user = userEvent.setup();
    render(<TripCreateForm />);
    const input = screen.getByLabelText(/旅行标题/);
    await user.type(input, '东京之旅');
    const button = screen.getByRole('button', { name: /创建旅行/ });
    expect(button).not.toBeDisabled();
  });

  it('calls authFetch with title and description on submit', async () => {
    const onCreated = vi.fn();
    const tripData = { id: '123', title: '东京之旅', description: '美好的旅行' };
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(tripData),
    });

    const user = userEvent.setup();
    render(<TripCreateForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/旅行标题/), '东京之旅');
    await user.type(screen.getByLabelText(/旅行说明/), '美好的旅行');
    await user.click(screen.getByRole('button', { name: /创建旅行/ }));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/trips', expect.objectContaining({
        method: 'POST',
      }));
    });

    expect(onCreated).toHaveBeenCalledWith(tripData);
  });

  it('calls authFetch with title only when description is empty', async () => {
    const onCreated = vi.fn();
    const tripData = { id: '456', title: '巴黎之旅' };
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(tripData),
    });

    const user = userEvent.setup();
    render(<TripCreateForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/旅行标题/), '巴黎之旅');
    await user.click(screen.getByRole('button', { name: /创建旅行/ }));

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/trips', expect.objectContaining({
        method: 'POST',
      }));
    });

    expect(onCreated).toHaveBeenCalledWith(tripData);
  });

  it('resets form after successful creation', async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: '789', title: 'Test' }),
    });

    const user = userEvent.setup();
    render(<TripCreateForm />);

    const titleInput = screen.getByLabelText(/旅行标题/) as HTMLInputElement;
    const descInput = screen.getByLabelText(/旅行说明/) as HTMLTextAreaElement;

    await user.type(titleInput, 'Test Trip');
    await user.type(descInput, 'Some description');
    await user.click(screen.getByRole('button', { name: /创建旅行/ }));

    await waitFor(() => {
      expect(titleInput.value).toBe('');
      expect(descInput.value).toBe('');
    });
  });

  it('displays error message on API failure', async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: '旅行标题不能为空' } }),
    });

    const user = userEvent.setup();
    render(<TripCreateForm />);

    await user.type(screen.getByLabelText(/旅行标题/), 'Test');
    await user.click(screen.getByRole('button', { name: /创建旅行/ }));

    await waitFor(() => {
      expect(screen.getByText('旅行标题不能为空')).toBeDefined();
    });
  });

  it('does not submit when title is empty even if form submit is triggered', () => {
    render(<TripCreateForm />);
    const form = screen.getByRole('form');
    fireEvent.submit(form);
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });
});
