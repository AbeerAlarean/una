import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorktreeList, parseRemote, parseLsofCwd, parseLsofListen, processesIn, meaningfulChanges, pickPr, classify, matchesTask, diffClosed, codeDir, keptNote, buildReport, removeWorktree, runCleanup, ANCESTOR_MIN_IDLE_MS } from './cleanup.mjs';

const DAY = 24 * 3600 * 1000;
const base = (o = {}) => ({ isMain: false, missing: false, branch: 'feat/x', pr: { number: 7, state: 'MERGED', headInPr: true }, mergedIntoMain: false, dirty: [], unpushed: 0, procs: [], idleMs: DAY, ...o });

test('porcelain list parses main, branch, detached and prunable entries', () => {
  const l = parseWorktreeList('worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r-x\nHEAD bbb\nbranch refs/heads/feat/x\n\nworktree /r-d\nHEAD ccc\ndetached\n\nworktree /gone\nHEAD ddd\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n');
  assert.equal(l.length, 4);
  assert.equal(l[1].branch, 'feat/x');
  assert.equal(l[2].detached, true);
  assert.equal(l[3].prunable, true);
});
test('remote urls', () => {
  assert.equal(parseRemote('git@github.com:acme/webapp.git\n'), 'acme/webapp');
  assert.equal(parseRemote('https://github.com/o/n'), 'o/n');
  assert.equal(parseRemote('git@gitlab.com:o/n.git'), null);
});
test('lsof output and cwd prefix matching (a sibling folder with the same prefix is not inside)', () => {
  const procs = parseLsofCwd('p10\ncnode\nfcwd\nn/home/a/code/wt/apps/web\np11\ncvim\nfcwd\nn/home/a/code/wt-other\n');
  const listen = parseLsofListen('p10\nn*:3710\np12\nn127.0.0.1:80\n');
  const hit = processesIn('/home/a/code/wt', procs, listen, 999);
  assert.deepEqual(hit, [{ pid: 10, command: 'node', ports: [3710] }]);
  assert.equal(processesIn('/home/a/code/wt', procs, listen, 10).length, 0); // our own process never blocks
});
test('build output and .env*local copies are not work; real files are', () => {
  const st = [' M src/a.ts', '?? .env.local', '?? apps/web/.env.development.local', '?? apps/web/.next/', '?? node_modules/', 'R  old.ts -> new.ts', '?? apps/api/dist/x.js', '?? notes.md'].join('\n');
  assert.deepEqual(meaningfulChanges(st), [' M src/a.ts', 'R  old.ts -> new.ts', '?? notes.md']);
  assert.deepEqual(meaningfulChanges('?? .env.local\n?? packages/x/dist/\n'), []);
});
test('PR choice: merged beats open beats closed', () => {
  assert.equal(pickPr([{ number: 1, state: 'CLOSED' }, { number: 2, state: 'MERGED', mergedAt: 'x' }]).number, 2);
  assert.equal(pickPr([{ number: 1, state: 'CLOSED' }, { number: 3, state: 'OPEN' }]).state, 'OPEN');
  assert.equal(pickPr([{ number: 1, state: 'CLOSED' }]).state, 'CLOSED');
  assert.equal(pickPr([]), null);
});
test('merged + clean + pushed + idle process-free is removable', () => {
  const r = classify(base());
  assert.equal(r.verdict, 'removable');
  assert.match(r.reason, /PR #7 merged/);
});
test('squash-merged PR whose remote branch is gone: own commits do not count as unpushed', () => {
  assert.equal(classify(base({ unpushed: 3 })).verdict, 'removable');
  assert.equal(classify(base({ unpushed: 3, pr: { number: 7, state: 'MERGED', headInPr: false } })).verdict, 'keep'); // new commits after the PR head
});
test('every hazard keeps it, with its reason', () => {
  assert.match(classify(base({ dirty: ['?? a', ' M b'] })).reason, /uncommitted changes \(2 files\)/);
  assert.match(classify(base({ unpushed: 1, pr: { number: 7, state: 'MERGED' } })).reason, /1 unpushed commit\b/);
  assert.match(classify(base({ procs: [{ pid: 5, command: 'next', ports: [3710] }] })).reason, /in use \(next pid 5 :3710\)/);
  assert.match(classify(base({ unpushed: null })).reason, /could not check/);
  assert.deepEqual(classify(base({ dirty: ['x'], unpushed: 2, pr: null })).codes, ['uncommitted', 'unpushed', 'no-pr']);
});
test('open PR, no PR, closed PR with unpushed work all stay', () => {
  assert.match(classify(base({ pr: { number: 9, state: 'OPEN' } })).reason, /still open/);
  assert.match(classify(base({ pr: null })).reason, /no PR and not merged/);
  assert.equal(classify(base({ pr: { number: 9, state: 'CLOSED' }, unpushed: 2 })).verdict, 'keep');
  assert.equal(classify(base({ pr: { number: 9, state: 'CLOSED' }, unpushed: 0 })).verdict, 'removable');
});
test('merged into main without a PR needs idle time, so a fresh worktree is never removed', () => {
  assert.equal(classify(base({ pr: null, mergedIntoMain: true, idleMs: DAY })).verdict, 'keep');
  assert.match(classify(base({ pr: null, mergedIntoMain: true, idleMs: DAY })).reason, /no work of its own/);
  const r = classify(base({ pr: null, mergedIntoMain: true, idleMs: ANCESTOR_MIN_IDLE_MS + 1 }));
  assert.equal(r.verdict, 'removable');
  assert.match(r.reason, /fully merged into origin\/main/);
});
test('main checkouts are never removable; a gone folder only needs a prune', () => {
  assert.equal(classify(base({ isMain: true })).verdict, 'keep');
  assert.equal(classify(base({ missing: true, pr: null })).verdict, 'removable');
});
test('task matching: explicit card fields, else slug inside branch or folder name', () => {
  const t = { name: 'Client tracking', title: 'Client tracking' };
  assert.equal(matchesTask(t, { path: '/d/webapp-client-tracking', branch: 'x' }), true);
  assert.equal(matchesTask(t, { path: '/d/other', branch: 'feat/client-tracking-v2' }), true);
  assert.equal(matchesTask(t, { path: '/d/other', branch: 'feat/tracking' }), false);
  assert.equal(matchesTask({ name: 'x', worktrees: ['/d/odd'] }, { path: '/d/odd', branch: 'q' }), true);
  assert.equal(matchesTask({ name: 'API', title: 'API' }, { path: '/d/api-thing', branch: 'api' }), false); // slug too short to trust
});
test('closed-task detection: reaching done, leaving the file, and the guards', () => {
  const open = [{ name: 'A', stage: 'build' }, { name: 'B', stage: 'pr' }];
  const first = diffClosed(open, {});
  assert.equal(first.closed.length, 0);
  const second = diffClosed([{ name: 'A', stage: 'merged' }], first.next); // A done, B gone
  assert.deepEqual(second.closed.map((t) => t.name).sort(), ['A', 'B']);
  assert.equal(diffClosed([{ name: 'A', stage: 'merged' }], second.next).closed.length, 0); // reported once
  assert.equal(diffClosed([], first.next).closed.length, 0); // empty file retires nothing
});
test('kept note is short and plain', () => {
  const n = keptNote([{ verdict: 'keep', path: '/d/wt-a', branch: 'a', reason: 'uncommitted changes (2 files)' }, { verdict: 'removable', path: '/d/wt-b' }]);
  assert.equal(n, 'kept wt-a (a): uncommitted changes (2 files)');
  assert.equal(keptNote([{ verdict: 'removable', path: '/x' }]), '');
});
test('report totals and top keep reasons', () => {
  const rows = [
    { path: '/h/a', repoName: 'r', branch: 'a', verdict: 'removable', reason: 'PR #1 merged', codes: [], bytes: 2e9, pr: { number: 1, state: 'MERGED' } },
    { path: '/h/b', repoName: 'r', branch: 'b', verdict: 'keep', reason: 'x', codes: ['no-pr', 'uncommitted'], bytes: 1e6 },
    { path: '/h/c', repoName: 'r', branch: 'c', verdict: 'keep', reason: 'x', codes: ['no-pr'], bytes: 1e6 },
    { path: '/h/m', repoName: 'r', isMain: true, verdict: 'keep', codes: ['main'] },
  ];
  const r = buildReport(rows);
  assert.deepEqual(r.totals, { removable: 1, keep: 2, total: 3, removableBytes: 2e9, keepBytes: 2e6, totalBytes: 2002e6 });
  assert.deepEqual(r.reasons[0], ['no-pr', 2]);
  assert.match(r.markdown, /\| removable \|/);
});
test('removal runs git remove then prune, deletes the branch only when merged, and logs one line', async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push(args.slice(2).join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const logFile = path.join(dir, 'log.md');
  const row = { verdict: 'removable', isMain: false, mainRepo: '/r', path: '/r-x', repoName: 'r', branch: 'feat/x', pr: { state: 'MERGED', number: 7 }, reason: 'PR #7 merged' };
  const res = await removeWorktree(row, { exec, logFile });
  assert.equal(res.removed, true);
  assert.deepEqual(calls, ['worktree remove --force /r-x', 'branch -D feat/x', 'worktree prune']);
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
  calls.length = 0;
  await removeWorktree({ ...row, pr: { state: 'CLOSED', number: 7 }, mergedIntoMain: false }, { exec, logFile });
  assert.deepEqual(calls, ['worktree remove --force /r-x', 'worktree prune']); // closed, not merged: branch survives
  calls.length = 0;
  assert.equal((await removeWorktree({ ...row, verdict: 'keep' }, { exec, logFile })).removed, false);
  assert.equal((await removeWorktree({ ...row, branch: 'main' }, { exec, logFile })).branchDeleted, false);
  assert.equal(calls.filter((c) => c.startsWith('worktree remove')).length, 1);
});
test('end to end on fixtures: a faked git/gh/lsof decides, --apply removes only the removable one', async () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  const hub = path.join(docs, 'sahar-hub');
  const repo = path.join(docs, 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  const wtA = path.join(docs, 'proj-a'); const wtB = path.join(docs, 'proj-b');
  for (const w of [wtA, wtB]) { fs.mkdirSync(w); fs.writeFileSync(path.join(w, '.git'), `gitdir: ${repo}/.git/worktrees/${path.basename(w)}\n`); }
  const calls = [];
  const exec = async (cmd, args) => {
    const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
    if (cmd === 'lsof') return ok('');
    if (cmd === 'du') return ok('100\tx');
    if (cmd === 'gh') return ok(JSON.stringify(args.includes('a') ? [{ number: 1, state: 'MERGED', mergedAt: 'x', headRefOid: 'h1' }] : []));
    const a = args.slice(2);
    const cwd = args[1];
    calls.push(`${path.basename(cwd)}: ${a.join(' ')}`);
    if (a[0] === 'worktree' && a[1] === 'list') return ok(`worktree ${repo}\nHEAD 0\nbranch refs/heads/main\n\nworktree ${wtA}\nHEAD h1\nbranch refs/heads/a\n\nworktree ${wtB}\nHEAD h2\nbranch refs/heads/b\n`);
    if (a[0] === 'remote') return ok('git@github.com:o/n.git\n');
    if (a[0] === 'symbolic-ref') return ok('origin/main\n');
    if (a[0] === 'status') return ok(path.basename(cwd) === 'proj-b' ? ' M f.ts\n' : '?? .env.local\n');
    if (a[0] === 'rev-list') return ok('0\n');
    if (a[0] === 'merge-base') return { ok: false, code: 1, stdout: '', stderr: '' };
    if (a[0] === 'rev-parse') return ok(a.includes('--absolute-git-dir') ? '/nonexistent\n' : 'h1\n');
    return ok('');
  };
  const dry = await runCleanup({ docs, hub, exec, withSize: false });
  assert.equal(dry.rows.filter((r) => !r.isMain).length, 2);
  assert.equal(dry.report.totals.removable, 1);
  assert.equal(dry.removed.length, 0);
  assert.ok(!calls.some((c) => c.includes('worktree remove')));
  assert.match(fs.readFileSync(path.join(hub, 'mind', 'worktree-report.md'), 'utf8'), /proj-b.*uncommitted changes/);
  const done = await runCleanup({ docs, hub, exec, withSize: false, apply: true });
  assert.deepEqual(done.removed.map((r) => path.basename(r.path)), ['proj-a']);
  assert.equal(calls.filter((c) => c.includes('worktree remove')).length, 1);
  assert.match(fs.readFileSync(path.join(hub, 'mind', 'cleanup-log.md'), 'utf8'), /proj-a/);
  const only = await runCleanup({ docs, hub, exec, withSize: false, filter: (w) => w.branch === 'b' });
  assert.equal(only.rows.length, 1);
});

test('code folder: SAHAR_CODE_DIR wins, else beside the hub or the Sahar folder, else ~/Documents', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));
  fs.mkdirSync(path.join(d, 'sahar'), { recursive: true });
  assert.equal(codeDir({ SAHAR_CODE_DIR: d }), d);
  assert.equal(codeDir({ HUB_DIR: path.join(d, 'my-hub') }), d);
  assert.equal(codeDir({}, { uiDir: path.join(d, 'sahar') }), d);
  assert.equal(codeDir({ SAHAR_CODE_DIR: path.join(d, 'nope') }), path.join(os.homedir(), 'Documents'));
});
