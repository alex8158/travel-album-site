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
vi.mock('./pages/LoginPage', () => ({
  default: () => <div data-testid="login-page">LoginPage</div>,
}));
vi.mock('./pages/RegisterPage', () => ({
  default: () => <div data-testid="register-page">RegisterPage</div>,
}));
vi.mock('./pages/UserSpacePage', () => ({
  default: () => <div data-testid="user-space-page">UserSpacePage</div>,
}));
vi.mock('./pages/AdminPage', () => ({
  default: () => <div data-testid="admin-page">AdminPage</div>,
}));
vi.mock('./pages/MyGalleryPage', () => ({
  default: () => <div data-testid="my-gallery-page">MyGalleryPage</div>,
}));
vi.mock('./pages/AdminUserTripsPage', () => ({
  default: () => <div data-testid="admin-user-trips-page">AdminUserTripsPage</div>,
}));

// Mock AuthContext to control login state
const mockLogout = vi.fn();
let mockAuthValue = {
  token: null as string | null,
  user: null as { userId: string; username: string; role: 'admin' | 'regular' } | null,
  isLoggedIn: false,
  login: vi.fn(),
  logout: mockLogout,
  register: vi.fn(),
};

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => mockAuthValue,
}));

function setLoggedOut() {
  mockAuthValue = {
    token: null,
    user: null,
    isLoggedIn: false,
    login: vi.fn(),
    logout: mockLogout,
    register: vi.fn(),
  };
}

function setLoggedInRegular(username = 'testuser') {
  mockAuthValue = {
    token: 'fake-token',
    user: { userId: '1', username, role: 'regular' },
    isLoggedIn: true,
    login: vi.fn(),
    logout: mockLogout,
    register: vi.fn(),
  };
}

function setLoggedInAdmin(username = 'admin') {
  mockAuthValue = {
    token: 'fake-token',
    user: { userId: '1', username, role: 'admin' },
    isLoggedIn: true,
    login: vi.fn(),
    logout: mockLogout,
    register: vi.fn(),
  };
}

describe('App routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedOut();
    window.history.pushState({}, '', '/');
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

  it('renders /my/trips/:id route with MyGalleryPage', () => {
    setLoggedInRegular();
    window.history.pushState({}, '', '/my/trips/abc123');
    render(<App />);
    expect(screen.getByTestId('my-gallery-page')).toBeDefined();
  });

  it('renders /admin/users/:userId/trips route with AdminUserTripsPage', () => {
    setLoggedInAdmin();
    window.history.pushState({}, '', '/admin/users/user-1/trips');
    render(<App />);
    expect(screen.getByTestId('admin-user-trips-page')).toBeDefined();
  });
});

describe('NavHeader - not logged in (public page)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedOut();
    window.history.pushState({}, '', '/');
  });

  it('shows only "登录" and "注册" buttons when not logged in', () => {
    render(<App />);
    expect(screen.getByText('登录')).toBeDefined();
    expect(screen.getByText('注册')).toBeDefined();
  });

  it('hides "新建旅行" when not logged in', () => {
    render(<App />);
    expect(screen.queryByText('+ 新建旅行')).toBeNull();
  });

  it('hides "退出" when not logged in', () => {
    render(<App />);
    expect(screen.queryByText('退出')).toBeNull();
  });

  it('hides "设置" when not logged in on public page', () => {
    render(<App />);
    expect(screen.queryByText('设置')).toBeNull();
  });

  it('hides "我的空间" when not logged in', () => {
    render(<App />);
    expect(screen.queryByText('我的空间')).toBeNull();
  });

  it('navigates to LoginPage when clicking "登录"', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('登录'));
    expect(screen.getByTestId('login-page')).toBeDefined();
  });

  it('navigates to RegisterPage when clicking "注册"', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('注册'));
    expect(screen.getByTestId('register-page')).toBeDefined();
  });
});

describe('NavHeader - logged in regular user on public page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedInRegular('alice');
    window.history.pushState({}, '', '/');
  });

  it('shows username, "我的空间", and "退出"', () => {
    render(<App />);
    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.getByText('我的空间')).toBeDefined();
    expect(screen.getByText('退出')).toBeDefined();
  });

  it('hides "设置" and "新建旅行" on public page', () => {
    render(<App />);
    expect(screen.queryByText('设置')).toBeNull();
    expect(screen.queryByText('+ 新建旅行')).toBeNull();
  });

  it('hides "登录" and "注册" when logged in', () => {
    render(<App />);
    expect(screen.queryByText('登录')).toBeNull();
    expect(screen.queryByText('注册')).toBeNull();
  });

  it('navigates to UserSpacePage when clicking "我的空间"', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('我的空间'));
    expect(screen.getByTestId('user-space-page')).toBeDefined();
  });

  it('calls logout and navigates home when clicking "退出"', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('退出'));
    expect(mockLogout).toHaveBeenCalled();
  });
});

describe('NavHeader - logged in regular user on user space', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedInRegular('alice');
    window.history.pushState({}, '', '/my');
  });

  it('shows "设置" and "新建旅行" in user space', () => {
    render(<App />);
    expect(screen.getByText('设置')).toBeDefined();
    expect(screen.getByText('+ 新建旅行')).toBeDefined();
  });

  it('shows username, "我的空间", and "退出" in user space', () => {
    render(<App />);
    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.getByText('我的空间')).toBeDefined();
    expect(screen.getByText('退出')).toBeDefined();
  });

  it('does not show "会员管理" for regular user', () => {
    render(<App />);
    expect(screen.queryByText('会员管理')).toBeNull();
  });
});

describe('NavHeader - logged in admin on user space', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedInAdmin('admin');
    window.history.pushState({}, '', '/my');
  });

  it('shows "会员管理" for admin in user space', () => {
    render(<App />);
    expect(screen.getByText('会员管理')).toBeDefined();
  });

  it('shows all user space elements plus admin entry', () => {
    render(<App />);
    expect(screen.getByText('admin')).toBeDefined();
    expect(screen.getByText('我的空间')).toBeDefined();
    expect(screen.getByText('退出')).toBeDefined();
    expect(screen.getByText('+ 新建旅行')).toBeDefined();
    expect(screen.getByText('设置')).toBeDefined();
    expect(screen.getByText('会员管理')).toBeDefined();
  });

  it('navigates to AdminPage when clicking "会员管理"', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('会员管理'));
    expect(screen.getByTestId('admin-page')).toBeDefined();
  });
});

describe('NavHeader - admin on public page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoggedInAdmin('admin');
    window.history.pushState({}, '', '/');
  });

  it('hides "会员管理" on public page even for admin', () => {
    render(<App />);
    expect(screen.queryByText('会员管理')).toBeNull();
  });

  it('hides "设置" and "新建旅行" on public page for admin', () => {
    render(<App />);
    expect(screen.queryByText('设置')).toBeNull();
    expect(screen.queryByText('+ 新建旅行')).toBeNull();
  });
});
