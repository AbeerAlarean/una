import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signature, progressNote, doneNote, diffProgress, currentWorkDoc, standingRulesDoc, canonicalNames, run } from './progress.mjs';

const NOW = new Date(Date.UTC(2026, 9, 20));
const G = { projects: { Storefront: { aliases: ['shop'], features: { 'Checkout': { aliases: ['checkout experience'] } } } } };
const T = (o = {}) => ({ name: 'Checkout experience', title: 'The whole checkout experience', project: 'shop', stage: 'build', state: 'moving', now: 'Checks running', line: 'Waits for the go-ahead', focus: true, ...o });

test('names are canonicalised through the glossary, else used as-is', () => {
  assert.deepEqual(canonicalNames(T(), G), { project: 'Storefront', feature: 'Checkout' });
  assert.deepEqual(canonicalNames(T({ project: 'Other', name: 'x', title: 'My thing' }), G), { project: 'Other', feature: 'My thing' });
  assert.deepEqual(canonicalNames(T({ project: 'Other', name: 'x', title: 'My thing' }), null), { project: 'Other', feature: 'My thing' });
});
test('note shape: focus vs pending, stage in words, month', () => {
  assert.equal(progressNote(T(), G, NOW), 'Storefront · Checkout: in progress, in focus — being built; now: Checks running; next: Waits for the go-ahead. (October 2026)');
  const p = progressNote(T({ focus: false, stage: 'plan', now: '' }), G, NOW);
  assert.match(p, /waiting its turn — being planned/);
  assert.doesNotMatch(p, /now:/);
  assert.match(progressNote(T({ state: 'needs-you' }), G, NOW), /waiting on the person/);
});
test('technical bits never reach the note', () => {
  const n = progressNote(T({ now: 'PR #207 live', line: 'merge feat/checkout-x' }), G, NOW);
  assert.doesNotMatch(n, /#207|feat\//);
});
test('signature ignores wording, tracks stage/state/focus', () => {
  assert.equal(signature(T()), signature(T({ now: 'other', line: 'other' })));
  for (const o of [{ stage: 'fix' }, { state: 'blocked' }, { focus: false }]) assert.notEqual(signature(T()), signature(T(o)));
});
test('diff: first run writes all; unchanged writes nothing; a change writes one', () => {
  const tasks = [T(), T({ name: 'B', title: 'Beta', focus: false })];
  const a = diffProgress(tasks, {}, G, NOW);
  assert.equal(a.writes.length, 2);
  const b = diffProgress(tasks, a.next, G, NOW);
  assert.equal(b.writes.length, 0);
  const c = diffProgress([T({ stage: 'verify', now: 'x' }), tasks[1]], a.next, G, NOW);
  assert.equal(c.writes.length, 1);
  assert.match(c.writes[0].text, /proven to work/);
});
test('diff: merged writes done once; a vanished task writes done once and drops out', () => {
  const base = diffProgress([T(), T({ name: 'B', title: 'Beta' })], {}, G, NOW).next;
  const m = diffProgress([T({ stage: 'merged' }), T({ name: 'B', title: 'Beta' })], base, G, NOW);
  assert.equal(m.writes.length, 1);
  assert.equal(m.writes[0].text, 'Storefront · Checkout: done. (October 2026)');
  assert.equal(diffProgress([T({ stage: 'merged' }), T({ name: 'B', title: 'Beta' })], m.next, G, NOW).writes.length, 0);
  const gone = diffProgress([T()], base, G, NOW);
  assert.equal(gone.writes.length, 1);
  assert.match(gone.writes[0].text, /^Storefront · Beta: done\. \(October 2026\)$/);
  assert.equal(gone.next.B, undefined);
  assert.equal(diffProgress([T()], gone.next, G, NOW).writes.length, 0);
});
test('diff: an empty or invalid list retires nothing', () => {
  const base = diffProgress([T()], {}, G, NOW).next;
  assert.equal(diffProgress([], base, G, NOW).writes.length, 0);
  assert.equal(diffProgress(null, base, G, NOW).writes.length, 0);
  assert.deepEqual(diffProgress([], base, G, NOW).next, base);
});
test('current-work doc lists focus and pending, skips done, is stable', () => {
  const tasks = [T(), T({ name: 'B', title: 'Beta', focus: false, stage: 'plan' }), T({ name: 'C', title: 'Gamma', stage: 'merged' })];
  const d = currentWorkDoc(tasks, G);
  assert.match(d, /## In focus\n- Checkout \(Storefront\) — being built\. Next: Waits for the go-ahead\./);
  assert.match(d, /## Waiting its turn\n- Beta/);
  assert.doesNotMatch(d, /Gamma/);
  assert.equal(d, currentWorkDoc(tasks, G));
});
test('standing rules doc: header only is empty', () => {
  assert.equal(standingRulesDoc('# Standing rules\nEvery rule... Read at every boot.\n'), '');
  assert.ok(standingRulesDoc('# Standing rules\n1. Never push to main.\n'));
});

// run(): fake client, nothing touches the network or the real hub
function fakeClient(connected = true) {
  const calls = { bulk: [], up: [], del: [] };
  return { calls, status: async () => ({ connected }), addMemoriesBulk: async (t) => { calls.bulk.push(...t); }, ensureBrain: async () => ({ brainId: 'b' }) , uploadNote: async (n) => { calls.up.push(n); return { packId: `p${calls.up.length}` }; }, deletePack: async (id) => { calls.del.push(id); } };
}
test('run: not connected does nothing', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const c = fakeClient(false);
  const r = await run({ hub, stateFile: path.join(hub, 's.json'), client: c });
  assert.equal(r.skipped, 'not connected');
  assert.equal(fs.existsSync(path.join(hub, 's.json')), false);
});
test('run: writes changes once, docs throttled to 30 min, standing rules replaced when changed', async () => {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.mkdirSync(path.join(hub, 'mind'));
  fs.writeFileSync(path.join(hub, 'mind', 'main-tasks.json'), JSON.stringify([T()]));
  fs.writeFileSync(path.join(hub, 'mind', 'standing-rules.md'), '# Standing rules\n1. Never push to main.\n');
  const stateFile = path.join(hub, 's.json');
  const c = fakeClient();
  const t0 = Date.UTC(2026, 9, 20, 10);
  let r = await run({ hub, stateFile, client: c, now: t0 });
  assert.equal(r.memories, 1);
  assert.deepEqual(r.docs.sort(), ['current-work.md', 'standing-rules.md']);
  const map = JSON.parse(fs.readFileSync(path.join(hub, 'mind', 'tm-sync.json')));
  assert.ok(map['current-work'].packId && map['standing-rules'].packId);
  r = await run({ hub, stateFile, client: c, now: t0 + 1000 });
  assert.equal(r.memories, 0); assert.equal(r.docs.length, 0);
  fs.writeFileSync(path.join(hub, 'mind', 'main-tasks.json'), JSON.stringify([T({ stage: 'verify' })]));
  r = await run({ hub, stateFile, client: c, now: t0 + 60000 });
  assert.equal(r.memories, 1);
  assert.equal(r.docs.length, 0);
  assert.equal(r.nextDocAt, t0 + 30 * 60000);
  r = await run({ hub, stateFile, client: c, now: t0 + 31 * 60000 });
  assert.deepEqual(r.docs, ['current-work.md']);
  assert.equal(c.calls.del.length, 1);
  fs.writeFileSync(path.join(hub, 'mind', 'standing-rules.md'), '# Standing rules\n1. Never push to main.\n2. Short replies.\n');
  r = await run({ hub, stateFile, client: c, now: t0 + 32 * 60000 });
  assert.deepEqual(r.docs, ['standing-rules.md']);
  assert.equal(c.calls.bulk.length, 2);
});
