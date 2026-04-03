import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../contexts/AuthContext';

interface User {
  id: string;
  username: string;
  role: 'admin' | 'regular';
  status: 'active' | 'pending' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // Storage migration state
  const [targetType, setTargetType] = useState('s3');
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState('');

  // Reset password state
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const currentStorageType = 'local'; // default; server doesn't expose this yet

  const fetchUsers = useCallback(async () => {
    try {
      const res = await authFetch('/api/admin/users');
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch {
      setError('加载用户列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function handleAction(url: string, method: string, body?: object) {
    setActionMsg('');
    try {
      const res = await authFetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error?.message || d.message || '操作失败');
      }
      const d = await res.json();
      setActionMsg(d.message || '操作成功');
      fetchUsers();
    } catch (e: any) {
      setActionMsg(e.message || '操作失败');
    }
  }

  async function handleMigrate() {
    setMigrating(true);
    setMigrateResult('');
    try {
      const res = await authFetch('/api/admin/storage/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || '迁移失败');
      }
      const r = data.result;
      setMigrateResult(`迁移完成：成功 ${r.successCount} 个，失败 ${r.failedCount} 个`);
    } catch (e: any) {
      setMigrateResult(e.message || '迁移失败');
    } finally {
      setMigrating(false);
    }
  }

  async function handleResetPassword(userId: string) {
    if (!newPassword || newPassword.length < 6) {
      setActionMsg('新密码长度不能少于6个字符');
      return;
    }
    await handleAction(`/api/admin/users/${userId}/password`, 'PUT', { password: newPassword });
    setResetUserId(null);
    setNewPassword('');
  }

  if (loading) return <div role="status" aria-label="加载中">加载中...</div>;
  if (error) return <div role="alert">{error}</div>;

  const sectionStyle: React.CSSProperties = {
    marginBottom: '32px',
    border: '1px solid #eee',
    borderRadius: '8px',
    padding: '16px',
  };

  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '16px' }}>管理后台</h1>

      {actionMsg && (
        <div style={{ padding: '8px 12px', marginBottom: '12px', background: '#f0f0f0', borderRadius: '4px' }}>
          {actionMsg}
        </div>
      )}

      {/* User Management */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>用户管理</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
              <th style={{ padding: '8px' }}>用户名</th>
              <th style={{ padding: '8px' }}>角色</th>
              <th style={{ padding: '8px' }}>状态</th>
              <th style={{ padding: '8px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '8px' }}>{u.username}</td>
                <td style={{ padding: '8px' }}>{u.role === 'admin' ? '管理员' : '普通用户'}</td>
                <td style={{ padding: '8px' }}>
                  {u.status === 'active' ? '活跃' : u.status === 'pending' ? '待审批' : '已禁用'}
                </td>
                <td style={{ padding: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {u.status === 'pending' && (
                    <>
                      <button onClick={() => handleAction(`/api/admin/users/${u.id}/approve`, 'PUT')}>
                        通过
                      </button>
                      <button onClick={() => handleAction(`/api/admin/users/${u.id}/reject`, 'PUT')}>
                        拒绝
                      </button>
                    </>
                  )}
                  {u.role !== 'admin' && u.status === 'active' && (
                    <button onClick={() => handleAction(`/api/admin/users/${u.id}/promote`, 'PUT')}>
                      提升管理员
                    </button>
                  )}
                  {resetUserId === u.id ? (
                    <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input
                        type="password"
                        placeholder="新密码"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        style={{ width: '120px', padding: '2px 6px' }}
                      />
                      <button onClick={() => handleResetPassword(u.id)}>确认</button>
                      <button onClick={() => { setResetUserId(null); setNewPassword(''); }}>取消</button>
                    </span>
                  ) : (
                    <button onClick={() => setResetUserId(u.id)}>重置密码</button>
                  )}
                  {u.status !== 'disabled' && (
                    <button
                      onClick={() => handleAction(`/api/admin/users/${u.id}`, 'DELETE')}
                      style={{ color: '#d32f2f' }}
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Storage Management */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>存储管理</h2>
        <p style={{ marginBottom: '12px' }}>
          当前存储类型：<strong>{currentStorageType}</strong>
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label>
            迁移到：
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              style={{ marginLeft: '8px', padding: '4px 8px' }}
            >
              <option value="s3">AWS S3</option>
              <option value="oss">阿里 OSS</option>
              <option value="cos">腾讯 COS</option>
              <option value="local">本地存储</option>
            </select>
          </label>
          <button onClick={handleMigrate} disabled={migrating}>
            {migrating ? '迁移中...' : '开始迁移'}
          </button>
        </div>
        {migrateResult && (
          <p style={{ marginTop: '8px', color: migrateResult.includes('失败') && !migrateResult.includes('成功') ? '#d32f2f' : '#333' }}>
            {migrateResult}
          </p>
        )}
      </section>
    </div>
  );
}
