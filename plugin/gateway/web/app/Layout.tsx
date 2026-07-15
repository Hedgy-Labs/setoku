// SPDX-License-Identifier: Apache-2.0
import { Menu as BaseMenu } from "@base-ui-components/react/menu";
import { Dialog } from "@base-ui-components/react/dialog";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { useApi } from "./hooks";
import { useAuth } from "./auth";
import { Brand } from "./components/Brand";
import { ChangePasswordForm } from "./components/ChangePasswordForm";
import { toast } from "./components/Toast";
import { cn } from "./cn";
import type { Correction } from "./types";

// Ordered by how often a human actually visits. Knowledge (the agent-facing
// store + its review queue) sits after Apps and carries a pending-count badge
// so curators still get pulled in without the tab needing top billing.
const TABS: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: "/", label: "Apps" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/sources", label: "Sources" },
  { to: "/team", label: "Team" },
  // The audit trail is admin-only server-side (its payloads carry doc names/SQL),
  // so the tab is admin-only too — else members get a dead 403 page.
  { to: "/audit", label: "Audit", adminOnly: true },
];

/** Tabs visible to a given role. */
const tabsFor = (role: string): typeof TABS => TABS.filter((t) => !t.adminOnly || role === "admin");

/** Count chip on the Knowledge tab: proposals waiting for review. */
function PendingBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="ml-1.5 rounded-full bg-stone-300 px-1.5 py-px text-[10px] font-semibold tabular-nums text-stone-700">
      {n}
    </span>
  );
}

/** Signed-in chrome: sticky top bar (brand, nav, identity, sign-out) + content. */
export function Layout() {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const [pwOpen, setPwOpen] = useState(false);
  // refreshed on every navigation, so approving/rejecting updates the badge
  const { data: queue } = useApi<Correction[]>(() => api.pending(), [pathname]);
  const pending = queue?.length ?? 0;
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-x-4 px-5 py-3">
          <NavLink to="/" aria-label="Setoku">
            <Brand className="gap-1 text-xl" />
          </NavLink>

          {/* wide screens: inline tabs + identity + sign-out */}
          <nav className="hidden items-center gap-1 md:flex">
            {tabsFor(me?.role ?? "").map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.to === "/"}
                className={({ isActive }) => cn("tab", isActive && "tab-active")}
              >
                {t.label}
                {t.to === "/knowledge" ? <PendingBadge n={pending} /> : null}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto hidden md:block">
            <AccountMenu
              identity={me?.identity ?? ""}
              role={me?.role ?? ""}
              onChangePassword={() => setPwOpen(true)}
              onSignOut={() => void logout()}
            />
          </div>

          {/* small screens: everything collapses into a hamburger */}
          <div className="ml-auto md:hidden">
            <MobileNav
              identity={me?.identity ?? ""}
              role={me?.role ?? ""}
              pending={pending}
              onChangePassword={() => setPwOpen(true)}
              onSignOut={() => void logout()}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <Outlet />
      </main>
      <ChangePasswordDialog
        open={pwOpen}
        onClose={() => setPwOpen(false)}
        onChanged={() => {
          setPwOpen(false);
          toast("Password changed — your other sessions were signed out.");
        }}
      />
    </>
  );
}

/** Account-menu password change (#73): the same form the forced gate uses. */
function ChangePasswordDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-stone-900/20 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-stone-200 bg-white p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold text-stone-900">Change password</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
            Your other sessions will be signed out.
          </Dialog.Description>
          <div className="mt-4">
            {/* the portal unmounts on close, so a reopened dialog starts blank */}
            <ChangePasswordForm onDone={onChanged} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Wide-screen account control: a quiet identity button opening a menu with role + sign-out. */
function AccountMenu({
  identity,
  role,
  onChangePassword,
  onSignOut,
}: {
  identity: string;
  role: string;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className="group inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-stone-500 outline-none transition hover:bg-stone-100 hover:text-stone-800 data-[popup-open]:bg-stone-100 data-[popup-open]:text-stone-800">
        <span className="max-w-[16rem] truncate">{identity}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-stone-400 transition-transform group-data-[popup-open]:rotate-180"
          aria-hidden="true"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner align="end" sideOffset={6} className="z-30">
          <BaseMenu.Popup className="min-w-[12rem] overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
            <div className="px-3 py-2">
              <div className="truncate text-sm font-medium text-stone-900">{identity}</div>
              <div className="text-xs text-stone-500">{role}</div>
            </div>
            <BaseMenu.Separator className="my-1 h-px bg-stone-200" />
            <BaseMenu.Item className="menu-item" onClick={onChangePassword}>
              Change password
            </BaseMenu.Item>
            <BaseMenu.Item className="menu-item" onClick={onSignOut}>
              Sign out
            </BaseMenu.Item>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** The small-width nav: a hamburger opening the tabs + identity + sign-out. */
function MobileNav({
  identity,
  role,
  pending,
  onChangePassword,
  onSignOut,
}: {
  identity: string;
  role: string;
  pending: number;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isActive = (to: string): boolean => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger className="icon-btn" aria-label="Menu">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 5h12M3 9h12M3 13h12" />
        </svg>
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner align="end" sideOffset={6} className="z-30">
          <BaseMenu.Popup className="min-w-[12rem] overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
            {tabsFor(role).map((t) => (
              <BaseMenu.Item
                key={t.to}
                className={cn("menu-item", isActive(t.to) && "bg-stone-100 text-stone-900")}
                onClick={() => navigate(t.to)}
              >
                {t.label}
                {t.to === "/knowledge" ? <PendingBadge n={pending} /> : null}
              </BaseMenu.Item>
            ))}
            <BaseMenu.Separator className="my-1 h-px bg-stone-200" />
            <div className="px-3 py-1 text-xs text-stone-500">
              {identity} · {role}
            </div>
            <BaseMenu.Item className="menu-item" onClick={onChangePassword}>
              Change password
            </BaseMenu.Item>
            <BaseMenu.Item className="menu-item" onClick={onSignOut}>
              Sign out
            </BaseMenu.Item>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
