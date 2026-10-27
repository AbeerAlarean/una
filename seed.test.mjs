import assert from 'node:assert/strict';
import { packNames, diffSync, splitDecisions, lastEntryDate, episodesOf, newDecisionEntries, chunkEpisodes, sha256 } from './seed.mjs';

const names = packNames(['api-service.md', 'x.txt'], ['hub.md']);
assert.deepEqual(names.map((n) => n.name), ['project-api-service.md', 'history-hub.md', 'how-i-work.md', 'una-lessons.md', 'done.md']);
assert.equal(names[0].rel, 'mind/repos/api-service.md');

const md = `# Decisions\npreamble\n\n## 2026-10-10 23:55 Their call: A\nbecause B\n\n## api-service\n- rule one\n\n## 2026-10-08/09 Launch week\nwhy\n`;
const es = splitDecisions(md);
assert.equal(es.length, 3);
assert.match(es[0].text, /because B/);
assert.equal(es[0].date, '2026-10-10');
assert.equal(es[1].date, null);
assert.equal(es[2].date, '2026-10-08');
assert.equal(lastEntryDate(es), '2026-10-10');
assert.deepEqual(splitDecisions('# only title\n'), []);
assert.equal(splitDecisions('## one-liner with the reason inline\n\n## real\nbody here').length, 2);

assert.equal(newDecisionEntries(es, [es[0].hash]).length, 2);
assert.equal(newDecisionEntries(es, []).length, 3);

const long = { heading: '2026-10-10 big', text: '## 2026-10-10 big\n' + Array.from({ length: 200 }, (_, i) => `line ${i} ` + 'x'.repeat(100)).join('\n') };
const parts = episodesOf(long, 5000);
assert.ok(parts.length > 2);
assert.ok(parts.every((p) => p.length <= 5200 && p.startsWith('## 2026-10-10 big (part ')));
assert.equal(episodesOf(es[0]).length, 1);

const many = Array.from({ length: 120 }, (_, i) => `entry ${i}`);
const b = chunkEpisodes(many);
assert.deepEqual(b.map((x) => x.length), [50, 50, 20]);
assert.equal(chunkEpisodes(['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)], 50, 700).length, 2);
assert.deepEqual(chunkEpisodes([]), []);

const src = [
  { name: 'a.md', rel: 'r/a', text: 'one' },
  { name: 'b.md', rel: 'r/b', text: 'two' },
  { name: 'c.md', rel: 'r/c', text: 'three' },
  { name: 'big.md', rel: 'r/big', text: 'x'.repeat(201 * 1024) },
  { name: 'empty.md', rel: 'r/e', text: '  \n' },
];
const map = { 'b.md': { packId: 'p2', sha256: sha256('two') }, 'c.md': { packId: 'p3', sha256: sha256('old') } };
const d = diffSync(src, map);
assert.deepEqual(d.upload.map((x) => x.name), ['a.md']);
assert.deepEqual(d.unchanged.map((x) => x.name), ['b.md']);
assert.deepEqual(d.replace.map((x) => [x.name, x.oldPackId]), [['c.md', 'p3']]);
assert.deepEqual(d.skipped.map((x) => [x.name, x.why]), [['big.md', 'over 200 KB'], ['empty.md', 'empty']]);
console.log('seed: all ok');
