import { useCallback, useEffect, useState } from 'react';
import {
  AdminAccountPublic,
  clearAdminSession,
  hydrateAdminSession,
  resolveAdminApiUrl
} from '../utils/adminSession';

export interface UseAdminSessionState {
  apiUrl: string;
  authChecked: boolean;
  status: 'authenticated' | 'unauthenticated' | 'forbidden' | 'service_unavailable';
  admin: AdminAccountPublic | null;
  token: string | null;
  errorMessage: string | null;
  refresh: () => Promise<void>;
  logout: (notice?: string) => void;
  acceptLogin: (payload: { token: string; admin: AdminAccountPublic }) => void;
}

export function useAdminSession(): UseAdminSessionState {
  const apiUrl = resolveAdminApiUrl();
  const [authChecked, setAuthChecked] = useState(false);
  const [status, setStatus] = useState<
    'authenticated' | 'unauthenticated' | 'forbidden' | 'service_unavailable'
  >('unauthenticated');
  const [admin, setAdmin] = useState<AdminAccountPublic | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await hydrateAdminSession({ apiUrl });
    setStatus(res.status);
    setAdmin(res.admin);
    setToken(res.token);
    setErrorMessage(res.errorMessage);
    setAuthChecked(true);
  }, [apiUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback((notice?: string) => {
    clearAdminSession();
    setAdmin(null);
    setToken(null);
    setStatus('unauthenticated');
    setErrorMessage(typeof notice === 'string' && notice.trim() ? notice.trim() : null);
  }, []);

  const acceptLogin = useCallback((payload: { token: string; admin: AdminAccountPublic }) => {
    setToken(payload.token);
    setAdmin(payload.admin);
    setStatus('authenticated');
    setErrorMessage(null);
    setAuthChecked(true);
  }, []);

  return {
    apiUrl,
    authChecked,
    status,
    admin,
    token,
    errorMessage,
    refresh,
    logout,
    acceptLogin
  };
}
