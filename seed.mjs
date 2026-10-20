// Seeds and re-syncs Sahar's mind (the hub's own notes) into the person's TrueMemory mind (TM_MIND_ID, else the mind named "Sahar").
// decisions.md is NOT sent as memory any more: decisions reach TrueMemory only through remember() in the one shape
// (Project · Feature: what. Why: why. (Month YYYY)); see memshape.mjs.
//   npm run seed          dry run: prints the plan and writes mind/tm-seed-plan.md
//   npm run seed:apply    uploads (idempotent: unchanged files skip, changed files are replaced)
// The pure helpers below are tested without network (seed.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tm from './tm.mjs';

export const HUB = process.env.HUB_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub');
export const MAX_PACK_BYTES = 200 * 1024;
const MAX_EPISODE_CHARS = 45000; // the route allows 50,000 per episode
const MAX_BATCH_EPISODES = 50;
const MAX_BATCH_BYTES = 600000; // the route allows 700,000 serialized

// ── pure helpers ──
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Which hub files become which knowledge packs: [{ name, rel }] (files must exist; checked by the caller). */
export function packNames(repoFiles, historyFiles) {
  const md = (f) => f.replace(/\.md$/, '');
  return [
    ...repoFiles.filter((f) => f.endsWith('.md')).sort().map((f) => ({ name: `project-${md(f)}.md`, rel: `mind/repos/${f}` })),
    ...historyFiles.filter((f) => f.endsWith('.md')).sort().map((f) => ({ name: `history-${md(f)}.md`, rel: `history/${f}` })),
    { name: 'how-i-work.md', rel: 'mind/agreement.md' },
    { name: 'sahar-lessons.md', rel: 'mind/lessons.md' },
    { name: 'done.md', rel: 'mind/done.md' },
  ];
}

/** sources: [{ name, rel, text }]; map: { [name]: { packId, sha256, uploadedAt } } → what to do with each. */
export function diffSync(sources, map = {}) {
  const out = { upload: [], replace: [], unchanged: [], skipped: [] };
  for (const s of sources) {
    const bytes = Buffer.byteLength(s.text || '');
    if (!s.text || !s.text.trim()) { out.skipped.push({ ...s, bytes, why: 'empty' }); continue; }
    if (bytes > MAX_PACK_BYTES) { out.skipped.push({ ...s, bytes, why: `over ${Math.round(MAX_PACK_BYTES / 1024)} KB` }); continue; }
    const prev = map[s.name];
    const sha = sha256(s.text);
    if (!prev || !prev.packId) out.upload.push({ ...s, bytes, sha });
    else if (prev.sha256 === sha) out.unchanged.push({ ...s, bytes, sha });
    else out.replace.push({ ...s, bytes, sha, oldPackId: prev.packId });
  }
  return out;
}

const DATE_RE = /(20\d\d-\d\d-\d\d)(?:\/(\d\d))?/;
/** decisions.md → one entry per "## " section: { heading, text, date, hash }. The preamble before the first heading is dropped. */
export function splitDecisions(md) {
  const entries = [];
  let cur = null;
  for (const line of String(md || '').split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) entries.push(cur);
      cur = { heading: line.slice(3).trim(), lines: [line] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) entries.push(cur);
  return entries
    .map((e) => {
      const text = e.lines.join('\n').trim();
      const m = e.heading.match(DATE_RE);
      return { heading: e.heading, text, date: m ? m[1] : null, hash: sha256(text) };
    })
    .filter((e) => e.heading.length > 0);
}

export function lastEntryDate(entries) {
  return entries.map((e) => e.date).filter(Boolean).sort().pop() || null;
}

/** An entry too long for one memory episode is cut at paragraph breaks; every part keeps the heading so the reason stays attached. */
export function episodesOf(entry, maxChars = MAX_EPISODE_CHARS) {
  if (entry.text.length <= maxChars) return [entry.text];
  const parts = [];
  let buf = '';
  for (const para of entry.text.split('\n')) {
    const piece = para.length > maxChars ? para.slice(0, maxChars) : para;
    if ((buf + '\n' + piece).length > maxChars - entry.heading.length - 20 && buf) { parts.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + piece;
  }
  if (buf) parts.push(buf);
  return parts.map((p, i) => `## ${entry.heading} (part ${i + 1}/${parts.length})\n${p.startsWith('## ') ? p.split('\n').slice(1).join('\n') : p}`);
}

/** Entries not yet in the sync map (by content hash). */
export function newDecisionEntries(entries, syncedHashes = []) {
  const seen = new Set(syncedHashes);
  return entries.filter((e) => !seen.has(e.hash));
}

/** Pack episodes into calls of ≤ maxCount and ≤ maxBytes serialized. */
export function chunkEpisodes(texts, maxCount = MAX_BATCH_EPISODES, maxBytes = MAX_BATCH_BYTES) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const t of texts) {
    const b = JSON.stringify(t).length;
    if (cur.length && (cur.length >= maxCount || bytes + b > maxBytes)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(t);
    bytes += b;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ── sync map on disk ──
const mapFile = (hub = HUB) => path.join(hub, 'mind', 'tm-sync.json');
export function loadMap(hub = HUB) {
  try { return JSON.parse(fs.readFileSync(mapFile(hub), 'utf8')); } catch { return {}; }
}
function saveMap(map, hub = HUB) {
  fs.writeFileSync(mapFile(hub), JSON.stringify(map, null, 2) + '\n');
}

// One writer at a time (seed, save_knowledge and the after-rotation sync can overlap).
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

function readSources(hub) {
  const ls = (rel) => { try { return fs.readdirSync(path.join(hub, rel)); } catch { return []; } };
  return packNames(ls('mind/repos'), ls('history')).map((p) => {
    let text = '';
    try { text = fs.readFileSync(path.join(hub, p.rel), 'utf8'); } catch {}
    return { ...p, text };
  });
}

function readDecisions(hub) {
  try { return splitDecisions(fs.readFileSync(path.join(hub, 'mind', 'decisions.md'), 'utf8')); } catch { return []; }
}

/** The plan: what an apply would do, without touching the network. Decisions are counted for information only; they are never sent. */
export function buildPlan(hub = HUB) {
  const map = loadMap(hub);
  const sources = readSources(hub);
  const files = diffSync(sources, map);
  const entries = readDecisions(hub);
  return { files, decisions: { total: entries.length, fresh: 0, episodes: 0, batches: 0, lastEntryDate: lastEntryDate(entries), retired: true }, _fresh: [], _entries: entries };
}

export function planMarkdown(plan, applied = false) {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const row = (f, verb) => `- ${verb}: \`${f.name}\` ← ${f.rel} (${kb(f.bytes)})`;
  const f = plan.files;
  return [
    `# TrueMemory seed plan${applied ? ' (applied)' : ' (dry run)'}`,
    '',
    `Generated ${new Date().toISOString()}. Knowledge goes into the "${tm.BRAIN_NAME}" brain of your Sahar mind; memories go to agent "${tm.AGENT_ID}" (type document).`,
    '',
    `## Knowledge packs — ${f.upload.length} to upload, ${f.replace.length} to replace, ${f.unchanged.length} unchanged, ${f.skipped.length} skipped`,
    ...f.upload.map((x) => row(x, 'upload')),
    ...f.replace.map((x) => row(x, 'replace')),
    ...f.unchanged.map((x) => row(x, 'unchanged')),
    ...f.skipped.map((x) => `- SKIPPED: \`${x.name}\` ← ${x.rel} (${kb(x.bytes)}, ${x.why})`),
    '',
    `## Memories (decisions.md)`,
    `- Not synced: decisions.md (${plan.decisions.total} entries, latest ${plan.decisions.lastEntryDate || 'n/a'}) is no longer sent as raw memory. Decisions reach TrueMemory only through remember(), in the one shape.`,
    '',
    'Run `npm run seed:apply` to upload. Re-running is safe: unchanged files are skipped.',
    '',
  ].join('\n');
}

/** Upload one named markdown (replacing an earlier one with the same name). Updates the sync map. */
export function saveKnowledge(name, markdown, { hub = HUB, rel } = {}) {
  return serial(async () => {
    if (!/^[\w.\- ]+\.md$/.test(name)) throw new tm.TmError('The note needs a plain filename ending in .md.');
    if (!markdown || !markdown.trim()) throw new tm.TmError('The note is empty.');
    if (Buffer.byteLength(markdown) > MAX_PACK_BYTES) throw new tm.TmError('The note is over 200 KB — split it.');
    const map = loadMap(hub);
    const sha = sha256(markdown);
    const prev = map[name];
    if (prev?.packId && prev.sha256 === sha) return { name, packId: prev.packId, status: 'unchanged' };
    const { brainId } = await tm.ensureBrain();
    if (prev?.packId) await tm.deletePack(prev.packId);
    const up = await tm.uploadNote(name, markdown, { brainId });
    const fresh = loadMap(hub);
    fresh[name] = { packId: up.packId, sha256: sha, uploadedAt: new Date().toISOString(), ...(rel ? { source: rel } : {}) };
    saveMap(fresh, hub);
    return { name, packId: up.packId, status: prev?.packId ? 'replaced' : 'uploaded' };
  });
}

/** Apply the plan. Each file's map entry is saved right after its upload, so a crash resumes cleanly. */
export function applySync({ hub = HUB, log = () => {} } = {}) {
  return serial(async () => {
    const plan = buildPlan(hub);
    const result = { uploaded: 0, replaced: 0, unchanged: plan.files.unchanged.length, skipped: plan.files.skipped, errors: [], memories: 0, packIds: 0 };
    const { brainId } = await tm.ensureBrain();
    for (const kind of ['upload', 'replace']) {
      for (const f of plan.files[kind]) {
        try {
          if (kind === 'replace') await tm.deletePack(f.oldPackId);
          const up = await tm.uploadNote(f.name, f.text, { brainId });
          const map = loadMap(hub);
          map[f.name] = { packId: up.packId, sha256: f.sha, uploadedAt: new Date().toISOString(), source: f.rel };
          saveMap(map, hub);
          result[kind === 'upload' ? 'uploaded' : 'replaced']++;
          log(`${kind} ${f.name} ok`);
        } catch (err) {
          result.errors.push({ item: f.name, error: tm.friendlyError(err) });
          log(`${kind} ${f.name} FAILED: ${tm.friendlyError(err)}`);
        }
      }
    }
    result.packIds = Object.keys(loadMap(hub)).filter((k) => k !== 'decisions').length;
    return result;
  });
}

// ── CLI ──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const plan = buildPlan();
  const md = planMarkdown(plan, apply);
  if (!apply) {
    fs.writeFileSync(path.join(HUB, 'mind', 'tm-seed-plan.md'), md);
    console.log(md);
    console.log(`Plan written to ${path.join(HUB, 'mind', 'tm-seed-plan.md')} — nothing was uploaded.`);
  } else {
    console.log(md);
    const r = await applySync({ log: (m) => console.log(`  ${m}`) });
    console.log(JSON.stringify({ uploaded: r.uploaded, replaced: r.replaced, unchanged: r.unchanged, skipped: r.skipped.map((s) => s.name), memories: r.memories, packsInMap: r.packIds, errors: r.errors }, null, 2));
    process.exit(r.errors.length ? 1 : 0);
  }
}
