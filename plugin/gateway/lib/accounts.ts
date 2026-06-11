// SPDX-License-Identifier: Apache-2.0
/**
 * Local accounts for the web admin/approval surface (Phase 5.1).
 *
 * These are HUMAN credentials and are deliberately a SEPARATE auth domain from
 * the MCP bearer tokens (lib/http SETOKU_TOKENS). That separation is the whole
 * point: an agent — even a shell-capable one that can read its own MCP token —
 * holds only a propose-only token, never a password, so it cannot authenticate
 * to the approval surface and self-approve its own proposals (I9). The MCP
 * token authorizes "connect + propose"; the account password authorizes
 * "accept", and the two never overlap.
 *
 * Passwords are hashed with argon2id via Bun's built-in Bun.password (zero new
 * dependencies). The plaintext is never written to disk, the store, or a log.
 *
 * user/pass only — no upstream IdP (OIDC was explicitly descoped).
 */
import type { KnowledgeStore } from "./store";

export type Role = "admin" | "member";
export const ROLES: readonly Role[] = ["admin", "member"];

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}

/** Only admins may accept proposals / curate on the web surface. */
export function canApprove(role: string): boolean {
  return role === "admin";
}

const ARGON2ID = { algorithm: "argon2id" } as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return Bun.password.hash(plaintext, ARGON2ID);
}

/**
 * Verify a username+password against the store. Always runs a hash comparison
 * (even for an unknown user, against a dummy hash) so response time does not
 * reveal whether the username exists. Returns the account's role on success.
 */
export async function authenticate(
  store: KnowledgeStore,
  username: string,
  password: string,
): Promise<{ ok: true; role: string } | { ok: false }> {
  const acct = store.getAccount(username);
  // Constant-ish work whether or not the user exists.
  const hash = acct?.pwhash ?? DUMMY_HASH;
  let matched = false;
  try {
    matched = await Bun.password.verify(password, hash);
  } catch {
    matched = false;
  }
  if (acct && matched) return { ok: true, role: acct.role };
  return { ok: false };
}

/**
 * A precomputed argon2id hash of a throwaway string, used on the no-such-user
 * path so verify() does real work and timing doesn't reveal user existence.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$/2P0DsNeEG2NsPadQy8mDaz24QLH2VC/gAeL9tu/1kM$v1mVnFfX5bpkB/OSEMz7yUwU835yiGvvQ43GTgVlulc";
