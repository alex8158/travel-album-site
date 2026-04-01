import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

// Mock page components to isolate routing logic
vi.mock('./pages/HomePage', () => ({
  default: () => <div data-testid="home-page">HomePage</div>,
}));
vi.mock('./pages/GalleryPage', () => ({
  default: () => <div data-testid="gallery-page">GalleryPage</div>,
}));
vi.mock('./pages/UploadPage', () => ({
  default: () => <div data-testid="upload-page">UploadPage</div>,
}));
vi.mock('./pages/SettingsPage', () => ({
  default: () => <div data-testid="settings-page">SettingsPage</div>,
}));

describe('App routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders HomePage at /', () => {
    render(<App />);
    expect(screen.getByTestId('home-page')).toBeDefined();
  });

  it('renders navigation header with site title link', () => {
    render(<App />);
    const titleLink = screen.getByText('🌍 旅行相册');
    expect(titleLink).toBeDefined();
    expect(titleLink.closest('a')).toHaveAttribute('href', '/');
  });

  it('renders "新建旅行" link in header', () => {
    render(<App />);
    const uploadLink = screen.getByText('+ 新建旅行');
    expect(uploadLink).toHaveAttribute('href', '/upload');
  });

  it('navigates to UploadPage when clicking "新建旅行"', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByText('+ 新建旅行'));
    expect(screen.getByTestId('upload-page')).toBeDefined();
  });

  it('navigates back to HomePage when clicking site title', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Go to upload page first
    await user.click(screen.getByText('+ 新建旅行'));
    expect(screen.getByTestId('upload-page')).toBeDefined();

    // Click site title to go back
    await user.click(screen.getByText('🌍 旅行相册'));
    expect(screen.getByTestId('home-page')).toBeDefined();
  });

  it('shows "返回首页" link when not on home page', async () => {
    const user = userEvent.setup();
    render(<App />);

    // On home page, no back link
    expect(screen.queryByText('← 返回首页')).toBeNull();

    // Navigate away
    await user.click(screen.getByText('+ 新建旅行'));
    expect(screen.getByText('← 返回首页')).toBeDefined();
  });

  it('renders "设置" link in header pointing to /settings', () => {
    render(<App />);
    const settingsLink = screen.getByText('设置');
    expect(settingsLink).toBeDefined();
    expect(settingsLink.closest('a')).toHaveAttribute('href', '/settings');
  });

  it('navigates to SettingsPage when clicking "设置"', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByText('设置'));
    expect(screen.getByTestId('settings-page')).toBeDefined();
  });
});
