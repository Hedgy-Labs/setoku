// SPDX-License-Identifier: Apache-2.0
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
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
        <div className="mx-auto flex max-w-4xl items-center gap-x-4 px-5 py-3">
          <NavLink to="/" aria-label="Setoku">
            <Brand className="text-2xl" />
          </NavLink>

          {/* wide screens: inline tabs + identity + sign-out */}
          <nav className="hidden items-center gap-1 md:flex">
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
          <div className="ml-auto hidden items-center gap-3 md:flex">
            <span className="text-xs text-stone-500">
              {me?.identity} · {me?.role}
            </span>
            <button className="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>

          {/* small screens: everything collapses into a hamburger */}
          <div className="ml-auto md:hidden">
            <MobileNav identity={me?.identity ?? ""} role={me?.role ?? ""} onSignOut={() => void logout()} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <Outlet />
      </main>
    </>
  );
}

/** The small-width nav: a hamburger opening the tabs + identity + sign-out. */
function MobileNav({ identity, role, onSignOut }: { identity: string; role: string; onSignOut: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isActive = (to: string): boolean => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-btn" aria-label="Menu">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5h12M3 9h12M3 13h12" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-30 min-w-[12rem] overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
        >
          {TABS.map((t) => (
            <DropdownMenu.Item
              key={t.to}
              className={cn("menu-item", isActive(t.to) && "bg-stone-100 text-stone-900")}
              onSelect={() => navigate(t.to)}
            >
              {t.label}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-stone-200" />
          <div className="px-3 py-1 text-xs text-stone-500">
            {identity} · {role}
          </div>
          <DropdownMenu.Item className="menu-item" onSelect={onSignOut}>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
