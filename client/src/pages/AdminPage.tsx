import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { authFetch } from '../contexts/AuthContext';

interface User {
  id: string;
  username: string;
  role: 'admin' | 'regular';
  status: 'active' | 'pending' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface StorageProviderStatus {
  type: string;
  label: string;
  configured: boolean;
  missing: string[];
}

interface StorageStatus {
  currentType: string;
  providers: StorageProviderStatus[];
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // Storage state
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [targetType, setTargetType] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState('');

  // Reset password state
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

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

  const fetchStorageStatus = useCallback(async () => {
    try {
      const res = await authFetch('/api/admin/storage/status');
      if (!res.ok) return;
      const data: StorageStatus = await res.json();
      setStorageStatus(data);
      // Default target to first configured provider that isn't current
      const available = data.providers.filter(p => p.configured && p.type !== data.currentType);
      if (available.length > 0 && !targetType) {
        setTargetType(available[0].type);
      }
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchUsers(); fetchStorageStatus(); }, [fetchUsers, fetchStorageStatus]);

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

  return (
    <div className="page-container" style={{ maxWidth: '960px' }}>
      <div className="page-header">
        <h1>管理后台</h1>
      </div>

      {actionMsg && (
        <div style={{ padding: '8px 12px', marginBottom: '12px', background: '#f0f0f0', borderRadius: '4px' }}>
          {actionMsg}
        </div>
      )}

      {/* User Management */}
      <section>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>用户管理</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.role === 'admin' ? '管理员' : '普通用户'}</td>
                <td>
                  <span className={`badge ${u.status === 'active' ? 'badge-success' : u.status === 'pending' ? 'badge-warning' : 'badge-danger'}`}>
                    {u.status === 'active' ? '活跃' : u.status === 'pending' ? '待审批' : '已禁用'}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <Link
                    to={`/admin/users/${u.id}/trips`}
                    style={{ textDecoration: 'none', color: '#4a90d9', fontSize: '0.85rem' }}
                  >
                    查看相册
                  </Link>
                  {u.status === 'pending' && (
                    <>
                      <button className="btn-primary" style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => handleAction(`/api/admin/users/${u.id}/approve`, 'PUT')}>
                        通过
                      </button>
                      <button style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => handleAction(`/api/admin/users/${u.id}/reject`, 'PUT')}>
                        拒绝
                      </button>
                    </>
                  )}
                  {u.role !== 'admin' && u.status === 'active' && (
                    <button style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => handleAction(`/api/admin/users/${u.id}/promote`, 'PUT')}>
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
                        className="form-input"
                        style={{ width: '120px', padding: '2px 6px' }}
                      />
                      <button className="btn-primary" style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => handleResetPassword(u.id)}>确认</button>
                      <button style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => { setResetUserId(null); setNewPassword(''); }}>取消</button>
                    </span>
                  ) : (
                    <button style={{ padding: '2px 8px', fontSize: '0.8rem' }} onClick={() => setResetUserId(u.id)}>重置密码</button>
                  )}
                  {u.status !== 'disabled' && (
                    <button
                      className="btn-danger"
                      style={{ padding: '2px 8px', fontSize: '0.8rem' }}
                      onClick={() => handleAction(`/api/admin/users/${u.id}`, 'DELETE')}
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
      <section>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>存储管理</h2>

        {storageStatus ? (
          <>
            <p style={{ marginBottom: '16px' }}>
              当前存储类型：<strong>{storageStatus.providers.find(p => p.type === storageStatus.currentType)?.label || storageStatus.currentType}</strong>
            </p>

            <h3 style={{ fontSize: '0.95rem', marginBottom: '8px' }}>存储配置状态</h3>
            <table className="data-table" style={{ marginBottom: '16px' }}>
              <thead>
                <tr>
                  <th>存储类型</th>
                  <th>状态</th>
                  <th>缺少的环境变量</th>
                </tr>
              </thead>
              <tbody>
                {storageStatus.providers.map((p) => (
                  <tr key={p.type} style={p.type === storageStatus.currentType ? { background: '#f0f7ff' } : undefined}>
                    <td>
                      {p.label}
                      {p.type === storageStatus.currentType && <span className="badge badge-info" style={{ marginLeft: '6px' }}>当前</span>}
                    </td>
                    <td>
                      {p.configured
                        ? <span className="badge badge-success">✅ 已配置</span>
                        : <span className="badge badge-warning">⚠️ 未配置</span>
                      }
                    </td>
                    <td style={{ color: '#999', fontSize: '0.85rem' }}>
                      {p.missing.length > 0 ? p.missing.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 style={{ fontSize: '0.95rem', marginBottom: '8px' }}>存储迁移</h3>
            {(() => {
              const available = storageStatus.providers.filter(p => p.configured && p.type !== storageStatus.currentType);
              if (available.length === 0) {
                return <p style={{ color: '#999', fontSize: '0.9rem' }}>没有其他已配置的存储可供迁移。请在服务器上设置对应的环境变量后重启服务。</p>;
              }
              return (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <label>
                    迁移到：
                    <select
                      value={targetType}
                      onChange={(e) => setTargetType(e.target.value)}
                      style={{ marginLeft: '8px', padding: '4px 8px' }}
                    >
                      {available.map((p) => (
                        <option key={p.type} value={p.type}>{p.label}</option>
                      ))}
                    </select>
                  </label>
                  <button onClick={handleMigrate} disabled={migrating}>
                    {migrating ? '迁移中...' : '开始迁移'}
                  </button>
                </div>
              );
            })()}
          </>
        ) : (
          <p style={{ color: '#999' }}>加载存储配置中...</p>
        )}

        {migrateResult && (
          <p style={{ marginTop: '8px', color: migrateResult.includes('失败') && !migrateResult.includes('成功') ? '#d32f2f' : '#333' }}>
            {migrateResult}
          </p>
        )}
      </section>
    </div>
  );
}
