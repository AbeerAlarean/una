// How a fresh conversation opens: restore from TrueMemory, blank-slate First Contact, or as usual.
import fs from 'node:fs';
import path from 'node:path';

/** 'restore' only on a fresh machine (empty hub) whose TrueMemory already knows the person; never on a machine with a hub. */
export function decideOpening({ hubEmpty, tmConnected, mindHasContent } = {}) {
  if (!hubEmpty) return 'normal';
  return tmConnected && mindHasContent ? 'restore' : 'first-contact';
}

const MIN_CONTENT = 120;
/** The local hub is a fresh install: the agreement still carries the First Contact marker (or is missing), or there is no workload and no agreement content at all. */
export function hubIsEmpty(hub) {
  const read = (rel) => { try { return fs.readFileSync(path.join(hub, rel), 'utf8'); } catch { return ''; } };
  if (read('mind/agreement.md').includes('first-contact: pending')) return true;
  return read('mind/workload.md').trim().length < MIN_CONTENT && read('mind/agreement.md').trim().length < MIN_CONTENT;
}

export const RESTORE_NOTE = `<restore>This is a fresh machine: the local hub is empty, but this person's TrueMemory already knows them. Do NOT run the blank-slate First Contact. Before you speak, call ask_mind for: who the person is, how they work, the knowledge doc current-work.md, and the knowledge doc standing-rules.md. Rebuild from what comes back: mind/workload.md, mind/agreement.md, mind/standing-rules.md and mind/main-tasks.json (focus first, pending after, same shape as always); the rebuilt agreement must not carry the first-contact marker line. Then greet them: "We've met — here's what you're working on and where we left off", list the focus tasks and the pending ones briefly, and ask only for the repos not yet cloned on this machine (one line). Never mention restoring, sessions or files.</restore>`;
