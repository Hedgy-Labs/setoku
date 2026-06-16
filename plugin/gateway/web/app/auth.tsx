// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setCsrf } from "./api";
import type { Me } from "./types";

interface AuthValue {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Resolves the current session once on mount; exposes login/logout. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .session()
      .then((m) => {
        setMe(m);
        setCsrf(m.csrf);
      })
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string): Promise<void> => {
    const r = await api.login(username, password);
    setCsrf(r.csrf);
    setMe({ identity: r.identity, role: r.role, csrf: r.csrf });
  };

  const logout = async (): Promise<void> => {
    await api.logout();
    setMe(null);
  };

  return <AuthContext.Provider value={{ me, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used within <AuthProvider>");
  return v;
}
