// Automatic git-worktree cleanup. A worktree is removed ONLY when its work is provably closed and nothing can be lost:
//   closed   = PR merged, or branch fully merged into origin/main, or PR closed with nothing unpushed
//   AND clean (no uncommitted / untracked files except build output and .env*local copies)
//   AND no unpushed commits AND no running process inside it.
// Everything else is "keep" with the reason. Pure helpers are tested without git (cleanup.test.mjs).
// CLI: `npm run cleanup` = dry-run report; `npm run cleanup:apply` removes the removable ones.
// The folder scanned for repos is SAHAR_CODE_DIR (default: the folder that holds your Sahar folder, else ~/Documents). Main checkouts are never removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugOf } from './checks.mjs';
import { isDone } from './progress.mjs';

export const ANCESTOR_MIN_IDLE_MS = 3 * 24 * 3600 * 1000; // "merged into main" alone never removes a worktree that may just have been created
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'staging', 'production']);
const HOME = os.homedir();
const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HUB = process.env.HUB_DIR || path.join(UI_DIR, 'hub');
/** Where the person's repos live. SAHAR_CODE_DIR if set; else the folder that holds the hub (when HUB_DIR is set) or the folder that holds this Sahar folder (the usual "all my repos side by side" layout); else ~/Documents. */
export function codeDir(env = process.env, { hubDir = DEFAULT_HUB, uiDir = UI_DIR } = {}) {
  const pick = env.SAHAR_CODE_DIR || (env.HUB_DIR ? path.dirname(path.resolve(env.HUB_DIR)) : path.dirname(uiDir));
  try { if (fs.statSync(pick).isDirectory() && path.resolve(pick) !== path.parse(pick).root) return pick; } catch {}
  return path.join(HOME, 'Documents');
}
const DEFAULT_DOCS = codeDir();

// ── process helper (never throws) ──
export function sh(cmd, args, { cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const git = (exec, repo, ...args) => exec('git', ['-C', repo, ...args]);

// ── pure parsers ──
/** `git worktree list --porcelain` → [{ path, head, branch, detached, bare, prunable }] (first entry = the main checkout). */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: '', branch: null, detached: false, bare: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

/** "git@github.com:o/n.git" or "https://github.com/o/n" → "o/n", else null. */
export function parseRemote(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `lsof -a -d cwd -Fpcn` → [{ pid, command, cwd }]. */
export function parseLsofCwd(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') { cur = { pid: Number(v), command: '', cwd: '' }; out.push(cur); }
    else if (!cur) continue;
    else if (k === 'c') cur.command = v;
    else if (k === 'n') cur.cwd = v;
  }
  return out.filter((p) => p.cwd);
}
/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → Map pid → [ports]. */
export function parseLsofListen(text) {
  const m = new Map();
  let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') {
      const port = line.match(/:(\d+)$/)?.[1];
      if (port) m.set(pid, [...(m.get(pid) || []), Number(port)]);
    }
  }
  return m;
}

const inside = (cwd, dir) => cwd === dir || cwd.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
/** Processes (not us) whose cwd is inside the worktree. Listening dev servers are reported with their ports. */
export function processesIn(wtPath, procs, listen = new Map(), selfPid = process.pid) {
  return procs
    .filter((p) => p.pid !== selfPid && inside(p.cwd, wtPath))
    .map((p) => ({ pid: p.pid, command: p.command, ports: listen.get(p.pid) || [] }));
}

const BUILD_DIR = /(^|\/)(node_modules|\.next|dist|\.turbo)(\/|$)/;
const ENV_LOCAL = /(^|\/)\.env[^/]*local[^/]*$/;
/** `git status --porcelain` lines that count as real work (build output and .env*local copies do not). */
export function meaningfulChanges(porcelain) {
  const out = [];
  for (const raw of String(porcelain || '').split('\n')) {
    if (!raw.trim()) continue;
    let p = raw.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    p = p.replace(/^"|"$/g, '');
    if (BUILD_DIR.test(p) || ENV_LOCAL.test(p)) continue;
    out.push(raw);
  }
  return out;
}

/** PRs for one branch ([{ number, state, mergedAt }]) → the one that decides: merged > open > closed. */
export function pickPr(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const merged = list.find((p) => p.state === 'MERGED' || p.mergedAt);
  if (merged) return { number: merged.number, state: 'MERGED', headRefOid: merged.headRefOid || null };
  const open = list.find((p) => p.state === 'OPEN');
  if (open) return { number: open.number, state: 'OPEN', headRefOid: open.headRefOid || null };
  return { number: list[0].number, state: 'CLOSED', headRefOid: list[0].headRefOid || null };
}

/**
 * The decision. Pure: everything it needs is in `i`.
 *  i = { isMain, missing, branch, pr: {number,state,headInPr}|null, mergedIntoMain, dirty: [], unpushed: number|null, procs: [], idleMs }
 * → { verdict: 'removable'|'keep', reason, codes: [...], closedBy }
 */
export function classify(i) {
  if (i.isMain) return { verdict: 'keep', reason: 'main checkout, never removed', codes: ['main'] };
  if (i.missing) return { verdict: 'removable', reason: 'folder already gone, only the git record is pruned', codes: [], closedBy: 'missing' };
  const keep = []; // [code, text]
  if (i.procs?.length) {
    const d = i.procs.slice(0, 2).map((p) => `${p.command || 'process'} pid ${p.pid}${p.ports?.length ? ` :${p.ports.join(',')}` : ''}`).join(', ');
    keep.push(['in-use', `in use (${d})`]);
  }
  if (i.dirty?.length) keep.push(['uncommitted', `uncommitted changes (${i.dirty.length} file${i.dirty.length === 1 ? '' : 's'})`]);

  const pr = i.pr;
  // a merged PR's own commits count as pushed even when the remote branch was deleted by the merge
  const prHasIt = pr?.state === 'MERGED' && pr.headInPr === true;
  if (i.unpushed == null) keep.push(['unpushed-unknown', 'could not check for unpushed commits']);
  else if (i.unpushed > 0 && !prHasIt) keep.push(['unpushed', `${i.unpushed} unpushed commit${i.unpushed === 1 ? '' : 's'}`]);

  let closedBy = null;
  if (pr?.state === 'MERGED') closedBy = `PR #${pr.number} merged`;
  else if (i.mergedIntoMain && (i.idleMs ?? 0) >= ANCESTOR_MIN_IDLE_MS) closedBy = 'branch fully merged into origin/main';
  else if (pr?.state === 'CLOSED' && i.unpushed === 0) closedBy = `PR #${pr.number} closed, nothing unpushed`;
  if (!closedBy) {
    if (pr?.state === 'OPEN') keep.push(['pr-open', `PR #${pr.number} still open`]);
    else if (pr?.state === 'CLOSED') keep.push(['pr-closed-unpushed', `PR #${pr.number} closed but the branch has unpushed work`]);
    else if (i.mergedIntoMain) keep.push(['fresh', 'no PR and no work of its own yet (idle under 3 days)']);
    else if (!i.branch) keep.push(['detached', 'detached HEAD, not merged into origin/main']);
    else keep.push(['no-pr', 'no PR and not merged into origin/main']);
  }
  if (keep.length) return { verdict: 'keep', reason: keep.map((k) => k[1]).join('; '), codes: keep.map((k) => k[0]), closedBy };
  return { verdict: 'removable', reason: closedBy, codes: [], closedBy };
}

/** Does a worktree belong to a closed task? Explicit card fields first, else the task slug inside the branch or folder name. */
export function matchesTask(task, wt) {
  const base = path.basename(wt.path);
  const explicit = [task?.worktrees, task?.worktree, task?.branch, task?.branches].flat().filter(Boolean).map(String);
  if (explicit.some((e) => e === wt.path || e === base || e === wt.branch)) return true;
  const slugs = new Set([slugOf(task?.name), slugOf(task?.title)].filter((s) => s.length >= 5));
  const hay = [slugOf(wt.branch || ''), slugOf(base)];
  return [...slugs].some((s) => hay.some((h) => h && h.includes(s)));
}

/** Tasks that just closed: reached a done stage, or left main-tasks.json (same rule as progress.mjs). last = { [key]: { done } }. */
export function diffClosed(tasks, last = {}) {
  const next = {};
  const closed = [];
  if (!Array.isArray(tasks) || !tasks.length) return { closed, next: { ...last } }; // a half-written file retires nothing
  const seen = new Set();
  for (const t of tasks) {
    const key = String(t?.name || t?.title || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const done = isDone(t);
    next[key] = { done, task: { name: t.name, title: t.title, worktrees: t.worktrees, branch: t.branch } };
    if (done && !last[key]?.done) closed.push(t);
  }
  for (const [key, prev] of Object.entries(last)) {
    if (seen.has(key)) continue;
    if (!prev.done) closed.push(prev.task || { name: key });
  }
  return { closed, next };
}

/** One short line per kept worktree, for Sahar to tell the person. */
export function keptNote(rows) {
  const kept = rows.filter((r) => r.verdict === 'keep');
  if (!kept.length) return '';
  return kept.slice(0, 8).map((r) => `kept ${path.basename(r.path)}${r.branch ? ` (${r.branch})` : ''}: ${r.reason}`).join('\n');
}

// ── discovery ──
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
function gitFile(dir) { // a worktree's `.git` file → gitdir path, or null
  try {
    const f = path.join(dir, '.git');
    if (!fs.statSync(f).isFile()) return null;
    return fs.readFileSync(f, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() || null;
  } catch { return null; }
}
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(d, e.name)); } catch { return []; } };

/** → [{ path, mainRepo, isMain, branch, head, detached, prunable, missing }]. Main checkouts are included flagged isMain. */
export async function discover({ docs = DEFAULT_DOCS, hub = DEFAULT_HUB, exec = sh } = {}) {
  const repos = new Map(); // real path → path
  const strays = [];
  for (const dir of [...subdirs(docs), ...subdirs(hub)]) {
    if (isDir(path.join(dir, '.git'))) repos.set(real(dir), dir);
    else if (gitFile(dir)) strays.push(dir);
  }
  // a stray worktree whose main repo lives outside the code folder still belongs to the person's repos
  for (const s of strays) {
    const gd = gitFile(s);
    const m = gd && gd.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/);
    if (m && isDir(path.join(m[1], '.git'))) repos.set(real(m[1]), m[1]);
  }
  const found = new Map(); // real wt path → entry
  for (const repo of repos.values()) {
    const r = await git(exec, repo, 'worktree', 'list', '--porcelain');
    if (!r.ok) continue;
    parseWorktreeList(r.stdout).forEach((w, idx) => {
      if (w.bare) return;
      const key = real(w.path);
      if (found.has(key) && !(idx === 0)) return;
      found.set(key, { path: w.path, mainRepo: repo, isMain: idx === 0, branch: w.branch, head: w.head, detached: w.detached, prunable: w.prunable, missing: w.prunable || !isDir(w.path) });
    });
  }
  for (const s of strays) { // strays git itself did not list (main repo gone or unreadable)
    if (found.has(real(s))) continue;
    found.set(real(s), { path: s, mainRepo: null, isMain: false, branch: null, head: '', detached: false, prunable: false, missing: false, orphan: true });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ── per-worktree facts ──
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function snapshotProcesses(exec = sh) {
  const a = await exec('lsof', ['-a', '-d', 'cwd', '-Fpcn'], { timeout: 60000 }); // partial output on permission errors is fine
  const l = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 60000 });
  return { procs: parseLsofCwd(a.stdout), listen: parseLsofListen(l.stdout) };
}

async function defaultRef(exec, repo) {
  const r = await git(exec, repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  for (const c of ['origin/main', 'origin/master']) if ((await git(exec, repo, 'rev-parse', '--verify', '--quiet', c)).ok) return c;
  return null;
}

const prCache = new Map();
async function prFor(exec, repo, branch) {
  if (!branch) return { pr: null, note: '' };
  const remote = parseRemote((await git(exec, repo, 'remote', 'get-url', 'origin')).stdout);
  if (!remote) return { pr: null, note: 'no github remote' };
  const key = `${remote}#${branch}`;
  if (!prCache.has(key)) {
    const r = await exec('gh', ['pr', 'list', '--repo', remote, '--head', branch, '--state', 'all', '--json', 'number,state,mergedAt,headRefOid', '--limit', '10'], { timeout: 60000 });
    let list = null;
    if (r.ok) { try { list = JSON.parse(r.stdout); } catch {} }
    prCache.set(key, list ? { pr: pickPr(list), note: '' } : { pr: null, note: 'gh lookup failed' });
  }
  return prCache.get(key);
}

/** Collects the facts `classify` needs for one worktree. Injectable exec; tests use fixtures instead. */
export async function inspect(wt, { exec = sh, snap = { procs: [], listen: new Map() }, now = Date.now(), withSize = false } = {}) {
  const row = { ...wt, repoName: wt.mainRepo ? path.basename(wt.mainRepo) : '?', pr: null, prNote: '', dirty: [], unpushed: null, mergedIntoMain: false, procs: [], idleMs: 0, bytes: 0 };
  if (wt.isMain || wt.missing || !wt.mainRepo) return { ...row, ...(wt.orphan ? { verdict: 'keep', reason: 'main repo not found (orphan worktree)', codes: ['orphan'] } : classify({ ...row })) };
  const cwd = wt.path;
  const g = (...a) => exec('git', ['-C', cwd, ...a]);
  const [st, un, ref] = await Promise.all([g('status', '--porcelain'), g('rev-list', '--count', 'HEAD', '--not', '--remotes'), defaultRef(exec, wt.mainRepo)]);
  row.dirty = st.ok ? meaningfulChanges(st.stdout) : ['status failed'];
  row.unpushed = un.ok ? Number(un.stdout.trim()) : null;
  if (ref) row.mergedIntoMain = (await g('merge-base', '--is-ancestor', 'HEAD', ref)).ok;
  const { pr, note } = await prFor(exec, wt.mainRepo, wt.branch);
  row.pr = pr;
  row.prNote = note;
  if (pr?.state === 'MERGED' && pr.headRefOid) {
    const head = (await g('rev-parse', 'HEAD')).stdout.trim();
    pr.headInPr = head === pr.headRefOid || (await g('merge-base', '--is-ancestor', 'HEAD', pr.headRefOid)).ok;
  }
  row.procs = processesIn(real(cwd), snap.procs, snap.listen);
  if (!row.procs.length && real(cwd) !== cwd) row.procs = processesIn(cwd, snap.procs, snap.listen);
  let mt = 0;
  try { mt = fs.statSync(cwd).mtimeMs; } catch {}
  const gd = (await g('rev-parse', '--absolute-git-dir')).stdout.trim();
  try { mt = Math.max(mt, fs.statSync(path.join(gd, 'index')).mtimeMs); } catch {}
  row.lastModified = mt;
  row.idleMs = mt ? now - mt : 0;
  if (withSize) row.bytes = Number((await exec('du', ['-sk', cwd], { timeout: 180000 })).stdout.split(/\s/)[0] || 0) * 1024;
  return { ...row, ...classify(row) };
}

export const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);

/** Markdown report + totals. */
export function buildReport(rows, { apply = false, now = new Date() } = {}) {
  const wts = rows.filter((r) => !r.isMain);
  const rem = wts.filter((r) => r.verdict === 'removable');
  const keep = wts.filter((r) => r.verdict === 'keep');
  const sum = (l) => l.reduce((a, r) => a + (r.bytes || 0), 0);
  const reasons = {};
  for (const r of keep) for (const c of r.codes || []) reasons[c] = (reasons[c] || 0) + 1;
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const home = (p) => p.replace(HOME, '~');
  const lines = [
    `# Worktree report`,
    `${apply ? 'Applied' : 'Dry run'} at ${now.toISOString()}. Removable: ${rem.length} (${fmtSize(sum(rem))}). Keep: ${keep.length} (${fmtSize(sum(keep))}). Total worktrees: ${wts.length} (${fmtSize(sum(wts))}).`,
    '',
    `Why kept: ${top.map(([c, n]) => `${c} ${n}`).join(', ') || 'nothing kept'}`,
    '',
    '| path | repo | branch | PR | verdict | reason | size |',
    '|---|---|---|---|---|---|---|',
    ...wts.sort((a, b) => (a.verdict === b.verdict ? a.path.localeCompare(b.path) : a.verdict === 'removable' ? -1 : 1)).map((r) =>
      `| ${cell(home(r.path))} | ${cell(r.repoName)} | ${cell(r.branch || '(detached)')} | ${r.pr ? `#${r.pr.number} ${r.pr.state.toLowerCase()}` : cell(r.prNote || 'none')} | ${r.verdict} | ${cell(r.reason)} | ${r.bytes ? fmtSize(r.bytes) : ''} |`),
    '',
  ];
  return { markdown: lines.join('\n'), totals: { removable: rem.length, keep: keep.length, total: wts.length, removableBytes: sum(rem), keepBytes: sum(keep), totalBytes: sum(wts) }, reasons: top };
}

// ── removal ──
/** Removes ONE worktree, re-running the safety verdict first. Returns { removed, branchDeleted, why }. */
export async function removeWorktree(row, { exec = sh, hub = DEFAULT_HUB, now = new Date(), logFile = path.join(hub, 'mind', 'cleanup-log.md') } = {}) {
  if (row.verdict !== 'removable' || row.isMain || !row.mainRepo) return { removed: false, why: 'not removable' };
  const repo = row.mainRepo;
  if (!row.missing) {
    const r = await git(exec, repo, 'worktree', 'remove', '--force', row.path); // force: ignored build dirs and .env copies
    if (!r.ok) return { removed: false, why: r.stderr.trim().split('\n').pop() || 'git worktree remove failed' };
  }
  let branchDeleted = false;
  const merged = row.pr?.state === 'MERGED' || row.mergedIntoMain;
  if (!row.missing && merged && row.branch && !PROTECTED_BRANCHES.has(row.branch)) {
    branchDeleted = (await git(exec, repo, 'branch', '-D', row.branch)).ok;
  }
  await git(exec, repo, 'worktree', 'prune');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `- ${now.toISOString()} removed ${row.path.replace(HOME, '~')} (${row.repoName}, ${row.branch || 'detached'}): ${row.reason}; branch ${branchDeleted ? 'deleted' : 'kept'}\n`);
  } catch {}
  return { removed: true, branchDeleted };
}

/**
 * discover → inspect → (optionally) remove. `filter(wt)` narrows to one task's worktrees.
 * → { rows, report, removed: [...], failed: [...] }
 */
export async function runCleanup({ apply = false, filter = null, docs = DEFAULT_DOCS, hub = DEFAULT_HUB, exec = sh, log = () => {}, reportFile = path.join(hub, 'mind', 'worktree-report.md'), withSize = true, writeReport = true } = {}) {
  prCache.clear(); // PR states change; never reuse an earlier pass
  let wts = await discover({ docs, hub, exec });
  if (filter) wts = wts.filter((w) => !w.isMain && filter(w));
  const snap = await snapshotProcesses(exec);
  const rows = await pool(wts, 6, (w) => inspect(w, { exec, snap, withSize }));
  const removed = [];
  const failed = [];
  if (apply) {
    for (const r of rows) {
      if (r.verdict !== 'removable') continue;
      const res = await removeWorktree(r, { exec, hub });
      if (res.removed) { removed.push(r); log(`[cleanup] removed ${r.path} (${r.reason})`); }
      else { failed.push({ row: r, why: res.why }); log(`[cleanup] could not remove ${r.path}: ${res.why}`); }
    }
  }
  const report = buildReport(rows, { apply });
  if (writeReport && reportFile) { try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, report.markdown); } catch {} }
  return { rows, report, removed, failed };
}

// ── CLI ──
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const apply = process.argv.includes('--apply');
  const out = await runCleanup({ apply, log: (m) => console.log(m) });
  const t = out.report.totals;
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${t.total} worktrees, ${t.removable} removable (${fmtSize(t.removableBytes)}), ${t.keep} keep (${fmtSize(t.keepBytes)}), ${fmtSize(t.totalBytes)} total`);
  console.log(`why kept: ${out.report.reasons.map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`);
  if (apply) console.log(`removed ${out.removed.length}, failed ${out.failed.length}`);
  console.log(`scanned: ${DEFAULT_DOCS}\nreport: ${path.join(DEFAULT_HUB, 'mind', 'worktree-report.md')}`);
}
