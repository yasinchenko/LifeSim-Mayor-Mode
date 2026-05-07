import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const STORAGE_KEY = "lifesim_admin_token";
const EXPIRES_KEY = "lifesim_admin_expires";

interface AdminContextValue {
  isAdmin: boolean;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const AdminContext = createContext<AdminContextValue>({
  isAdmin: false,
  login: async () => ({ success: false, error: "Not mounted" }),
  logout: () => {},
});

function loadStoredToken(): string | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    const e = localStorage.getItem(EXPIRES_KEY);
    if (t && e && Date.now() < parseInt(e, 10)) return t;
  } catch {}
  return null;
}

export function AdminProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const stored = loadStoredToken();
    if (stored) {
      setAuthTokenGetter(() => stored);
    }
    return stored;
  });

  useEffect(() => {
    if (token) {
      setAuthTokenGetter(() => token);
    } else {
      setAuthTokenGetter(null);
    }
  }, [token]);

  const login = useCallback(async (password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${base}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: (data as { error?: string }).error ?? "Ошибка входа" };
      }
      const data = await res.json() as { token: string; expiresAt: number };
      localStorage.setItem(STORAGE_KEY, data.token);
      localStorage.setItem(EXPIRES_KEY, String(data.expiresAt));
      setAuthTokenGetter(() => data.token);
      setToken(data.token);
      return { success: true };
    } catch {
      return { success: false, error: "Ошибка соединения" };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(EXPIRES_KEY);
    setAuthTokenGetter(null);
    setToken(null);
  }, []);

  return (
    <AdminContext.Provider value={{ isAdmin: token !== null, login, logout }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  return useContext(AdminContext);
}
