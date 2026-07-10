// SPDX-License-Identifier: Apache-2.0
import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { Brand } from "../components/Brand";
import { FormError } from "../components/FormError";

export function Login() {
  const { login, expired } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await login(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-sm p-7">
        <h1 className="mb-5">
          <Brand className="text-3xl" />
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-stone-600">
          Sign in to review pending knowledge. This is a separate credential from the access token you
          give Claude — agents never have it.
        </p>
        {expired && !error ? (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Your session expired — please sign in again.
          </div>
        ) : null}
        {error ? <FormError className="mb-4">{error}</FormError> : null}
        <form onSubmit={onSubmit} className="space-y-3">
          <input className="input" type="text" name="username" placeholder="username" autoComplete="username" autoFocus />
          <input
            className="input"
            type="password"
            name="password"
            placeholder="password"
            autoComplete="current-password"
          />
          <button className="btn btn-primary w-full" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
