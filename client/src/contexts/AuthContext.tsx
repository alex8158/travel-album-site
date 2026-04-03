import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

interface AuthUser {
  userId: string;
  username: string;
  role: 'admin' | 'regular';
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isLoggedIn: boolean;
}

interface AuthContextValue extends AuthState {
  login(username: string, password: string): Promise<void>;
  logout(): void;
  register(username: string, password: string): Promise<void>;
}

const TOKEN_KEY = 'auth_token';

const AuthContext = createContext<AuthContextValue | null>(null);

/** Decode JWT payload without verifying signature (client-side only) */
function decodeJwtPayload(token: string): { userId: string; role: 'admin' | 'regular' } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.userId || !payload.role) return null;
    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return { userId: payload.userId, role: payload.role };
  } catch {
    return null;
  }
}

function restoreAuthState(): AuthState {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return { token: null, user: null, isLoggedIn: false };

  const payload = decodeJwtPayload(token);
  if (!payload) {
    localStorage.removeItem(TOKEN_KEY);
    return { token: null, user: null, isLoggedIn: false };
  }

  // We don't have the username stored separately, so we store it alongside the token
  const username = localStorage.getItem('auth_username') || '';
  return {
    token,
    user: { userId: payload.userId, username, role: payload.role },
    isLoggedIn: true,
  };
}

/** Wrapper around fetch that automatically adds Authorization header */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(restoreAuthState);

  // Re-check token validity on mount
  useEffect(() => {
    if (state.token) {
      const payload = decodeJwtPayload(state.token);
      if (!payload) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('auth_username');
        setState({ token: null, user: null, isLoggedIn: false });
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.code || body.message || 'Login failed');
    }

    const data = await res.json();
    const token: string = data.token;
    const user: AuthUser = {
      userId: data.user.id,
      username: data.user.username,
      role: data.user.role as 'admin' | 'regular',
    };

    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('auth_username', user.username);
    setState({ token, user, isLoggedIn: true });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('auth_username');
    setState({ token: null, user: null, isLoggedIn: false });
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.code || body.message || 'Registration failed');
    }
    // Register doesn't auto-login; user is pending approval
  }, []);

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    register,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export { AuthContext };
export type { AuthUser, AuthState, AuthContextValue };
