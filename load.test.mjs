import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNudge, openTasks } from './checks.mjs';
const mk = (n, stage = 'build') => ({ name: `T${n}`, stage });
test('load nudge: fires once for a new task at >= limit, names the 2 nearest to done', () => {
  const base = [mk(1, 'plan'), mk(2, 'pr'), mk(3, 'safe'), mk(4, 'build'), mk(5, 'ready'), mk(6, 'build'), mk(7, 'merged'), mk(8, 'build')];
  const known = new Set(base.map((t) => t.name));
  assert.deepEqual(loadNudge(base, known, 8), {}); // nothing new
  const withNew = [...base, mk(9, 'plan')]; // 8 open (T7 merged)
  const r = loadNudge(withNew, known, 8);
  assert.match(r.note, /^<load>You now have 8 open\./);
  assert.match(r.note, /close T3 or T5 first/);
  assert.deepEqual(loadNudge(withNew, known, 8), {}); // once per new task
  assert.equal(openTasks(withNew).length, 8);
});
test('load nudge: below the limit stays quiet but the name is still remembered', () => {
  const known = new Set();
  assert.deepEqual(loadNudge([mk(1), mk(2)], known, 8), {});
  assert.ok(known.has('T1'));
});
