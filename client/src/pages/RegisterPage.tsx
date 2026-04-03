import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const { register } = useAuth();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    if (password.length < 6) {
      setError('密码长度至少为 6 个字符');
      return;
    }

    setLoading(true);

    try {
      await register(username, password);
      setSuccess(true);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'USERNAME_TAKEN') {
        setError('用户名已被占用');
      } else if (code === 'VALIDATION_ERROR') {
        setError('输入信息不符合要求');
      } else {
        setError('注册失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div style={{ maxWidth: '400px', margin: '80px auto', padding: '0 16px', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '16px' }}>注册成功</h1>
        <p style={{ color: '#666', marginBottom: '24px' }}>
          您的账户正在等待管理员审批，审批通过后即可登录。
        </p>
        <Link to="/login" style={{ color: '#4a90d9', fontSize: '0.9rem' }}>
          返回登录
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '400px', margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '24px', textAlign: 'center' }}>注册</h1>

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

        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="password" style={{ display: 'block', marginBottom: '4px', fontSize: '0.9rem' }}>
            密码
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            style={{ width: '100%', padding: '8px', fontSize: '1rem', border: '1px solid #ccc', borderRadius: '4px', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '24px' }}>
          <label htmlFor="confirmPassword" style={{ display: 'block', marginBottom: '4px', fontSize: '0.9rem' }}>
            确认密码
          </label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
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
          {loading ? '提交中...' : '注册'}
        </button>
      </form>

      <p style={{ marginTop: '16px', textAlign: 'center', fontSize: '0.9rem', color: '#666' }}>
        已有账户？<Link to="/login" style={{ color: '#4a90d9' }}>登录</Link>
      </p>
    </div>
  );
}
