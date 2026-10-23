#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// issue-bot — poll a repo for new GitHub issues and open a macOS Terminal tab
// running issue-worktree.sh (worktree + claude /issue) for each one.
//
// Run from inside the repo to watch:
//     issue-bot.ts                 # poll every 60s
//     issue-bot.ts --interval 30   # poll every 30s
//     issue-bot.ts --dry-run       # log what it would launch, open nothing
//     issue-bot.ts --once          # single poll then exit
//     issue-bot.ts --cmd is        # launch `is <n>` instead of sourcing the sibling script
//     issue-bot.ts --install       # install as a launchd agent (starts at login)
//     issue-bot.ts --uninstall     # remove the launchd agent
//
// First run only records the newest open issue; it never launches for issues
// that already existed. Issues labeled `no-bot` are skipped.

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const INTERVAL_MS = Number(opt("interval") ?? 60) * 1000;
const DRY_RUN = flag("dry-run");
const ONCE = flag("once");
const SKIP_LABEL = "no-bot";
const REPO_DIR = process.cwd();
const SCRIPT = realpathSync(import.meta.path);
const LAUNCH_CMD =
  opt("cmd") ?? `. ${join(dirname(SCRIPT), "issue-worktree.sh")}`;

interface Issue {
  number: number;
  title: string;
  author: { login: string };
  labels: { name: string }[];
}

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim()}`);
  return out;
}

const repo = (
  await sh([
    "gh",
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ])
).trim();
const repoSlug = repo.replace("/", "-");
const stateDir = join(homedir(), ".local/state/issue-bot");
const stateFile = join(stateDir, `${repoSlug}.json`);
mkdirSync(stateDir, { recursive: true });

// launchd agent, one per watched repo
const agentLabel = `local.issue-bot.${repoSlug}`;
const plistPath = join(
  homedir(),
  "Library/LaunchAgents",
  `${agentLabel}.plist`,
);
const logPath = join(homedir(), "Library/Logs", `issue-bot-${repoSlug}.log`);
const uid = process.getuid?.();

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

if (flag("uninstall")) {
  await sh(["launchctl", "bootout", `gui/${uid}/${agentLabel}`]).catch(
    () => {},
  );
  rmSync(plistPath, { force: true });
  console.log(`removed ${agentLabel}`);
  process.exit(0);
}

if (flag("install")) {
  // Pass through flags that shape the watcher, drop install/one-shot ones
  const passthrough = args.filter(
    (a) => !["--install", "--once", "--dry-run"].includes(a),
  );
  const programArgs = [process.execPath, SCRIPT, ...passthrough];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agentLabel}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(REPO_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
  await sh(["launchctl", "bootout", `gui/${uid}/${agentLabel}`]).catch(
    () => {},
  );
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  await sh(["launchctl", "bootstrap", `gui/${uid}`, plistPath]);
  console.log(
    `installed ${agentLabel}\n  plist: ${plistPath}\n  log:   ${logPath}`,
  );
  process.exit(0);
}

function readLastSeen(): number | null {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).lastSeen ?? null;
  } catch {
    return null;
  }
}

function writeLastSeen(n: number) {
  writeFileSync(stateFile, JSON.stringify({ lastSeen: n }) + "\n");
}

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// AppleScript string literal escaping
const as = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// POSIX shell single-quote escaping
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function openTab(issue: Issue) {
  const cmd = `cd ${q(REPO_DIR)} && ${LAUNCH_CMD} ${issue.number}`;
  // Cmd-T needs Accessibility permission for the app running this bot; fall back
  // to a new window (no permission needed) if System Events refuses.
  const tab = `
    tell application "Terminal"
      activate
      if (count of windows) is 0 then
        do script ${as(cmd)}
      else
        tell application "System Events" to keystroke "t" using command down
        delay 0.5
        do script ${as(cmd)} in selected tab of front window
      end if
    end tell`;
  const window = `tell application "Terminal" to do script ${as(cmd)}`;
  try {
    await sh(["osascript", "-e", tab]);
  } catch (e) {
    log(`tab failed (${(e as Error).message}), opening window instead`);
    await sh(["osascript", "-e", window]);
  }
  const note = `display notification ${as(issue.title)} with title ${as(`Issue #${issue.number}`)} subtitle ${as(`by ${issue.author.login}`)}`;
  await sh(["osascript", "-e", note]).catch(() => {});
}

async function poll() {
  const issues: Issue[] = JSON.parse(
    await sh([
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "30",
      "--json",
      "number,title,author,labels",
    ]),
  );
  const newest = Math.max(0, ...issues.map((i) => i.number));
  const lastSeen = readLastSeen();

  if (lastSeen === null) {
    writeLastSeen(newest);
    log(`first run: watching ${repo} for issues after #${newest}`);
    return;
  }

  const fresh = issues
    .filter((i) => i.number > lastSeen)
    .sort((a, b) => a.number - b.number);
  for (const issue of fresh) {
    if (issue.labels.some((l) => l.name === SKIP_LABEL)) {
      log(`skip #${issue.number} (${SKIP_LABEL}): ${issue.title}`);
      continue;
    }
    log(
      `${DRY_RUN ? "would launch" : "launching"} #${issue.number} by ${issue.author.login}: ${issue.title}`,
    );
    if (!DRY_RUN) await openTab(issue);
  }
  if (newest > lastSeen && !DRY_RUN) writeLastSeen(newest);
}

log(
  `issue-bot on ${repo} (${REPO_DIR}), every ${INTERVAL_MS / 1000}s${DRY_RUN ? ", dry run" : ""}`,
);
while (true) {
  try {
    await poll();
  } catch (e) {
    log(`poll failed: ${(e as Error).message}`);
  }
  if (ONCE) break;
  await Bun.sleep(INTERVAL_MS);
}
