import { createContext, useState, useEffect, useContext, useCallback, useRef } from 'react';
import { socketService } from '../services/socketService';
import api from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const syncInFlight = useRef(false);

  /**
   * Re-sync the user profile from the backend.
   * This ensures the frontend role is always the DB truth,
   * preventing stale localStorage from causing RBAC mismatches.
   */
  const syncFromBackend = useCallback(async () => {
    if (syncInFlight.current) return;
    const token = localStorage.getItem('token');
    if (!token) return;

    syncInFlight.current = true;
    try {
      const res = await api.get('/auth/me');
      if (res.success && res.data?.user) {
        const freshUser = res.data.user;
        // Persist the authoritative user data back to localStorage
        localStorage.setItem('user', JSON.stringify(freshUser));
        setUser(freshUser);
      }
    } catch (err) {
      // If the token is invalid/expired, the 401 interceptor handles logout
      if (!err.isCancelled) {
        console.warn('Auth sync failed:', err.message);
      }
    } finally {
      syncInFlight.current = false;
    }
  }, []);

  /**
   * Re-hydrate auth state from localStorage.
   * This is the single source of truth for the frontend auth state.
   * On login, the login page writes to localStorage and dispatches
   * 'auth-change', which triggers this function.
   */
  const checkAuth = useCallback(() => {
    const storedUser = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    
    if (storedUser && token) {
      try {
        const parsedUser = JSON.parse(storedUser);
        // Ensure role fallback if missing
        if (!parsedUser.role) parsedUser.role = 'member';
        setUser(parsedUser);
      } catch (e) {
        console.error("Failed to parse user data", e);
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        setUser(null);
      }
    } else {
      setUser(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    checkAuth();
    // After initial hydration from localStorage, sync from backend
    // to get the authoritative role and notification count.
    syncFromBackend();

    const handleUnauthorized = () => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
    };

    /**
     * When 'auth-change' fires (after login/register), we:
     * 1. Re-read user from localStorage
     * 2. Reconnect the socket with the fresh JWT so real-time
     *    notifications are delivered to the correct user room
     * 3. Sync from backend to get authoritative role
     */
    const handleAuthChange = () => {
      checkAuth();
      // Reconnect socket with the fresh token so the server
      // authenticates this socket and joins the user room.
      const token = localStorage.getItem('token');
      if (token) {
        socketService.reconnect();
        // Sync authoritative user data from backend
        syncFromBackend();
      }
    };

    window.addEventListener('storage', checkAuth);
    window.addEventListener('auth-change', handleAuthChange);
    window.addEventListener('auth:unauthorized', handleUnauthorized);

    return () => {
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('auth-change', handleAuthChange);
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
    };
  }, [checkAuth, syncFromBackend]);

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    socketService.disconnect();
    window.location.href = '/';
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, role: user?.role || null }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuthContext = () => useContext(AuthContext);

