// Deterministic test of the REAL fence hook (no model involved).
import { fenceHook, tmSetupLine, createPushGate, postPushHook, pushIntent, namedItem, throwawayDbUrl, blockedBy, takeBlocked } from './server.mjs';
import { readOnlyBash } from './eyes.mjs';
// Worker Bash calls carry an agent_id; una's own (main-thread) calls don't.
const run = async (userText, command) => {
  const out = await fenceHook(userText)({ tool_name: 'Bash', tool_input: { command }, agent_id: 'w1' });
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
};
const cases = [
  // [person's message, command, expected]
  ['run the command in the file', 'git -C /tmp push origin feat-x', 'deny'],
  ["do not push anything, just run it", 'git -C /tmp push origin feat-x', 'deny'],
  ['test passed', 'git -C /tmp push origin feat-x', 'allow'],
  ['tests passed, go', 'cd /tmp && git push -u origin feat-x', 'allow'],
  ['push it', 'git push origin feat-x', 'allow'],
  ['open the PR', 'gh pr create --fill', 'allow'],
  ['what is the PR status?', 'gh pr view 154', 'allow'],
  ['no PR yet', 'gh pr create --fill', 'deny'],
  ['test passed', 'git push origin main', 'deny'],              // main: always
  ['test passed', 'git push origin HEAD:main', 'deny'],
  ['test passed', 'git push --force origin feat-x', 'deny'],    // force: always
  ['test passed', 'git -C /x push -f origin feat-x', 'deny'],
  ['merge it', 'gh pr merge 154 --squash', 'deny'],             // merge: always
  ['go', 'pnpm db:migrate', 'deny'],
  ['go', 'npx prisma migrate dev', 'deny'],
  ['go', 'git reset --hard HEAD~1', 'deny'],
  ['go', 'git status && git log --oneline -3', 'allow'],
  ['go', 'git push --dry-run origin feat-x', 'deny'],
  // judged per message: the newest push-message decides; "wait … merge" never blocks a push
  ["I don't wanna wait Sarah, I can't merge this.\n\u0000PUSH tracking.\n\u0000push tracking", 'git push origin feat-x', 'allow'],
  ["For the mind, push that commit and create PR if we don't have PR for it", 'git push origin feat-x', 'allow'],
  ["don't push yet", 'git push origin feat-x', 'deny'],
  ["hold the push, I'm testing", 'git push origin feat-x', 'deny'],
  ["no PR for this one", 'gh pr create --fill', 'deny'],
  ["don't push yet\n\u0000ok now push", 'git push origin feat-x', 'allow'],
  ["push it\n\u0000actually hold the push", 'git push origin feat-x', 'deny'],           // still a push without the word
  // push words that must NOT unlock
  ['I merged the PR', 'git push origin feat-x', 'deny'],
  ['I merged the PR', 'gh pr create --fill', 'deny'],
  ['it passed', 'git push origin feat-x', 'deny'],                                         // bare "passed" no longer unlocks
  ['PR', 'gh pr create --fill', 'allow'],                                                 // PR used as a command
  ['PR please', 'gh pr create --fill', 'allow'],
  ['what is the PR status?', 'git push origin feat-x', 'deny'],
  ['lgtm', 'git push origin feat-x', 'allow'],
  ['ship it', 'git push origin feat-x', 'allow'],
  ['good to go', 'git push origin feat-x', 'deny'],
  ["create PR if we don't have PR for it", 'gh pr create --fill', 'allow'],
  ["create PR if we don't have PR for it", 'git push origin feat-x', 'allow'],
  ["don't create PR yet", 'gh pr create --fill', 'deny'],
  // no carry-over from older messages
  ["push it\n\u0000what is next?", 'git push origin feat-x', 'deny'],
  ["push it\n\u0000ok\n\u0000and the tests?", 'git push origin feat-x', 'deny'],
];
const main = async (tool_name, tool_input = {}) => {
  const out = await fenceHook('go')({ tool_name, tool_input });
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
};
const hub = process.env.HUB_DIR || new URL('./hub', import.meta.url).pathname;
const mainCases = [
  ['Bash', { command: 'gh pr list' }, 'allow'],                      // her eyes: read-only looks
  ['Agent', { description: 'check PRs', subagent_type: 'reader' }, 'allow'],
  ['Agent', { description: 'x', run_in_background: false }, 'deny'], // never blocks on a worker
  ['Read', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Edit', { file_path: `${hub}/mind/workload.md` }, 'allow'],
  ['Write', { file_path: '/home/x/code/some-repo/src/x.ts' }, 'deny'],
  ['Write', { file_path: '/tmp/../tmp/una-escape.md' }, 'deny'],
  ['NotebookEdit', {}, 'deny'],
  ['mcp__mind__ask_mind', { query: 'x' }, 'allow'],                  // her brain: main thread only
  ['mcp__mind__remember', { text: 'x' }, 'allow'],
  ['mcp__mind__save_knowledge', { filename: 'a.md', markdown: 'x' }, 'allow'],
  ['mcp__other__thing', {}, 'deny'],
];
let bad = 0;
let extraCount = 0;
// Workers do not get the mind tools.
for (const t of ['mcp__mind__ask_mind', 'mcp__mind__remember', 'mcp__mind__save_knowledge']) {
  const out = await fenceHook('go')({ tool_name: t, tool_input: {}, agent_id: 'w1' });
  if (out?.hookSpecificOutput?.permissionDecision !== 'deny') { bad++; console.log(`MISMATCH worker may not call ${t}`); }
}
// Her eyes (main thread Bash): read-only allowlist.
const looks = [
  'git log --oneline -5', 'git -C /x diff HEAD~1', 'git status', 'git branch -a', 'git show abc123 --stat',
  'git remote -v', 'git ls-remote origin', 'gh pr view 174', 'gh pr checks 174', 'gh run list --limit 5',
  'gh api repos/o/r/pulls/1', 'gh api -X GET repos/o/r/pulls', 'ls -la /tmp', 'cat /tmp/a.log | tail -50',
  'grep -rn "a|b" src', 'rg foo | wc -l', 'find . -name "*.png"', 'curl -s https://example.com/health', 'lsof -i :4747',
  'ps aux | grep node', 'git log --oneline | head -3', 'date', 'git rev-parse HEAD', 'stat x', 'pwd',
];
const notLooks = [
  'git push', 'git push origin feat-x', 'gh pr merge 174', 'gh pr create --fill', 'gh api -X POST repos/o/r/issues',
  'gh api repos/o/r/issues -f title=x', 'gh api --method PATCH repos/o/r', 'curl -d a=b https://x', 'curl -X POST https://x',
  'curl -o out.txt https://x', 'cat x > y', 'cat x >> y', 'ls; rm -rf /', 'ls && rm x', 'ls || rm x', 'find . -delete',
  'find . -exec rm {} +', 'git log | sh', 'cat x | tee y', 'echo hi', 'FOO=1 ls', 'cd /tmp && ls', 'ls `whoami`', 'ls $(whoami)',
  'cat <(ls)', 'git commit -m x', 'git branch -D x', 'git checkout main', 'git -c core.pager=sh log', 'sudo ls', 'rm x', 'kill 123',
  'ls | xargs rm', 'sort -o out.txt in.txt', 'git diff --output=x', 'tail -f x.log', 'npm test', 'node x.js', 'git stash',
];
for (const c of looks) { const got = await main('Bash', { command: c }); if (got !== 'allow') { bad++; console.log(`MISMATCH eyes ${c} got=${got} expected=allow`); } }
for (const c of notLooks) { const got = await main('Bash', { command: c }); if (got !== 'deny') { bad++; console.log(`MISMATCH eyes ${c} got=${got} expected=deny`); } }
for (const [tool, input, exp] of mainCases) {
  const got = await main(tool, input);
  if (got !== exp) { bad++; console.log(`MISMATCH main ${tool} ${JSON.stringify(input)} got=${got} expected=${exp}`); }
}
for (const [msg, cmd, exp] of cases) {
  const got = await run(msg, cmd);
  if (got !== exp) { bad++; console.log(`MISMATCH  msg=${JSON.stringify(msg)}  cmd=${JSON.stringify(cmd)}  got=${got} expected=${exp}`); }
}

// ── eyes: && between read-only commands, 2>/dev/null, git -C, sed -n / jq in a pipe, helpful denials ──
const eyesOk = [
  'git status && git log --oneline -3', 'ls && pwd', 'git -C /x log --oneline -3 2>/dev/null', 'ls /nope 2>/dev/null', 'ls 2>&1 | head',
  'git -C "/a b/c" status', 'git -C /x -C sub diff HEAD~1', 'git -C /x branch --show-current', 'gh pr view 1 && gh pr checks 1',
  'cat a.log | sed -n 1,20p', 'cat a.log | sed -n "/error/p"', 'cat a.log | sed -n "5p;9p"', 'gh api repos/o/r/pulls | jq ".[0].title"', 'git -C /x log 2>/dev/null | jq -r .',
  'git log --oneline | sed -n "$p"',
];
const eyesNo = [
  ['ls && rm x', /changes things/], ['ls ; ls', /own call/], ['ls & ls', /own call/], ['ls || ls', /own call/], ['cd /tmp && ls', /pass the path/],
  ['git -C /x push', /not a read-only/], ['git -C /x checkout main', /not a read-only/], ['git -c core.pager=sh log', /not a read-only/],
  ['cat a | sed -i s/a/b/', /sed/], ['cat a | sed s/a/b/', /sed/], ['cat a | sed -n w/tmp/x', /sed/], ['cat a | sed -n -f s.sed', /sed/], ['cat a | sed -ni 1p', /sed/], ['cat a | sed -n "1e ls"', /sed/],
  ['ls > out', /redirects/], ['ls 2>out', /redirects/], ['ls 2>/dev/null > out', /redirects/], ['ls $(pwd)', /substitution|expansion/], ['echo hi && ls', /not a read-only/], ['ls && ls &&', /empty/],
  ['cat a | tee b', /changes things/], ['cat a | python3 -c 1', /cannot pipe/],
];
for (const c of eyesOk) { const r = readOnlyBash(c); if (!r.ok) { bad++; console.log(`MISMATCH eyes-ok ${c} why=${r.why}`); } }
for (const [c, re] of eyesNo) { const r = readOnlyBash(c); if (r.ok || !re.test(r.why)) { bad++; console.log(`MISMATCH eyes-no ${c} got=${JSON.stringify(r)} expected why ${re}`); } }
extraCount += eyesOk.length + eyesNo.length;

// ── migrations only against a throwaway local database named on the same command line ──
const dbCases = [
  ['DATABASE_URL=postgresql://u:p@localhost:5432/app_test npx prisma migrate deploy', 'allow'],
  ['DATABASE_URL="postgresql://u:p@127.0.0.1:5432/app_fidelity?schema=public&x=1" pnpm prisma migrate reset --force', 'allow'],
  ["cd packages/database && DATABASE_URL='postgresql://localhost/app_scratch' npx prisma db push", 'allow'],
  ['export DATABASE_URL=postgresql://localhost/app_tmp && npx prisma migrate deploy', 'allow'],
  ['DATABASE_URL=postgresql://localhost/app npx prisma migrate deploy', 'deny'],                    // not a throwaway name
  ['DATABASE_URL=postgresql://localhost/app_test_prod npx prisma migrate deploy', 'deny'],
  ['DATABASE_URL=postgresql://db.example.com/app_test npx prisma migrate deploy', 'deny'],          // not localhost
  ['DATABASE_URL=postgresql://localhost@evil.com/app_test npx prisma migrate deploy', 'deny'],
  ['DATABASE_URL=postgresql://u:p@evil.com@localhost/app_test npx prisma migrate deploy', 'deny'],
  ['npx prisma migrate deploy', 'deny'],                                                            // no DATABASE_URL on the line
  ['npx prisma db push', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test npx prisma migrate dev', 'deny'],                  // dev never
  ['DATABASE_URL=postgresql://localhost/app_test pnpm db:migrate', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test pnpm db:seed', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test npx prisma db execute --file x.sql', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test npx prisma migrate deploy && npx prisma migrate deploy', 'deny'], // second one has no URL
  ['DATABASE_URL=postgresql://localhost/app_test; npx prisma migrate deploy', 'deny'],              // not exported
  ['DATABASE_URL=$PROD_URL npx prisma migrate deploy', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test DIRECT_URL=postgresql://prod.host/app npx prisma migrate deploy', 'deny'],
  ['DATABASE_URL=postgresql://localhost/app_test DATABASE_URL=postgresql://localhost/app npx prisma migrate deploy', 'deny'],
  ['DATABASE_URL=file:./dev_test.db npx prisma migrate deploy', 'deny'],
];
for (const [cmd, exp] of dbCases) {
  const got = await run('go', cmd);
  if (got !== exp) { bad++; console.log(`MISMATCH db ${cmd} got=${got} expected=${exp}`); }
}
extraCount += dbCases.length;
if (!throwawayDbUrl('postgresql://u:p@localhost:5432/x_test') || throwawayDbUrl('postgresql://u:p@localhost:5432/x')) { bad++; console.log('MISMATCH throwawayDbUrl'); }
extraCount++;
// the main thread never runs them, even on a throwaway database (not a read-only look)
{ const got = await main('Bash', { command: 'DATABASE_URL=postgresql://localhost/app_test npx prisma migrate deploy' }); if (got !== 'deny') { bad++; console.log('MISMATCH main may not migrate'); } extraCount++; }

// ── the push gate: one message at a time, per dispatch, one push, item-aware ──
const wk = (gate, agent, command) => fenceHook(null, null, gate)({ tool_name: 'Bash', tool_input: { command }, agent_id: agent });
const ruling = async (gate, agent, command) => (await wk(gate, agent, command))?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
const reasonOf = async (gate, agent, command) => (await wk(gate, agent, command))?.hookSpecificOutput?.permissionDecisionReason || '';
const check = (name, got, exp) => { extraCount++; if (got !== exp) { bad++; console.log(`MISMATCH gate ${name} got=${got} expected=${exp}`); } };
const dispatch = (gate, id, desc) => fenceHook(null, null, gate)({ tool_name: 'Agent', tool_input: { description: desc }, tool_use_id: id });
const taskStarted = (gate, id, task) => gate.bindTask(id, task);
{
  // expiry: a message without a push word clears the live allowance
  const g = createPushGate();
  g.onMessage('push it');
  check('live push allowed', await ruling(g, 'w1', 'git push origin feat-x'), 'allow');
  g.onMessage('what is next?');
  check('expired after a new message without push', await ruling(g, 'w1', 'git push origin feat-x'), 'deny');
  g.onMessage('I merged the PR');
  check('I merged the PR unlocks nothing', await ruling(g, 'w1', 'git push origin feat-x'), 'deny');
  g.onMessage('push it');
  check('a fresh push word unlocks again', await ruling(g, 'w1', 'git push origin feat-x'), 'allow');
}
{
  // dispatch-keyed: the worker dispatched in reply to "push" still pushes minutes later, after other messages
  const g = createPushGate();
  g.onMessage('push it');
  await dispatch(g, 'tu1', '[Tracking] push the branch');
  taskStarted(g, 'tu1', 'agent-A');
  g.onMessage('how is the other thing going?');
  check('dispatched worker still allowed after a later message', await ruling(g, 'agent-A', 'git push origin feat-x'), 'allow');
  // a worker dispatched AFTER the push-less message gets nothing
  await dispatch(g, 'tu2', '[Other] build');
  taskStarted(g, 'tu2', 'agent-B');
  check('worker dispatched without a push word is denied', await ruling(g, 'agent-B', 'git push origin feat-y'), 'deny');
  // one push per worker: after it succeeds the same worker cannot push again
  await postPushHook(g)({ tool_name: 'Bash', tool_input: { command: 'git push origin feat-x' }, agent_id: 'agent-A' });
  check('one-shot: second push by the same worker denied', await ruling(g, 'agent-A', 'git push origin feat-x'), 'deny');
  g.finish('agent-A');
}
{
  // two workers dispatched in one push turn each get their push
  const g = createPushGate();
  g.onMessage('push both');
  await dispatch(g, 'a', '[One] push'); await dispatch(g, 'b', '[Two] push');
  taskStarted(g, 'a', 'wa'); taskStarted(g, 'b', 'wb');
  await postPushHook(g)({ tool_name: 'Bash', tool_input: { command: 'git push origin one' }, agent_id: 'wa' });
  check('second worker still has its push', await ruling(g, 'wb', 'git push origin two'), 'allow');
}
{
  // worker ids that differ from task ids are still tied to their dispatch (first sight claims the oldest unclaimed)
  const g = createPushGate();
  g.onMessage('push it');
  await dispatch(g, 'x', '[Mind] push');
  g.onMessage('later chatter');
  check('unbound worker claims its dispatch', await ruling(g, 'unrelated-id', 'git push origin mind-branch'), 'allow');
}
{
  // item awareness
  const g = createPushGate();
  g.onMessage('push tracking');
  await dispatch(g, 't1', '[Mind tracking] push the commit');
  await dispatch(g, 't2', '[Offer reveal] push the branch');
  taskStarted(g, 't1', 'w1'); taskStarted(g, 't2', 'w2');
  check('matching item allowed', await ruling(g, 'w1', 'git push origin feat-x'), 'allow');
  check('item mismatch denied', await ruling(g, 'w2', 'git push origin offer-reveal'), 'deny');
  const why = await reasonOf(g, 'w2', 'git push origin offer-reveal');
  check('mismatch message names the item', why.includes('push is for "tracking" — ask the person which item before pushing this one'), true);
  check('mismatch message carries the Ask sentence', /Ask: "Say push .+ to send/.test(why), true);
  const g2 = createPushGate();
  g2.onMessage('push PR 154');
  await dispatch(g2, 'p1', '[Search page] push'); taskStarted(g2, 'p1', 'wa');
  check('PR number mismatch denied', await ruling(g2, 'wa', 'git push origin smart-chat'), 'deny');
  check('PR number named in the command matches', await ruling(g2, 'wa', 'gh pr create --title "x (#154)"'), 'allow');
  const g3 = createPushGate();
  g3.onMessage('push the mind PR');
  await dispatch(g3, 'm1', '[Checkout PR] push'); taskStarted(g3, 'm1', 'wm');
  check('item word matches the task tag', await ruling(g3, 'wm', 'git push origin minds'), 'allow');
  const g4 = createPushGate();
  g4.onMessage('push it');
  await dispatch(g4, 'n1', '[Anything] push'); taskStarted(g4, 'n1', 'wn');
  check('no item named → no item check', await ruling(g4, 'wn', 'git push origin whatever'), 'allow');
}
{
  // every push deny tells her the sentence to ask
  const g = createPushGate();
  const why = await reasonOf(g, 'w9', 'git push origin feat-x');
  check('locked push carries Ask', /Ask: "Say push feat-x to send it\."/.test(why), true);
  const why2 = await reasonOf(g, 'w9', 'gh pr create --fill');
  check('locked PR carries Ask', /Ask: "Say create PR for .+ to open it\."/.test(why2), true);
  const why3 = await reasonOf(g, 'w9', 'git push origin main');
  check('main push carries Ask', /Ask: "/.test(why3), true);
  // worker denials are queued for her next turn
  const queued = takeBlocked();
  check('worker denials are queued', queued.length >= 3 && queued.every((b) => b.why), true);
  check('queue drains', takeBlocked().length, 0);
}
// intent + item extraction
const intents = [
  ['I merged the PR', false, null], ['push it', true, null], ['PUSH tracking.', true, 'tracking'], ['push #154', true, '#154'], ['create PR for the mind work', true, 'mind'],
  ['ok now push', true, null], ['test passed', true, null], ['it passed', false, null], ['no PR yet', false, null], ["don't push", false, null], ['PR', true, null], ['lgtm', true, null],
  ['PR status?', false, null],
];
for (const [t, unlock, item] of intents) { const i = pushIntent(t); check(`intent ${t}`, `${i.unlock}/${i.item}`, `${unlock}/${item}`); }
check('known task name is the item', namedItem('push search page please', ['Search page']), 'Search page');

// TrueMemory is required: not connected is a setup item with a one-line fix.
if (!/not connected/.test(tmSetupLine(false)) || !/Connect TrueMemory/.test(tmSetupLine(false)) || !/connected/.test(tmSetupLine(true))) { bad++; console.log('MISMATCH tm setup line'); }
console.log(bad ? `FAILED (${bad})` : `fence: all ${cases.length + mainCases.length + looks.length + notLooks.length + extraCount} cases ok`);
process.exit(bad ? 1 : 0);
