// One memory shape for everything una writes to TrueMemory:
//   "<Project> · <Parent> › <Feature>: <what>. Why: <why>. (<Month YYYY>)"   (no parent: "<Project> · <Feature>: ...")
// The path comes from mind/project-map.json: projects → features → sub-features, each with one plain line saying what it is.
// una keeps that map herself from the person's real work; mind/glossary.json is generated from it (older name table, kept readable).
// Pure helpers, tested without network (memshape.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = process.env.HUB_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub');
export const mapFile = (hub = HUB) => path.join(hub, 'mind', 'project-map.json');
export const glossaryFile = (hub = HUB) => path.join(hub, 'mind', 'glossary.json');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MAX_WHAT = 240;
export const MAX_WHY = 140;
export const MAX_NAME = 48;
export const MAX_WHAT_IS = 160;
export const STATUSES = ['active', 'shipped', 'parked'];

// ── project map ──
// File shape:   { projects: [{ name, what, aliases[], features: [{ name, what, aliases[], parent|null, status }] }] }
// In-memory:    { projects: { Name: { description, aliases, features: { Name: { description, aliases, parent, status } } } } }
// (the keyed form is what the name resolvers and progress.mjs use; the file form is what a person reads.)
export function mapToGlossary(map) {
  const out = { projects: {} };
  const list = Array.isArray(map?.projects) ? map.projects : [];
  for (const p of list) {
    const features = {};
    for (const f of p.features || []) features[f.name] = { description: f.what || '', aliases: f.aliases || [], parent: f.parent || null, status: f.status || 'active' };
    out.projects[p.name] = { description: p.what || '', aliases: p.aliases || [], features };
  }
  return out;
}
export function glossaryToMap(g) {
  return {
    _about: "Una's map of the person's real work: projects, the features inside them (one plain line each: what it is and how it contributes) and sub-features nested under a parent. Built from the person's own work and kept by una. Every memory is anchored to a path in this map: Project · Parent › Feature. glossary.json is generated from this file.",
    projects: Object.entries(g?.projects || {}).map(([name, p]) => ({
      name, what: p.description || '', aliases: p.aliases || [],
      features: Object.entries(p.features || {}).map(([fname, f]) => ({ name: fname, what: f.description || '', aliases: f.aliases || [], parent: f.parent || null, status: f.status || 'active' })),
    })),
  };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export function loadGlossary(hub = HUB) {
  const map = readJson(mapFile(hub));
  if (map && Array.isArray(map.projects)) return mapToGlossary(map);
  const old = readJson(glossaryFile(hub)); // older hubs: the flat glossary
  return old && old.projects && !Array.isArray(old.projects) ? old : { projects: {} };
}
/** Writes the project map (the file of record) and regenerates the older glossary file from it. */
export function saveGlossary(g, hub = HUB) {
  const map = glossaryToMap(g);
  fs.writeFileSync(mapFile(hub), JSON.stringify(map, null, 2) + '\n');
  fs.writeFileSync(glossaryFile(hub), JSON.stringify({ _about: 'Generated from project-map.json; edit the map, not this file.', projects: g.projects }, null, 2) + '\n');
}
export const loadProjectMap = loadGlossary;
export const saveProjectMap = saveGlossary;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/** Match a free-text name against canonical names + aliases of a { name: { aliases } } table. Exact first, then containment of a long alias. */
function matchName(table, input) {
  const n = norm(input);
  if (!n) return null;
  const entries = Object.entries(table || {});
  for (const [name, v] of entries) if (norm(name) === n) return name;
  for (const [name, v] of entries) if ((v.aliases || []).some((a) => norm(a) === n)) return name;
  let best = null;
  for (const [name, v] of entries) {
    for (const a of [name, ...(v.aliases || [])]) {
      const na = norm(a);
      if (na.length >= 6 && n.includes(na) && (!best || na.length > best.len)) best = { name, len: na.length };
    }
  }
  return best ? best.name : null;
}

export const resolveProject = (g, input) => matchName(g?.projects, input);
export const resolveFeature = (g, project, input) => matchName(g?.projects?.[project]?.features, input);

// ── plain-words check ──
const BANNED_WORDS = /\b(worktree|executor|hand-?off|migration catch-?up)\b/i;
const CHECKS = [
  ['a PR or issue number (#123)', /#\d+/],
  ['a PR number (PR 208)', /\bPRs?[\s-]?\d+\b/i],
  ['a ticket id (ABC-123)', /\b[A-Z]{3,}-\d+\b/],
  ['a branch name (feat/..., fix/..., chore/...)', /\b(?:feat|feature|fix|chore|hotfix|refactor)\/[\w.-]+/i],
  ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['a file name', /\b[\w-]+\.(?:mjs|cjs|tsx?|jsx?|json|md|py|css|html|sql|ya?ml|sh|prisma|lock)\b(?!\w)/i],
  ['an engineering word (worktree, executor, handoff, migration catch-up)', BANNED_WORDS],
];
const JS_BRANDS = /\b(?:next|node|vue|express|nuxt|chart|three|alpine)\.js\b/gi;

/** Token-level path test: leading / ~/ ./ ../, or 2+ slashes when the first part is not a web address. */
function hasFilePath(text) {
  for (const tok of String(text).split(/\s+/)) {
    const t = tok.replace(/^[("'`]+|[)"'`.,;:!?]+$/g, '');
    if (!t.includes('/') || /:\/\//.test(t)) continue;
    if (/^(?:~|\.{1,2})?\//.test(t) && /^(?:~|\.{1,2})?\/[\w.-]/.test(t)) return true;
    const parts = t.split('/');
    if (parts.length >= 3 && !/\.[a-z]{2,}$/i.test(parts[0])) return true;
  }
  return false;
}

/** → { ok, problems[] }. Text must read as plain product words to a non-technical reader. */
export function checkPlain(text) {
  const t = String(text || '').replace(JS_BRANDS, 'X');
  const problems = [];
  for (const [label, re] of CHECKS) {
    const m = t.match(re);
    if (m) problems.push(`${label}: "${m[0]}"`);
  }
  if (hasFilePath(t)) problems.push('a file path');
  return { ok: problems.length === 0, problems };
}

export const PLAIN_HELP = 'Rewrite it in plain product words a non-technical reader would understand: what changed for the product or the people using it, not which PR, branch, file, commit or work process produced it.';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripEnd = (s) => clean(s).replace(/[\s.;:,]+$/, '');

// ── dates ──
/** "2026-10-19", "2026-10", "October 2026", a Date, or nothing (= now) → "October 2026". */
export function monthYear(when, now = new Date()) {
  let d = now;
  if (when instanceof Date) d = when;
  else if (when) {
    const w = clean(when);
    let m = w.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, 15));
    else {
      m = w.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
      const mi = m ? MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3))) : -1;
      if (mi >= 0) d = new Date(Date.UTC(+m[2], mi, 15));
      else throw new ShapeError(`The date "${w}" is not understood. Use 2026-10-19, 2026-10 or "October 2026" (or leave it out for now).`);
    }
  }
  if (Number.isNaN(d.getTime())) throw new ShapeError('The date is not valid.');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export class ShapeError extends Error {
  constructor(message, problems = []) { super(message); this.name = 'ShapeError'; this.problems = problems; }
}

/** "Parent › Feature" (any depth) for a feature in the map; the bare name when it has no parent or the map does not know it. */
export function featurePath(g, project, feature) {
  const feats = g?.projects?.[project]?.features || {};
  const chain = [feature];
  const seen = new Set(chain);
  let cur = feats[feature];
  while (cur && cur.parent && feats[cur.parent] && !seen.has(cur.parent)) {
    chain.unshift(cur.parent);
    seen.add(cur.parent);
    cur = feats[cur.parent];
  }
  return chain.join(' › ');
}

/** The stored text. `path` is the feature path from the map; it falls back to the bare feature name. */
export function composeMemory({ project, feature, path: featPath, what, why, when }, now = new Date()) {
  const w = stripEnd(what);
  const y = stripEnd(why);
  return `${project} · ${featPath || feature}: ${w}.${y ? ` Why: ${y}.` : ''} (${monthYear(when, now)})`;
}

/**
 * Validate + resolve a remember() call against the project map.
 * Returns { project, feature, path, newFeature, text, glossary } — glossary is the (possibly extended) map; the caller saves it when newFeature.
 * A feature the map does not know needs `parent` (an existing feature of that project, or null for a top-level one) and a one-line `what_is`,
 * so the map grows with its place and meaning. Throws ShapeError with a message telling una what to fix.
 */
export function shapeMemory(input, glossary, now = new Date()) {
  const g = glossary && glossary.projects ? glossary : { projects: {} };
  const known = Object.keys(g.projects);
  const project = resolveProject(g, input.project);
  if (!project) throw new ShapeError(`Unknown project "${clean(input.project)}". Use one of: ${known.join(', ') || '(the project map is empty)'}. Aliases are fine; a brand-new project needs the person's word first.`);
  const what = clean(input.what);
  const why = clean(input.why);
  if (what.length < 8) throw new ShapeError('"what" needs one plain sentence saying what was decided or what happened.');
  if (what.length > MAX_WHAT) throw new ShapeError(`"what" is too long (${what.length} characters, max ${MAX_WHAT}). One short sentence.`);
  if (why.length > MAX_WHY) throw new ShapeError(`"why" is too long (${why.length} characters, max ${MAX_WHY}). One short sentence.`);
  const featIn = clean(input.feature);
  const featList = () => Object.keys(g.projects[project].features || {}).join(', ') || 'none yet';
  if (!featIn) throw new ShapeError(`"feature" is required: the product feature this belongs to. Known for ${project}: ${featList()}.`);
  const whatIs = clean(input.what_is);
  const problems = [];
  for (const [field, val] of [['what', what], ['why', why], ['feature', featIn], ['what_is', whatIs]]) {
    const c = checkPlain(val);
    if (!c.ok) problems.push(...c.problems.map((p) => `${field} contains ${p}`));
  }
  if (problems.length) throw new ShapeError(`Not stored. ${problems.join('; ')}. ${PLAIN_HELP}`, problems);

  let feature = resolveFeature(g, project, featIn);
  let newFeature = false;
  let out = g;
  if (!feature) {
    if (featIn.length > MAX_NAME || /[\/\\#›]/.test(featIn)) throw new ShapeError(`"${featIn}" is not a usable feature name. Use a short product name (under ${MAX_NAME} characters, no slashes).`);
    if (input.parent === undefined) throw new ShapeError(`"${featIn}" is not in the project map for ${project}. Say where it belongs: pass "parent" (one of: ${featList()}; or null for a top-level feature) and "what_is" (one plain line on what it is for a user), so the map grows with its place. Known for ${project}: ${featList()}.`);
    if (whatIs.length < 8) throw new ShapeError(`"${featIn}" is new to the project map: "what_is" needs one plain line saying what it is for a user.`);
    if (whatIs.length > MAX_WHAT_IS) throw new ShapeError(`"what_is" is too long (${whatIs.length} characters, max ${MAX_WHAT_IS}). One plain line.`);
    const parentIn = clean(input.parent);
    let parent = null;
    if (input.parent !== null && parentIn) {
      parent = resolveFeature(g, project, parentIn);
      if (!parent) throw new ShapeError(`The parent "${parentIn}" is not in the project map for ${project}. Add the parent first (or pass null). Known: ${featList()}.`);
    }
    feature = featIn;
    newFeature = true;
    out = JSON.parse(JSON.stringify(g));
    out.projects[project].features = { ...(out.projects[project].features || {}), [feature]: { description: whatIs, aliases: [], parent, status: 'active' } };
  }
  const featPath = featurePath(out, project, feature);
  const text = composeMemory({ project, feature, path: featPath, what, why, when: input.when }, now);
  return { project, feature, path: featPath, newFeature, text, glossary: out };
}

/** ask_mind prefix: resolves names when it can, otherwise uses what was given; never fails. */
export function queryWithScope(query, { project, feature } = {}, glossary = null) {
  const q = clean(query);
  const p0 = clean(project);
  if (!p0) return q;
  let p = p0;
  let f = clean(feature);
  if (glossary) {
    p = resolveProject(glossary, p0) || p0;
    if (f) {
      const rf = resolveFeature(glossary, p, f);
      f = rf ? featurePath(glossary, p, rf) : f;
    }
  }
  return `${p}${f ? ` · ${f}` : ''}: ${q}`;
}
