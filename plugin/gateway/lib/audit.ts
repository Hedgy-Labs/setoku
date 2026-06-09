import fs from "node:fs";
import path from "node:path";
import { setokuDir } from "./config";

/**
 * Append-only JSONL audit log at .setoku/audit/<YYYY-MM>.jsonl.
 * The directory is gitignored via a generated .gitignore (audit stays local).
 */
export function auditLog(
  projectDir: string,
  record: Record<string, unknown>,
): void {
  try {
    const dir = path.join(setokuDir(projectDir), "audit");
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n!.gitignore\n");
    const month = new Date().toISOString().slice(0, 7);
    fs.appendFileSync(
      path.join(dir, `${month}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
    );
  } catch {
    // auditing must never take the gateway down
  }
}
