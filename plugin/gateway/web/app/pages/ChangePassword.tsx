// SPDX-License-Identifier: Apache-2.0
import { useAuth } from "../auth";
import { Brand } from "../components/Brand";
import { ChangePasswordForm } from "../components/ChangePasswordForm";

/**
 * The forced first-sign-in gate (#73): a temp (admin-minted) password signs in
 * but lands here — nothing else renders until the person picks their own
 * password. Mirrors the Login card so the handoff feels like one flow.
 */
export function ForcePasswordChange() {
  const { me, logout, passwordChanged } = useAuth();
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm p-7">
        <h1 className="mb-5">
          <Brand className="text-3xl" />
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-stone-600">
          The password you signed in with was set by an admin. Choose your own to
          continue — the shared one stops working, everywhere.
        </p>
        <ChangePasswordForm onDone={passwordChanged} />
        <button
          className="mt-4 w-full text-center text-xs text-stone-500 hover:text-stone-700"
          type="button"
          onClick={() => void logout()}
        >
          Sign out{me ? ` (${me.identity})` : ""}
        </button>
      </div>
    </main>
  );
}
