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

function NavHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const isHome = location.pathname === '/';
  const { isLoggedIn, user, logout } = useAuth();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        borderBottom: '1px solid #eee',
        backgroundColor: '#fff',
      }}
    >
      <Link to="/" style={{ textDecoration: 'none', color: '#333', fontSize: '1.2rem', fontWeight: 'bold' }}>
        🌍 旅行相册
      </Link>
      {!isHome && (
        <Link to="/" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>
          ← 返回首页
        </Link>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <Link
          to="/settings"
          style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}
        >
          设置
        </Link>
        {isLoggedIn && user ? (
          <>
            <span style={{ fontSize: '0.9rem', color: '#333' }}>{user.username}</span>
            <Link to="/my" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>
              我的空间
            </Link>
            {user.role === 'admin' && (
              <Link to="/admin" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>
                管理后台
              </Link>
            )}
            <button
              onClick={handleLogout}
              style={{
                background: 'none',
                border: 'none',
                color: '#666',
                fontSize: '0.9rem',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              退出
            </button>
            <Link
              to="/upload"
              style={{
                textDecoration: 'none',
                color: '#fff',
                backgroundColor: '#4a90d9',
                padding: '6px 16px',
                borderRadius: '4px',
                fontSize: '0.9rem',
              }}
            >
              + 新建旅行
            </Link>
          </>
        ) : (
          <>
            <Link to="/login" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>
              登录
            </Link>
            <Link to="/register" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>
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
            <Route path="/admin" element={<ProtectedRoute requireAdmin><AdminPage /></ProtectedRoute>} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
