// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../api";
import { MIN_PASSWORD_LENGTH } from "../types";
import { FormError } from "./FormError";

/**
 * Self-service password change (#73). Used in two places: the forced gate a
 * temp-password login lands on, and the account menu's dialog. The server
 * always verifies the current password before committing (I9); `current`
 * supplies it silently when the caller already holds it (the forced gate has
 * the just-verified login password — no retyping the temp password). If that
 * stashed value is rejected anyway (admin reset raced us), the field appears.
 */
export function ChangePasswordForm({ current, onDone }: { current?: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askCurrent, setAskCurrent] = useState(!current);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = String(form.get("next") ?? "");
    if (next !== String(form.get("confirm") ?? "")) {
      setError("New passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(askCurrent ? String(form.get("current") ?? "") : (current ?? ""), next);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed.");
      if (err instanceof ApiError && err.status === 403) setAskCurrent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error ? <FormError>{error}</FormError> : null}
      {askCurrent ? (
        <input
          className="input"
          type="password"
          name="current"
          placeholder="current password"
          autoComplete="current-password"
          autoFocus
          required
        />
      ) : null}
      <input
        className="input"
        type="password"
        name="next"
        placeholder={`new password (${MIN_PASSWORD_LENGTH}+ characters)`}
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        autoFocus={!askCurrent}
        required
      />
      <input
        className="input"
        type="password"
        name="confirm"
        placeholder="repeat new password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <button className="btn btn-primary w-full" type="submit" disabled={busy}>
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
