import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideOpening, hubIsEmpty, RESTORE_NOTE } from './opening.mjs';

test('fresh hub + connected + mind has content -> restore', () => {
  assert.equal(decideOpening({ hubEmpty: true, tmConnected: true, mindHasContent: true }), 'restore');
});
test('fresh hub but nothing known -> blank-slate first contact', () => {
  assert.equal(decideOpening({ hubEmpty: true, tmConnected: true, mindHasContent: false }), 'first-contact');
  assert.equal(decideOpening({ hubEmpty: true, tmConnected: false, mindHasContent: true }), 'first-contact');
  assert.equal(decideOpening({ hubEmpty: true }), 'first-contact');
});
test('an existing hub is never restored', () => {
  assert.equal(decideOpening({ hubEmpty: false, tmConnected: true, mindHasContent: true }), 'normal');
  assert.equal(decideOpening({ hubEmpty: false, tmConnected: false, mindHasContent: false }), 'normal');
});
test('hubIsEmpty: missing/blank files are empty, real content is not', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  assert.equal(hubIsEmpty(d), true);
  fs.mkdirSync(path.join(d, 'mind'));
  fs.writeFileSync(path.join(d, 'mind', 'workload.md'), '# Workload\n');
  assert.equal(hubIsEmpty(d), true);
  fs.writeFileSync(path.join(d, 'mind', 'workload.md'), '# Workload\n' + 'a real line of work\n'.repeat(20));
  assert.equal(hubIsEmpty(d), false);
});
test('restore note asks for the four things and the rebuilt files', () => {
  for (const s of ['ask_mind', 'current-work.md', 'standing-rules.md', 'mind/workload.md', 'mind/agreement.md', 'mind/main-tasks.json', "We've met", 'not yet cloned']) assert.ok(RESTORE_NOTE.includes(s), s);
});
test('a hub fresh from the template (First Contact still pending) counts as empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.cpSync(new URL('./hub-template', import.meta.url), d, { recursive: true });
  assert.equal(hubIsEmpty(d), true);
  fs.writeFileSync(path.join(d, 'mind', 'agreement.md'), '# Our agreement\n' + 'a real rule\n'.repeat(30));
  fs.writeFileSync(path.join(d, 'mind', 'workload.md'), '# Workload\n' + 'a real line of work\n'.repeat(20));
  assert.equal(hubIsEmpty(d), false);
});
