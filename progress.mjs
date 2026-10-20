// Progress and standing rules live in the person's TrueMemory and update themselves.
//   - a plain-words progress memory per task, written only when its stage / state / focus changed
//   - knowledge doc "current-work.md" (focus + pending), replaced at most every 30 minutes when it changed
//   - knowledge doc "standing-rules.md", replaced when standing-rules.md or agreement.md changed
// Pure helpers are tested without network (progress.test.mjs); run() does the I/O and never throws.
import fs from 'node:fs';
import path from 'node:path';
import * as tm from './tm.mjs';
import { loadGlossary, resolveProject, resolveFeature, monthYear, checkPlain } from './memshape.mjs';
import { sha256, loadMap } from './seed.mjs';

export const DOC_EVERY_MS = 30 * 60 * 1000;
export const DEBOUNCE_MS = 20 * 1000;

const STAGE_WORDS = {
  plan: 'being planned',
  build: 'being built',
  fix: 'being fixed after a review or a failed test',
  verify: 'built, now being proven to work',
  ready: 'built and proven, waiting for the person to test it',
  test: 'being tested by the person',
  pr: 'sent for review',
  checking: 'in its final safety check before merging',
  safe: 'safe to merge, waiting for the person to merge',
  merged: 'merged',
};
const stageWords = (s) => STAGE_WORDS[s] || STAGE_WORDS.plan;
const DONE_STAGES = new Set(['merged', 'done']);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripEnd = (s) => clean(s).replace(/[\s.;:,]+$/, '');
/** A free-text bit is kept only when it already reads as plain product words (no PR numbers, branches, paths). */
const plainOr = (s) => { const t = stripEnd(s); return t && checkPlain(t).ok ? t : ''; };

/** { project, feature } in canonical names (glossary aliases resolved), else the card's project + title as-is. */
export function canonicalNames(task, glossary) {
  const rawProject = clean(task?.project);
  const rawFeature = clean(task?.title) || clean(task?.name);
  const project = (glossary && rawProject && resolveProject(glossary, rawProject)) || rawProject;
  const feature = (glossary && project && (resolveFeature(glossary, project, rawFeature) || resolveFeature(glossary, project, clean(task?.name)))) || rawFeature;
  return { project, feature };
}

/** What counts as a change: stage, state, focus. (now / line wording alone does not.) */
export const signature = (t) => `${clean(t?.stage) || 'plan'}|${clean(t?.state) || 'waiting'}|${t?.focus === false ? 'pending' : 'focus'}`;
export const isDone = (t) => DONE_STAGES.has(clean(t?.stage));
const keyOf = (t) => clean(t?.name) || clean(t?.title);

export function progressNote(task, glossary, now = new Date()) {
  const { project, feature } = canonicalNames(task, glossary);
  const head = project ? `${project} · ${feature}` : feature;
  const focus = task?.focus !== false;
  const state = clean(task?.state);
  const bits = [`${focus ? 'in progress, in focus' : 'waiting its turn'} — ${stageWords(clean(task?.stage) || 'plan')}`];
  if (state === 'needs-you') bits[0] += ', waiting on the person';
  else if (state === 'blocked') bits[0] += ', blocked';
  const nowTxt = plainOr(task?.now);
  const nextTxt = plainOr(task?.line);
  if (nowTxt) bits.push(`now: ${nowTxt}`);
  if (nextTxt) bits.push(`next: ${nextTxt}`);
  return `${head}: ${bits.join('; ')}. (${monthYear(null, now)})`;
}
export const doneNote = (project, feature, now = new Date()) => `${project ? `${project} · ${feature}` : feature}: done. (${monthYear(null, now)})`;

/**
 * tasks: raw main-tasks.json array; last: { [taskKey]: { sig, project, feature } } (the .progress.json "tasks").
 * → { writes: [{ key, text, sig, done }], next } — `next` is the state to save once the writes landed.
 * An empty/invalid task list never retires anything (a half-written file must not mark every task done).
 */
export function diffProgress(tasks, last = {}, glossary = null, now = new Date()) {
  const writes = [];
  const next = {};
  if (!Array.isArray(tasks) || !tasks.length) return { writes, next: { ...last } };
  const seen = new Set();
  for (const t of tasks) {
    const key = keyOf(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const names = canonicalNames(t, glossary);
    const prev = last[key];
    const done = isDone(t);
    const sig = done ? 'done' : signature(t);
    next[key] = { sig, ...names };
    if (prev && prev.sig === sig) continue;
    writes.push({ key, sig, done, text: done ? doneNote(names.project, names.feature, now) : progressNote(t, glossary, now) });
  }
  for (const [key, prev] of Object.entries(last)) {
    if (seen.has(key)) continue;
    if (prev.sig !== 'done') writes.push({ key, sig: 'done', done: true, gone: true, text: doneNote(prev.project, prev.feature, now) });
    // a task that is gone and already retired drops out of the state
  }
  return { writes, next };
}

// ── knowledge docs ──
const TASK_LINE = (t, glossary) => {
  const { project, feature } = canonicalNames(t, glossary);
  const nextTxt = plainOr(t?.line);
  return `- ${feature}${project ? ` (${project})` : ''} — ${stageWords(clean(t?.stage) || 'plan')}${nextTxt ? `. Next: ${nextTxt}` : ''}.`;
};
/** Plain-language snapshot of focus + pending (no date stamp inside, so an unchanged state hashes the same). */
export function currentWorkDoc(tasks, glossary = null) {
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => keyOf(t) && !isDone(t));
  const focus = open.filter((t) => t.focus !== false);
  const pending = open.filter((t) => t.focus === false);
  const sec = (title, list) => `## ${title}\n${list.length ? list.map((t) => TASK_LINE(t, glossary)).join('\n') : '- Nothing.'}`;
  return `# Current work\nWhere the person's work stands right now: what is in focus and what is waiting its turn.\n\n${sec('In focus', focus)}\n\n${sec('Waiting its turn', pending)}\n`;
}
/** The standing rules doc, or '' while the file still holds only its header. */
export function standingRulesDoc(text) {
  const t = String(text || '');
  return /^\s*\d+[.)]\s+\S/m.test(t) ? t : '';
}

// ── state on disk ──
export function loadState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { tasks: s.tasks || {}, docs: s.docs || {} }; } catch { return { tasks: {}, docs: {} }; }
}
function saveState(file, s) { try { fs.writeFileSync(file, JSON.stringify(s, null, 1) + '\n'); } catch {} }
function writeMapKey(hub, key, value) {
  const f = path.join(hub, 'mind', 'tm-sync.json');
  let m = {};
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  m[key] = value;
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
}
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

async function replaceDoc(client, hub, mapKey, filename, markdown) {
  const old = loadMap(hub)[mapKey];
  const { brainId } = await client.ensureBrain();
  const up = await client.uploadNote(filename, markdown, { brainId }); // new first, so a failed upload keeps the old doc
  writeMapKey(hub, mapKey, { packId: up.packId, sha256: sha256(markdown), uploadedAt: new Date().toISOString(), name: filename });
  if (old?.packId && old.packId !== up.packId) await client.deletePack(old.packId).catch(() => {});
  return up;
}

/**
 * One pass. Everything it needs is injectable for tests; defaults are the real TrueMemory client.
 * Never throws; "not connected" does nothing.
 */
export async function run({ hub, stateFile, log = () => {}, now = Date.now(), force = false, client = tm } = {}) {
  const out = { skipped: null, memories: 0, docs: [], nextDocAt: 0 };
  try {
    const st = await client.status();
    if (!st?.connected) { out.skipped = 'not connected'; return out; }
    const state = loadState(stateFile);
    const glossary = loadGlossary(hub);
    let tasks = null;
    try { tasks = JSON.parse(readText(path.join(hub, 'mind', 'main-tasks.json'))); } catch {}

    // 1. progress memories
    if (Array.isArray(tasks)) {
      const { writes, next } = diffProgress(tasks, state.tasks, glossary, new Date(now));
      if (writes.length) {
        try {
          await client.addMemoriesBulk(writes.map((w) => w.text), { sourceDescription: 'Sahar progress' });
          for (const w of writes) log(`[progress] wrote: ${w.text}`);
          out.memories = writes.length;
          state.tasks = next;
        } catch (err) { log(`[progress] memory write failed: ${tm.friendlyError(err)}`); }
      } else state.tasks = next;
    }

    // 2. current-work.md — at most every 30 minutes, only when changed
    if (Array.isArray(tasks)) {
      const doc = currentWorkDoc(tasks, glossary);
      const sha = sha256(doc);
      const d = state.docs['current-work'] || {};
      if (d.sha !== sha) {
        const wait = (d.at || 0) + DOC_EVERY_MS - now;
        if (wait > 0 && !force) out.nextDocAt = now + wait;
        else {
          try {
            const up = await replaceDoc(client, hub, 'current-work', 'current-work.md', doc);
            state.docs['current-work'] = { sha, at: now };
            out.docs.push('current-work.md');
            log(`[progress] replaced current-work.md (pack ${up.packId})`);
          } catch (err) { log(`[progress] current-work.md not replaced: ${tm.friendlyError(err)}`); }
        }
      }
    }

    // 3. standing-rules.md — when standing-rules.md or agreement.md changed
    const rules = readText(path.join(hub, 'mind', 'standing-rules.md'));
    const sig = sha256(rules + '\u0000' + readText(path.join(hub, 'mind', 'agreement.md')));
    const body = standingRulesDoc(rules);
    const r = state.docs['standing-rules'] || {};
    if (r.sig !== sig) {
      if (!body) { state.docs['standing-rules'] = { ...r, sig }; }
      else {
        try {
          const up = await replaceDoc(client, hub, 'standing-rules', 'standing-rules.md', body);
          state.docs['standing-rules'] = { sig, at: now };
          out.docs.push('standing-rules.md');
          log(`[progress] replaced standing-rules.md (pack ${up.packId})`);
        } catch (err) { log(`[progress] standing-rules.md not replaced: ${tm.friendlyError(err)}`); }
      }
    }
    saveState(stateFile, state);
  } catch (err) {
    out.skipped = `failed: ${tm.friendlyError(err)}`;
  }
  return out;
}

/** Debounced trigger for the file watchers; one run at a time, a doc held back by the 30-minute limit re-arms itself. */
export function createScheduler({ hub, stateFile, log = () => {}, debounceMs = DEBOUNCE_MS, runner = run } = {}) {
  let timer = null;
  let running = false;
  let again = false;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(go, ms); timer.unref?.(); };
  async function go() {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try {
      const r = await runner({ hub, stateFile, log });
      if (r.nextDocAt) arm(Math.max(r.nextDocAt - Date.now(), 1000) + 500);
    } catch (err) { log(`[progress] ${err?.message}`); }
    running = false;
    if (again) { again = false; arm(debounceMs); }
  }
  return { poke: () => arm(debounceMs), cancel: () => clearTimeout(timer) };
}
