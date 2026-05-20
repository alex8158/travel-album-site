import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import HomePage from './pages/HomePage';
import GalleryPage from './pages/GalleryPage';
import UploadPage from './pages/UploadPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import UserSpacePage from './pages/UserSpacePage';
import AdminPage from './pages/AdminPage';
import MyGalleryPage from './pages/MyGalleryPage';
import AdminUserTripsPage from './pages/AdminUserTripsPage';

function NavHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoggedIn, user, logout } = useAuth();

  const isUserSpace =
    location.pathname.startsWith('/my') ||
    location.pathname === '/upload' ||
    location.pathname.startsWith('/admin') ||
    location.pathname === '/settings';

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <header className="navbar">
      <Link to="/" className="nav-brand">
        🌍 旅行相册
      </Link>
      <div className="nav-links">
        {isLoggedIn && user ? (
          <>
            <span style={{ fontSize: '0.9rem', color: 'var(--color-text)' }}>{user.username}</span>
            <Link to="/my">
              我的空间
            </Link>
            {isUserSpace && (
              <>
                <Link to="/settings">
                  设置
                </Link>
                {user.role === 'admin' && (
                  <Link to="/admin">
                    会员管理
                  </Link>
                )}
                <Link to="/upload" className="nav-btn-primary">
                  + 新建旅行
                </Link>
              </>
            )}
            <button
              onClick={handleLogout}
              className="nav-logout"
            >
              退出
            </button>
          </>
        ) : (
          <>
            <Link
              to={isUserSpace ? '/login' : `/login?returnTo=${encodeURIComponent(location.pathname)}`}
            >
              登录
            </Link>
            <Link to="/register">
              注册
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NavHeader />
        <main>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/trips/:id" element={<GalleryPage />} />
            <Route path="/upload" element={<ProtectedRoute><UploadPage /></ProtectedRoute>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/my" element={<ProtectedRoute><UserSpacePage /></ProtectedRoute>} />
            <Route path="/my/trips/:id" element={<ProtectedRoute><MyGalleryPage /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute requireAdmin><AdminPage /></ProtectedRoute>} />
            <Route path="/admin/users/:userId/trips" element={<ProtectedRoute requireAdmin><AdminUserTripsPage /></ProtectedRoute>} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
