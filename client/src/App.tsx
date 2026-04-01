import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import GalleryPage from './pages/GalleryPage';
import UploadPage from './pages/UploadPage';
import SettingsPage from './pages/SettingsPage';

function NavHeader() {
  const location = useLocation();
  const isHome = location.pathname === '/';

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
      </div>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <NavHeader />
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/trips/:id" element={<GalleryPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

export default App;
