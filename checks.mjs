// Check-before-done: pure helpers. A task is "checked" only when Sahar herself wrote
// mind/checks/<slug>.md after the last worker finished on it.

/** "[Smart chat] x" / "Smart chat" → "smart-chat" */
export function slugOf(task) {
  return String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** A worker description "[Task] …" → the task name, or null. */
export function taskOfWorker(description) {
  const m = String(description || '').match(/^\s*\[([^\]]{2,60})\]/);
  return m ? m[1].trim() : null;
}

// Stages where the result is being treated as done-or-nearly; these need her own check.
export const CHECKED_STAGES = new Set(['ready', 'test', 'pr', 'checking', 'safe', 'merged']);

/** state: { [slug]: lastWorkerDoneAt(ms) }; checkMtime: ms of her check file or null. */
export function isChecked(state, slug, checkMtime) {
  const done = state?.[slug];
  if (!done) return true; // no worker has finished on it — nothing to check yet
  return typeof checkMtime === 'number' && checkMtime > done;
}

/** Tasks (raw main-tasks.json entries) that sit at a checked stage but have not been checked. */
export function uncheckedTasks(tasks, state, mtimeOf) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => {
    const slug = slugOf(t?.name);
    return slug && CHECKED_STAGES.has(String(t?.stage)) && !isChecked(state, slug, mtimeOf(slug));
  });
}

export const VERIFY_LINE = 'Not checked yet — Sahar is checking the result';

/** What the window gets: unchecked tasks shown as "verify"; her file is never rewritten. */
export function overlayVerify(item, unchecked) {
  return unchecked ? { ...item, stage: 'verify', now: VERIFY_LINE } : item;
}

/** The short note prefixed to her next turn, or ''. */
export function uncheckedNote(unchecked) {
  if (!unchecked.length) return '';
  const names = unchecked.map((t) => t.title || t.name).join(', ');
  return `<unchecked>You have not checked these yourself yet — check before reporting them as done: ${names}. Judge the real result against the Done-means list, then write mind/checks/<task-slug>.md.</unchecked>\n`;
}

// ── matching a worker's [tag] to an existing card ─────────────────────────────
const CARD_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'on', 'with', 'pr', 'task', 'fix']);
/** "The Smart-chat PR!" → ['smart','chat']: lowercase, punctuation stripped, filler words and plural 's' ignored. */
export function cardWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !CARD_STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}
function containsRun(long, short) {
  for (let i = 0; i + short.length <= long.length; i++) if (short.every((w, j) => long[i + j] === w)) return true;
  return false;
}
/** True when two card names are the same task: equal, or one is a prefix/contained run of the other covering ≥70% of its words, or ≥70% of words shared. */
export function sameCard(a, b) {
  const A = cardWords(a);
  const B = cardWords(b);
  if (!A.length || !B.length) return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && !!String(a || '').trim();
  if (A.join(' ') === B.join(' ')) return true;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  if (short.length / long.length >= 0.7 && containsRun(long, short)) return true;
  const common = short.filter((w) => long.includes(w)).length;
  return common / long.length >= 0.7;
}
/** The existing card (raw main-tasks.json entry) a worker's tag belongs to, or null. Matches the card's name or its title. */
export function matchCard(tasks, tag) {
  if (!Array.isArray(tasks)) return null;
  return tasks.find((t) => sameCard(t?.name, tag)) || tasks.find((t) => t?.title && sameCard(t.title, tag)) || null;
}

// ── finish-first nudge: a new task while many are open ──
const DONE_STAGE = new Set(['merged', 'done']);
const NEAR_DONE = ['safe', 'ready', 'test', 'checking', 'pr', 'verify', 'fix', 'build', 'plan'];
const cardName = (t) => String(t?.name || t?.title || '').trim();
export const openTasks = (tasks) => (Array.isArray(tasks) ? tasks : []).filter((t) => cardName(t) && !DONE_STAGE.has(String(t.stage || '').trim()));
/**
 * known: names already seen (a Set, mutated). → { note } when a task name is NEW and the open count is >= limit, else {}.
 * The note names the 2 open tasks nearest to done (other than the new one). Each name triggers at most once.
 */
export function loadNudge(tasks, known, limit = 8) {
  const open = openTasks(tasks);
  const fresh = (Array.isArray(tasks) ? tasks : []).map(cardName).filter((n) => n && !known.has(n));
  fresh.forEach((n) => known.add(n));
  const newOpen = open.filter((t) => fresh.includes(cardName(t)));
  if (!newOpen.length || open.length < limit) return {};
  const rank = (t) => { const i = NEAR_DONE.indexOf(String(t.stage || 'plan').trim()); return i < 0 ? NEAR_DONE.length : i; };
  const [a, b] = open.filter((t) => !newOpen.includes(t)).map((t, i) => ({ t, i })).sort((x, y) => rank(x.t) - rank(y.t) || x.i - y.i).map((x) => cardName(x.t));
  const pick = [a, b].filter(Boolean);
  const ask = pick.length === 2 ? `close ${pick[0]} or ${pick[1]} first` : pick.length ? `close ${pick[0]} first` : 'finish something first';
  return { note: `<load>You now have ${open.length} open. Before planning the new one (${cardName(newOpen[0])}), say in ONE line: "You have ${open.length} open — want to ${ask}?" Then carry on with what the person answers.</load>` };
}
