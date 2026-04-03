import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(username, password);
      navigate('/');
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'ACCOUNT_PENDING') {
        setError('账户正在等待管理员审批');
      } else if (code === 'ACCOUNT_DISABLED') {
        setError('账户已被禁用');
      } else if (code === 'INVALID_CREDENTIALS') {
        setError('用户名或密码错误');
      } else {
        setError('登录失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: '400px', margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '24px', textAlign: 'center' }}>登录</h1>

      {error && (
        <div role="alert" style={{ color: '#d32f2f', marginBottom: '16px', fontSize: '0.9rem', textAlign: 'center' }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="username" style={{ display: 'block', marginBottom: '4px', fontSize: '0.9rem' }}>
            用户名
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            style={{ width: '100%', padding: '8px', fontSize: '1rem', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label htmlFor="password" style={{ display: 'block', marginBottom: '4px', fontSize: '0.9rem' }}>
            密码
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{ width: '100%', padding: '8px', fontSize: '1rem', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '1rem',
            color: '#fff',
            backgroundColor: loading ? '#999' : '#4a90d9',
            border: 'none',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '登录中...' : '登录'}
        </button>
      </form>

      <p style={{ marginTop: '16px', textAlign: 'center', fontSize: '0.9rem', color: '#666' }}>
        还没有账户？<Link to="/register" style={{ color: '#4a90d9' }}>注册</Link>
      </p>
    </div>
  );
}
