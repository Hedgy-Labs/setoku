// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setCsrf, setUnauthorizedHandler } from "./api";
import type { Me } from "./types";

interface AuthValue {
  me: Me | null;
  loading: boolean;
  /** true when a previously-signed-in session expired (drives the login notice). */
  expired: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Resolves the current session once on mount; exposes login/logout. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  // mirror `me` into a ref so the (mount-once) 401 handler reads the live value
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  // Any 401 from the JSON API means the session is gone — drop to the login
  // screen instead of leaving signed-in chrome over a dead session. Flag
  // "expired" only when we WERE signed in (not the logged-out initial load).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (meRef.current) setExpired(true);
      setMe(null);
      setCsrf("");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    api
      .session()
      .then((m) => {
        setMe(m);
        setCsrf(m.csrf);
        setExpired(false);
      })
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string): Promise<void> => {
    const r = await api.login(username, password);
    setCsrf(r.csrf);
    setExpired(false);
    setMe({ identity: r.identity, role: r.role, csrf: r.csrf });
  };

  const logout = async (): Promise<void> => {
    await api.logout();
    setMe(null);
  };

  return (
    <AuthContext.Provider value={{ me, loading, expired, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used within <AuthProvider>");
  return v;
}
