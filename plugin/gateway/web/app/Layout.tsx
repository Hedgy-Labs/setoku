// SPDX-License-Identifier: Apache-2.0
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./auth";
import { Brand } from "./components/Brand";
import { cn } from "./cn";

const TABS: { to: string; label: string }[] = [
  { to: "/", label: "Pending" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/sources", label: "Sources" },
  { to: "/team", label: "Team" },
  { to: "/audit", label: "Audit" },
];

/** Signed-in chrome: sticky top bar (brand, nav, identity, sign-out) + content. */
export function Layout() {
  const { me, logout } = useAuth();
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <NavLink to="/" aria-label="Setoku">
            <Brand className="text-2xl" />
          </NavLink>
          <nav className="flex items-center gap-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.to === "/"}
                className={({ isActive }) => cn("tab", isActive && "tab-active")}
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-stone-500 sm:inline">
              {me?.identity} · {me?.role}
            </span>
            <button className="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <Outlet />
      </main>
    </>
  );
}
