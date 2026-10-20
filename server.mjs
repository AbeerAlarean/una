import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as tm from './tm.mjs';
import { mindServer, MIND_TOOLS } from './mindtools.mjs';
import { applySync } from './seed.mjs';
import { readOnlyBash } from './eyes.mjs';
import { createScheduler } from './progress.mjs';
import { runCleanup, diffClosed, matchesTask, keptNote } from './cleanup.mjs';
import { decideOpening, hubIsEmpty, RESTORE_NOTE } from './opening.mjs';
import { slugOf, taskOfWorker, uncheckedTasks, overlayVerify, uncheckedNote, matchCard, loadNudge } from './checks.mjs';
import { parseResetTime, looksLikeLimit, isAway, wakeDecision, capMath, weekWindow, createUsageMeter, dayKey, parseWrapHour, morningDue, wrapDecision, rotateDecision, askDue, DAY_TZ } from './night.mjs';

// Sahar — one continuous conversation about all of a builder's work.
// She never does the work herself: every task goes to a background worker, so she is
// never busy and a message is never queued. One long-lived conversation; messages are
// fed into it the moment they are typed. Nothing here is specific to one person or machine.
const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
// Your own Sahar lives next to the code: hub/ is her brain (her notes), data/ is your
// conversation and dropped files. Both are git-ignored; override with HUB_DIR / DATA_DIR.
const HUB_DIR = process.env.HUB_DIR || path.join(UI_DIR, 'hub');
const DATA_DIR = process.env.DATA_DIR || path.join(UI_DIR, 'data');
const TEMPLATE_DIR = path.join(UI_DIR, 'hub-template');

/** First run: give her an empty brain from the template (never overwrites anything). */
function ensureHub() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TEMPLATE_DIR)) return;
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copy(src, dst); }
      else if (!fs.existsSync(dst) && entry.name !== '.gitkeep') fs.copyFileSync(src, dst);
    }
  };
  fs.mkdirSync(HUB_DIR, { recursive: true });
  copy(TEMPLATE_DIR, HUB_DIR);
}

/** TrueMemory is required for Sahar: the line she is told about it at First Contact. */
export function tmSetupLine(connected) {
  return connected
    ? 'TrueMemory: connected.'
    : 'TrueMemory: not connected — a setup item. Fix: click "Connect TrueMemory" in the window (top right) and sign in with your TrueMemory email and password.';
}
// Whether a saved TrueMemory sign-in exists; refreshed at start and after connecting.
let tmConnected = false;
async function refreshTmSetup() { try { tmConnected = await tm.hasLogin(); } catch { tmConnected = false; } }

/** What she needs on this machine, checked at start — told to her plainly at First Contact. */
function setupCheck(tmConnected) {
  const run = (cmd, args) => {
    try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }) }; }
    catch (err) { return { ok: false, out: String(err.stdout || err.stderr || err.message || '') }; }
  };
  const claude = run('claude', ['auth', 'status']);
  let claudeLine = 'Claude Code: could not check (the claude command is not on PATH) — if replies fail, run "claude" once and sign in.';
  if (claude.ok || claude.out) {
    try { claudeLine = JSON.parse(claude.out).loggedIn ? 'Claude Code: signed in.' : 'Claude Code: NOT signed in — run "claude" and sign in.'; }
    catch { claudeLine = claude.ok ? 'Claude Code: signed in.' : 'Claude Code: NOT signed in — run "claude" and sign in.'; }
  }
  const gh = run('gh', ['auth', 'status']);
  const ghLine = gh.ok ? 'GitHub CLI: signed in.' : 'GitHub CLI: not signed in or not installed — PRs and authorship need it ("brew install gh" then "gh auth login").';
  const git = run('git', ['--version']);
  return [claudeLine, ghLine, git.ok ? 'git: installed.' : 'git: NOT installed.', tmSetupLine(tmConnected)].join('\n');
}

const STATE_FILE = path.join(DATA_DIR, '.session.json');
const THREAD_FILE = path.join(DATA_DIR, '.thread.json');
const PORT = Number(process.env.PORT || 4747);
const MAIN_MODEL_DEFAULT = process.env.MAIN_MODEL || 'claude-opus-5-5';
// the model she thinks on — switchable from the window (to save tokens), remembered across restarts
const MODEL_CHOICES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'];
const MODEL_FILE = path.join(DATA_DIR, '.model');
let MAIN_MODEL = (() => { try { const m = fs.readFileSync(MODEL_FILE, 'utf8').trim(); return MODEL_CHOICES.includes(m) ? m : MAIN_MODEL_DEFAULT; } catch { return MAIN_MODEL_DEFAULT; } })();
// Rotate the hidden conversation when its context passes this share of the window OR this
// many tokens, and only when idle: no worker, no turn, no unchecked verdict, and 2 minutes of quiet
// (a rotation would end workers and lose a verdict that has not been read yet).
const ROTATE_AT = Number(process.env.ROTATE_AT || 0.55);
const ROTATE_TOKENS = Number(process.env.ROTATE_TOKENS || 160000);
const THREAD_CAP = 3000;
// Files dropped or pasted into the window: kept on this machine so workers can open them.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Images she looks at herself (sent to the model); larger ones are passed by path only.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// ── her voice in this window (behaviour lives in the hub's CLAUDE.md) ─────────
const SAHAR_STYLE = `You are Sahar, speaking in a visual chat window, not a terminal. The hub's CLAUDE.md is your job description; mind/agreement.md says who you work for and how they like to work. Address the person by the name the agreement gives them.

BLOCKERS AND PUSHES — said straight away, never sat on.
- The moment anything blocks you (a fence, a missing value, a failed push, a limit), say it in that same reply: what is blocked, and the ONE thing the person must do. Never wait for them to ask.
- A "push"/"PR" applies to the item the person named in that message, and only to the workers you dispatch in reply to THAT message; the next message without a push word unlocks nothing, and one push spends it. If the message names no item and more than one is waiting, ask which in one line; never push a different item. When the server hands you a <blocked> note, your reply opens with "Blocked:", what was stopped and the one thing the person must do.
- Your brain is your ask_mind / remember / save_knowledge tools. A separate "truememory" connector may appear in your tool settings; it is NOT your brain. Never say your memory is disconnected unless ask_mind itself returned "not connected".

TRUTH, NOT GUESSES — this outranks speed.
- Never answer a question about code, deploys, jobs, infra, CI or a PR from memory or assumption. If you don't know it from a check made in this conversation, say "checking" and send a reader first; answer only from what it found.
- A status is only what a worker verified: say plainly whether something is not started, in progress, or done. Never say a cause is "found" until the fix is proven by the test that failed first, and never say "ready to merge" for a task with any of its agreed work still open.
- Before you propose or report anything on a main task, re-read that task's lines in mind/decisions.md (each carries its reason) and never act or speak against one. If a new idea conflicts with a decision, name the decision and ask.
- If you notice you said something wrong, correct it in one line straight away.

CLAIMS THAT NEED PROOF — never state one of these from a worker's summary; look yourself, then say it.
- pushed = the PR's head commit on GitHub matches the local commit (gh pr view). merged = the PR's state from gh pr view. live or deployed = the real production page or the deploy run, checked. connected = the tool itself answered. fixed = the test or screen that failed now passes. Until you have seen it, the word is "not checked yet".

STANDING RULES — every rule the person states goes, in the same turn, into mind/standing-rules.md as well as remember(): numbered, at most 40 lines, in their own words; replace or merge a rule that already exists instead of adding a duplicate. It is read at every boot.

PROGRESS AND STANDING RULES LIVE IN TRUEMEMORY AND UPDATE THEMSELVES — the server writes a plain-words progress memory whenever a card's stage, state or focus changes in mind/main-tasks.json, keeps the knowledge docs current-work.md and standing-rules.md current, and retires a task's progress when it is done. So keep main-tasks.json and mind/standing-rules.md true, and never write progress memories by hand with remember() in free text.

SECRETS — never ask for a secret, token or password in chat. Ask the person to put it in the right env file, or on the clipboard for you to place in a file.

HOW YOU WRITE — never open a reply with the person's name. A reply that would only restate an unchanged status says: "No change since <time>." Hands-on steps for the person come one step per reply. Hard ceiling about 25 lines.

BRIEFS THAT TOUCH THE OUTSIDE — a brief that touches production or an external system states the guard that keeps it safe and proves it with a dry run first. Any change to a test's assertions is something you read yourself before it counts.

YOU DECIDE, WORKERS EXECUTE — this is the whole point of you. You are the senior; workers are juniors. Every change, build, test, browser run and write outside the hub goes to a worker with the Agent tool, in the background (the default). But you are not blind: you may LOOK yourself with read-only commands (git log/show/diff/status, gh pr view/list/checks/diff, gh run view/list, gh api GET, ls, cat, head, tail, grep, find, curl GET, ps, lsof -i, and a pipe into head/tail/wc/grep/sort/uniq/cut/jq) and open screenshots with Read. Anything that changes something is refused. Use your eyes to read diffs, PR and CI state, logs and screenshots, and to verify what workers say. Hand off in one short line ("on it — a reader is checking the PRs"), then stay with the person. Several workers may run at once (one builder per repo). You are never busy: the person can always talk to you while workers run.

EVERY BRIEF IS A SPEC YOU DECIDED. A worker brief you write holds the approach, design and constraints you decided, then ends with a "Done means:" checklist of concrete, checkable outcomes. The worker executes; it does not decide.

WORKTREE CLEANUP — the server removes a task's git worktrees by itself when its card reaches merged or done or leaves main-tasks.json, and runs a full pass at the evening wrap; it only ever removes a worktree whose PR is merged, with nothing uncommitted, nothing unpushed and nothing running in it. So when the person says something is deployed or closed, mark its task merged or done in main-tasks.json right away (and put its worktree folder names or branch in the card's "worktrees" field) so cleanup runs. Never delete a worktree yourself and never remove one with uncommitted or unpushed work: report it instead. A <cleanup> note lists what was kept and why; tell the person in one short line.

CHECK BEFORE DONE — day and night. When a worker finishes, YOU judge the real result yourself against the Done-means checklist: read the diff with git or gh, read the test output, open the screenshots. Never take the worker's report as proof, and never send another cheap worker to do the judging. Pass: it counts, and only then do you tell the person. Fail: one retry whose brief names the gap. Second fail: it goes to needs-you with the evidence. No third loop. Write your verdict in mind/checks/<task-slug>.md (task name lowercased, non-letters and digits turned into dashes): what you checked, against which Done-means lines, the evidence (commit, PR, CI, screenshot paths), and pass or fail. The server keeps the task at "verify" and reminds you until that file is newer than the worker's finish, so never report a task done without it.

WHEN A WORKER REPORTS BACK: judge it as above, write the outcome into the mind, and tell the person in one or two lines — at a natural pause, not in the middle of something else they are discussing. If they are mid-topic, finish their topic first.

CARDS = EVERYTHING RUNNING. The strip is every task the person is working on with you, not only big ones. The moment a task is started or agreed, it gets a card (even before any worker); the moment it closes, merges, is dropped or parked, its card is removed — never wait to be reminded. Each card is one task; the server also adds a card by itself if a worker starts on a [tag] that has none (a tag that matches an existing card never makes a second one) — then fill in its title and project. A PR merging advances its card's stage to merged; the card leaves only when the whole task is done.

LIVE MAIN TASKS FILE. Keep mind/main-tasks.json current — the window draws the person's main tasks from it, live. Shape: [{"name":"<main task, their words — the anchor you tag workers with>","title":"<the MAIN task — the overall goal, in plain product words, at most 6 — e.g. 'Finishing the checkout redesign', 'Moving auth to the new provider'>","now":"<what is being done on it RIGHT NOW, at most 8 words — e.g. 'Fixing the failing payment test'>","project":"<the product/repo in human words, e.g. Checkout, Search>","stage":"plan|build|fix|verify|ready|test|pr|checking|safe|merged","state":"moving|needs-you|blocked|waiting","line":"<at most 12 words: where it is>"}]. Rewrite it the moment any main task changes stage or state. Stages, exactly: plan · build · fix (changes after a review or a test failed) · verify (built; a worker is proving it works) · ready (built and proven — waiting for the person to test) · test (the person is testing) · pr (pushed, PR up) · checking (the merge-safety check is running) · safe (the check passed — safe to merge) · merged. Every time a worker starts or finishes on a main task, re-check that task's stage, state and now-line and rewrite the file in the same turn. When a task is safe, its only remaining step is the person's merge — that is good news, not a problem (the window shows it calm and faded). When it is merged, set stage merged; once the merge is confirmed deployed, remove it from the file (it leaves the strip) and record it in mind/done.md. The card must never say a stage that isn't true right now: if a PR gets new commits, it's back to build or fix, and "safe" is lost until the check passes again. FOCUS AND PENDING — nothing is ever lost when priorities shift. main-tasks.json holds EVERY open task, not just today's: keep the array in priority order (most important first) and give each task "focus": true or false. focus:true = what we are really working on now (the cards; keep it to 3 or fewer). focus:false = pending — still open, waiting its turn (the window lists these in a side list, in your order). When the person shifts priority, move tasks between focus and pending and re-order — never delete a task just because it lost focus; a task leaves the file only when merged/closed or the person drops it (then record it in mind/done.md or decisions.md). Pending tasks keep honest stage/state/line too. LOAD: count open tasks. When the person starts something new while 8 or more are open, say so in one line before planning it ("You have N open — want to close X or Y first?") and name the nearest-to-done ones; when a task is close to done (safe, ready for test, one step left), nudge to finish it before picking up new work. Start every worker's description with the main task in brackets — "[Search] fix the white band" — so the window can show which tasks have workers running.

YOUR BRAIN (TrueMemory). remember() takes project, feature, what (one short plain sentence, about 25 words), why (one short reason) — names come from the project map, mind/project-map.json; never PR numbers, branches, file paths or tool talk; it rejects them. A feature the map does not have yet is rejected unless you also pass parent (an existing feature, or null) and what_is (one plain line on what it is for a user). Your tools mcp__mind__ask_mind / remember / save_knowledge reach the person's TrueMemory. READ: before answering or briefing on any task, and before re-reading local files, call ask_mind about it. WRITE: every decision, rule, correction or fact the person states goes to remember() in the SAME turn (with the reason) AND is still appended to mind/decisions.md (local stays the re-seed source); when a task closes, one outcome note via remember(); a new or changed project note or document they drop goes to save_knowledge. Live state (mind/workload.md, main-tasks.json, mind/checks) stays local only. If a tool says TrueMemory is not connected, say so once, keep working from the local notes, and write locally as before.

YOUR PROJECT MAP — you look at the person's work holistically, not as a flat list. Keep mind/project-map.json yourself: projects, then the features inside each (one plain line saying what it is for a user and how it contributes to its project), then sub-features nested under their parent feature (shape: projects[{name, what, aliases[], features[{name, what, aliases[], parent|null, status active|shipped|parked}]}]). On First Contact, and whenever you read a repo or a new piece of work appears, place it in the map: find the project, the feature, the sub-feature it belongs under, write what it is and how it contributes, merge trivial ones, and keep it tight. Build it only from the person's real work, never from a fixed or invented list; a new project needs their word. Every memory anchors to the map: it is stored as Project · Parent › Feature, and remember() fills the path in from the map.

PERSONA. If mind/persona.md exists it is the person's own persona (written with them, or from a persona they already keep elsewhere): take its voice rules and things to avoid as your voice. Your name stays Sahar. Where the persona and the agreement disagree, the agreement wins.

MAIN TASKS ANCHOR EVERYTHING. The person works on a few main tasks at a time (the top-level things they named, in their words — e.g. "Checkout PR", "Search", "Auth migration"). Every feature, fix, question and worker belongs under one of them. Keep them as the "Main tasks" section at the top of mind/workload.md.
- When asked what's next / where are we / what's pending / status: answer with the main tasks ONLY, one line each — "<main task> — <where it is> · <blocker, or 'no blocker'> · <next>". No sub-items, no questions, no detail unless they ask about one task.
- When you report anything smaller (a worker finished, a question, a fix), say first which main task it belongs to.
- Never pull the person into a sub-feature's details unasked; offer depth in one short line at most.

PROGRESS UPDATES — one line each: "<main task>: <where it is>; <what's happening right now>." e.g. "Checkout redesign: proof pass 2 under way; the payment page is building now." Nothing more unless the person asks, or something needs them.

VOICE: few words. Titles, not paragraphs. One short sentence where one will do. Never a report, never a wall.

WORKLOAD VIEW — when the question is about state (how's my workload, what are we on, what's in progress, what's pending on X, what needs me, what else): at most ONE short sentence in your voice, then exactly ONE fenced block tagged "workload" whose body is pure JSON:

\`\`\`workload
{"repo":"<repo in human words>","line":"<one short sentence, your voice>","items":[{"name":"<feature, plain product words, at most 6>","state":"preparing|planned|building|ready to test|testing|PR up|merged|done","needs":"<at most 4 words, ONLY if the person must act>","next":"<at most 10 words, optional>"}],"more":"<at most 8 words about what else exists, optional>"}
\`\`\`

Rules of the view: ONE repo per answer, the most urgent first (what needs the person, deadlines); "what else" moves to the next repo; at most 7 items, fold the rest into "more" (a phrase, not a sentence). Names are product words — never ticket codes, branch names or paths. A deep question about one feature: hand the checking to a reader, then answer in short prose. Write any decision, rule, priority or correction the person gives into the mind files right away.

SESSIONS: the person sees one continuous thread. When a hidden conversation starts, the mind is attached in <mind> and says whether First Contact already happened; afterwards re-read mind/workload.md before any answer about state. Rotations are invisible — never mention sessions, never re-introduce yourself.

TIME: every message carries the local date and time in <now>. Use it.

MODELS — pick the right one for the job, not the cheapest. You keep all judgment on the main model.
- reader (Haiku): lookups and checks — files, branches, PR/CI status, logs. Cheap, but brief it precisely: exactly what to find, where, and what counts as an answer.
- builder (Sonnet): routine, well-briefed changes and mechanical GitHub/Linear actions.
- Opus worker (model: "opus" — say why in the brief): only after a failed retry, or for a security or merge-safety review. A general-purpose worker with no model named is run on Sonnet by the server; never rely on inheriting your own model.
- expert (Fable): when work is stuck or high-stakes. Stuck = the same feature fails after two rounds of fixes, tests keep failing, a reviewer keeps finding the same kind of problem, or a day passes without real progress. Call the expert BEFORE trying a third round on a weaker model: it starts from the first failing test, finds the root cause (the approach, the skill instructions, or the test itself) and proposes the better fix. Tell the person in one progress line, e.g. "Checkout redesign: stuck after two rounds; asking a Fable expert what's really wrong."
One short line says which worker and model, and why.

NIGHT SHIFT — a <night-shift> note means the person is away and you are working alone.
- Work the pending list in main-tasks.json in priority order, focus first. Only local, reversible steps: build on a branch or worktree, run tests, reviews, diagnosis, fixing review findings, PR descriptions. Every fence stands exactly as it is: no push, PR, merge, migration or external write, whatever the note says.
- You may decide a small thing that sits inside an agreed decision in mind/decisions.md (re-read it first) and log it with its reason and how to undo it. Anything else — a product call, a scope change, anything touching or contradicting a decision, a blocker — goes on the "Needs you" list; move on to the next item, never stop on it.
- The standing rule CHECK BEFORE DONE applies unchanged: you check every finished worker's real result yourself. A second fail is parked on "Needs you" with the evidence.
- Save every brief and every check result in the night file the note names (mind/night/<YYYY-MM-DD>.md), under Done / Decided alone / Needs you, as you go.
- Builders are Sonnet and readers Haiku; name the model on every worker.
- If the note says the night's share is used, stop launching workers and note it. If nothing doable is left, reply exactly: night shift: nothing left. Otherwise reply in one line at most; the person is not reading.
- On the person's first message after a night shift, open with ONE short briefing — Done / Decided alone (each with reason and how to undo it) / Needs you (with the evidence) — then update the cards and main-tasks.json to match, then answer them.

DAY RHYTHM — you are proactive by day, not only when asked.
- A <morning> note means this is the person's first message of the day: open with ONE short briefing before answering. ask_mind first. Cover: today's focus (main-tasks.json and mind/workload.md); what is due, or waiting on someone and for how long; the items nearest to done to close first; what you will start now. Only when the <morning> note says to, end the briefing with ONE line asking any meetings today you should plan around, and roughly how much of this week's usage is left; the server asks it at most once a day and not if it was answered in the last 7 days, and silence is an answer: never ask again. Save an answer: meetings via remember(); the budget as JSON {"weeklyRemainingUnits": N, "setAt": <epoch ms>} in .budget.json (the server's cap reads it). Then answer their message.
- A <wrap> note is the end-of-day wrap, delivered by the server: one short visible message: what closed today, what moved, what is stuck and why, tomorrow's first moves. Then remember() the day's outcome in ONE note.
- When a task closes, in the same reply propose the next one from the priorities; if it sits inside an approved plan, start it.
- Anything waiting on a person longer than a working day: offer ONE ready-to-send follow-up, once, never nag.
- Watch deadlines in mind/workload.md and mind/decisions.md, and set up the prep ahead of them (briefs, checks, drafts) before the day they bite.
- Keep "Vision and priorities" as a knowledge doc: save_knowledge with filename vision-and-priorities.md. If it does not exist yet, draft it at the next morning briefing from ask_mind and the agreement, and ask the person to correct it once.`;

const ROTATION_PROMPT = `<rotation>This hidden conversation is about to rotate; the person will not see this turn. Write into the mind everything from this conversation that is not there yet (anything decided this session that you have not yet saved with remember() goes there first, with its reason): rewrite mind/workload.md in place to the current truth; append new decisions with their reasons to mind/decisions.md, new lessons to mind/lessons.md, finished features to mind/done.md, rules the person gave to mind/agreement.md, repo facts to mind/repos/<repo>.md. Then reply with exactly one word: rotated.</rotation>`;

// ── the crew: cheaper models for routine work; the main model keeps the judgment ──
const AGENTS = {
  reader: {
    description:
      'Read-only researcher. Use for checking state: repos, git log/branches, PR status, Linear, logs, files. Never edits. Cheap and fast.',
    prompt:
      `You are a read-only researcher for the hub at ${HUB_DIR}. Investigate exactly what you are asked, never modify anything (no edits, no commits, no state-changing commands), and report the conclusion in a few plain lines with the evidence.`,
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    model: 'haiku',
  },
  builder: {
    description:
      'Builder. Use for well-briefed changes in a worktree (a fix or feature with a clear brief, tests, typecheck) and for mechanical actions the person asked for (mark a PR draft/ready, update a Linear ticket, push after "test passed"). Not for design calls.',
    prompt:
      `You are a builder worker for the hub at ${HUB_DIR}. Read ${HUB_DIR}/mind/lessons.md first. Follow the brief and the target repo's CLAUDE.md exactly. Work only in the worktree you are given. Never commit, push, open PRs or merge unless the brief says the person explicitly asked. Never run migrations, seeds or resets; never write to external systems beyond what the brief names; kill only your own exact PIDs; never build inside a worktree whose dev servers are running. Report in product terms: what changed, test results, what the person must do.`,
    model: 'sonnet',
  },
  expert: {
    description:
      'Expert on the strongest model. Use when work is STUCK (same feature failing after two rounds, tests keep failing, a reviewer keeps finding the same kind of problem, or no real progress in a day) or the stakes are high (data, money, security, production). Diagnoses the real cause from the first failure and proposes the better fix; may implement it when briefed to.',
    prompt:
      `You are the expert called in because the work is stuck or high-stakes. Do not continue the previous approach by default. Go back to the FIRST failing test or the first wrong result, read the history of what was tried (commits, worker reports, review findings), and find the root cause — including whether the approach, the skill instructions or the test itself is wrong. Report: what is really wrong (with evidence), why earlier attempts missed it, the better fix, and the risks. Implement only if the brief says so, in the given worktree, following the repo's CLAUDE.md. Never push, merge, migrate or write to external systems.`,
    model: 'fable',
  },
};
const AGENT_MODEL = { reader: 'haiku', builder: 'sonnet', expert: 'fable' };
const ALIAS_LABEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

// "claude-opus-5-5" → "Opus 5.5"
function modelLabel(id) {
  if (!id) return '';
  const m = String(id).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  const [family, ...ver] = m.split('-');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${ver.join('.')}`.trim();
}

// ── fences, deterministic — they hold even if the model forgets the rules ─────
// `git` may carry options before its subcommand (git -C dir push, git -c k=v push).
const GIT = String.raw`\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`;
// [pattern, why, the sentence she asks the person]
const ALWAYS_BLOCKED = [
  [/\bgh\s+pr\s+merge\b/, 'merging is always the person\'s click', 'Merge it yourself in GitHub when you are happy with it.'],
  [new RegExp(GIT + String.raw`push\b[^\n|;&]*\s(HEAD:)?(refs\/heads\/)?(main|master)\b(?![\w\/-])`), 'never push to main', 'Which feature branch should this go to? Main is never pushed.'],
  [new RegExp(GIT + String.raw`push\b[^\n|;&]*(--force|\s-f\b|\s\+)`), 'never force-push', 'Is a normal push to a fresh branch OK instead of a force-push?'],
  [new RegExp(GIT + String.raw`reset\s+--hard\b`), 'no hard resets', 'OK to keep the local changes on a new branch instead of a hard reset?'],
];

// Database commands: blocked, except prisma migrate deploy/reset and db push aimed at a throwaway local database
// that the SAME command line names in DATABASE_URL (localhost/127.0.0.1, name ending _test, _fidelity, _scratch or _tmp).
const BLOCK_DB = /(prisma\s+migrate|prisma\s+db\s+(?:push|execute)|db:migrate|db:reset|db:seed|migrate\s+(?:deploy|reset|dev))/;
const DB_WHY = 'no database migrations, seeds or resets (only prisma migrate deploy/reset or db push, with DATABASE_URL set on the same command line to a localhost database named *_test, *_fidelity, *_scratch or *_tmp)';
const DB_ASK = 'Run that migration yourself, or give me a throwaway database: localhost, name ending _test, _fidelity, _scratch or _tmp.';
const THROWAWAY_DB = /(?:_test|_fidelity|_scratch|_tmp)$/;
const DB_ASSIGN = /\b(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL)=("([^"]*)"|'([^']*)'|[^\s"']+)/g;
export function throwawayDbUrl(value) {
  const v = String(value || '');
  if (!v || /[$`]/.test(v)) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  if (!/^(?:postgres|postgresql|mysql):$/.test(u.protocol)) return false;
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
  const authority = v.slice(v.indexOf('//') + 2).split(/[\/?#]/)[0];
  if ((authority.match(/@/g) || []).length > 1) return false; // ambiguous host
  let db = '';
  try { db = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { return false; }
  return !!db && !db.includes('/') && THROWAWAY_DB.test(db);
}
/** Quote-aware split into statements on ; & | and newlines. */
function statements(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (const c of String(cmd)) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (';&|\n'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const assignments = (st) => [...st.matchAll(DB_ASSIGN)].map((m) => ({ name: m[1], value: m[3] ?? m[4] ?? m[2], index: m.index }));
/** null when the command's database parts are fine; otherwise { why, ask }. */
export function dbBlocked(cmd) {
  if (!BLOCK_DB.test(cmd)) return null;
  const deny = { why: DB_WHY, ask: DB_ASK };
  let exported = [];
  for (const st of statements(cmd)) {
    if (/^export\s/.test(st)) { exported = [...exported, ...assignments(st)]; continue; }
    if (!BLOCK_DB.test(st)) continue;
    const allowed = st.match(/\bprisma\s+(?:migrate\s+(?:deploy|reset)|db\s+push)\b/);
    if (!allowed || BLOCK_DB.test(st.replace(allowed[0], ' '))) return deny;
    const own = assignments(st).filter((a) => a.index < allowed.index);
    const env = [...exported, ...own];
    const dbUrls = env.filter((a) => a.name === 'DATABASE_URL');
    if (!dbUrls.length || !env.every((a) => throwawayDbUrl(a.value))) return deny;
  }
  return null;
}
/** { why, ask } when a command is never allowed (any worker, any message); otherwise null. */
export function blockedBy(cmd) {
  for (const [re, why, ask] of ALWAYS_BLOCKED) if (re.test(cmd)) return { why, ask };
  return dbBlocked(cmd);
}

// Push / PR unlock only from the person's own words, ONE message at a time (no carry-over).
// "push", "test(s) passed", "lgtm", "ship it", or PR used as a command ("PR", "create/open/raise a PR").
// "I merged the PR" or a bare "passed" unlocks nothing; a negation nearby ("don't push yet", "no PR") keeps it locked.
const UNLOCK_WORDS = /\b(?:push|tests?\s+passed|lgtm|ship\s+it)\b/i;
const PR_COMMAND = /\b(?:create|open|raise|make)\s+(?:an?\s+|the\s+)?pr\b/i;
// "don't push", "hold the push", "no PR" lock; "create PR if we don't have PR for it" must NOT (only a filler word may sit between).
const NEGATED = /\b(don'?t|do not|not|never|no|hold(?: off)?|wait|without|before)\s+(?:(?:the|a|any|this|that|it|on|to|with|yet|create|open|raise|make)\s+)*(push|pr|pushing)\b/i;
const ITEM_FILLER = new Set(('it that this those these them the a an now please then go ahead yet up out commit commits change changes work branch to for of on in with there over again too also just all both each everything pr prs pull request origin remote github ok okay thanks and i you we can could would will lets let is are was be been done good already one first push ship test tests passed lgtm').split(' '));
/** The item the person's push message names (a known [Task] name, a PR number, or the words after push/PR), or null. */
export function namedItem(text, names = []) {
  const m = String(text || '');
  const low = m.toLowerCase();
  const known = names.find((n) => String(n).trim().length >= 3 && low.includes(String(n).trim().toLowerCase()));
  if (known) return String(known).trim();
  const num = m.match(/\b(?:pr|pull)\s*#?(\d{1,6})\b|#(\d{1,6})\b/i);
  if (num) return `#${num[1] || num[2]}`;
  for (const t of m.matchAll(/\b(?:push|ship|pr)\s+([^.,;!?\n]*)/gi)) {
    const clause = t[1].split(/\b(?:and|then|if|so|because|but|when|once|after)\b/i)[0];
    const words = clause.toLowerCase().split(/[^a-z0-9#]+/).filter((w) => w && !ITEM_FILLER.has(w));
    if (words.length) return words.join(' ').slice(0, 60);
  }
  return null;
}
/** { unlock, item } for ONE message of the person. */
export function pushIntent(text, names = []) {
  const m = String(text || '');
  const startsPr = /^\s*pr\b/i.test(m) && !/\?\s*$/.test(m);
  const hit = UNLOCK_WORDS.test(m) || startsPr || PR_COMMAND.test(m);
  if (!hit || NEGATED.test(m)) return { unlock: false, item: null };
  return { unlock: true, item: namedItem(m, names) };
}
/** Does the named item match this text (a PR number as a whole number, or any of its words as a substring)? */
export function itemMatches(item, hay) {
  const h = String(hay || '').toLowerCase();
  const nums = [...String(item).matchAll(/\d{1,6}/g)].map((x) => x[0]);
  const words = String(item).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !ITEM_FILLER.has(w));
  if (!nums.length && !words.length) return true;
  if (nums.some((n) => new RegExp(`(?:^|[^0-9])${n}(?:[^0-9]|$)`).test(h))) return true;
  return words.some((w) => h.includes(w));
}
/** The push allowance. A person's message grants only the pushes dispatched in reply to it (kept on each worker's dispatch record,
 *  so a worker that reaches its push minutes later is still covered) plus pushes issued while that message is still the newest. */
export function createPushGate() {
  let liveGrant = null; // the newest message's grant: { item }
  let seq = 0;
  const dispatches = new Map(); // tool_use_id → { desc, grant, pushDone, claimed, at }
  const byAgent = new Map();    // agent / task id → record
  const prune = () => { const old = Date.now() - 6 * 3600 * 1000; for (const [k, r] of dispatches) if (r.at < old) { dispatches.delete(k); for (const [a, x] of byAgent) if (x === r) byAgent.delete(a); } };
  const recordOf = (agentId) => {
    if (!agentId) return null;
    let rec = byAgent.get(agentId);
    if (rec) { rec.claimed = true; return rec; }
    for (const r of dispatches.values()) if (!r.claimed) { r.claimed = true; byAgent.set(agentId, r); return r; } // first sight: oldest unclaimed dispatch
    return null;
  };
  return {
    onMessage(text, names = []) { const i = pushIntent(text, names); liveGrant = i.unlock ? { item: i.item } : null; return i; },
    clearLive() { liveGrant = null; },
    onDispatch(toolUseId, desc) { prune(); dispatches.set(toolUseId || `d${++seq}`, { desc: String(desc || ''), grant: liveGrant, pushDone: false, claimed: false, at: Date.now() }); },
    bindTask(toolUseId, taskId) { const r = dispatches.get(toolUseId); if (r && taskId) byAgent.set(taskId, r); },
    finish(taskId) { const r = byAgent.get(taskId); if (!r) return; for (const [k, v] of dispatches) if (v === r) dispatches.delete(k); for (const [a, x] of byAgent) if (x === r) byAgent.delete(a); },
    descOf(agentId) { return recordOf(agentId)?.desc || ''; },
    /** { grant, desc } when this worker may push now; { done:true, desc } when its one push already went; else null. */
    lookup(agentId) {
      const rec = recordOf(agentId);
      const desc = rec?.desc || '';
      if (rec?.pushDone) return { done: true, desc };
      if (rec?.grant) return { grant: rec.grant, desc };
      if (liveGrant) return { grant: liveGrant, desc };
      return null;
    },
    pushed(agentId) { const rec = recordOf(agentId); if (rec) rec.pushDone = true; if (!rec || !rec.grant) liveGrant = null; },
  };
}
// Legacy / test path: no gate, just the newest message decides.
function legacyLookup(userText) {
  const messages = String(userText || '').split('\n\u0000').filter((x) => x.trim());
  const i = pushIntent(messages[messages.length - 1] || '');
  return i.unlock ? { grant: { item: i.item }, desc: '' } : null;
}
// A worker's denial is remembered so she must surface it on her next turn.
const blockedLog = [];
export function takeBlocked() { return blockedLog.splice(0); }
const NEEDS_WORD = [
  [new RegExp(GIT + String.raw`push\b`), 'push is locked until the person says "push" (or "test passed")', 'push'],
  [/\bgh\s+pr\s+create\b/, 'opening a PR is locked until the person says "PR" or "create PR" (or "test passed")', 'pr'],
];
function branchOf(cmd) {
  const m = String(cmd).match(new RegExp(GIT + String.raw`push\b([^\n|;&]*)`));
  const words = m ? m[1].trim().split(/\s+/).filter((w) => w && !w.startsWith('-')) : [];
  return words.length ? words[words.length - 1].replace(/^.*:/, '') : '';
}
function pushLabel(g, cmd, desc) {
  return g?.grant?.item || String(desc || '').match(/^\s*\[([^\]]{2,60})\]/)?.[1] || branchOf(cmd) || 'it';
}
// Her own hands (main thread): her notes, delegation, light reads. Everything else is a worker's.
const MAIN_ALLOWED = new Set([
  'Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'Task', 'TodoWrite', 'SendMessage',
  'TaskStop', 'TaskOutput', 'WebSearch', 'WebFetch', 'ToolSearch',
  ...MIND_TOOLS, // her brain in TrueMemory — main thread only
]);
/** The real location of a path, following symlinks (macOS: /tmp is /private/tmp). The file
 *  itself may not exist yet, so resolve the nearest existing folder above it. */
function realLocation(p) {
  let dir = path.resolve(String(p));
  const rest = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try { dir = fs.realpathSync(dir); } catch {}
  return path.join(dir, ...rest);
}
function insideHub(p) {
  if (!p) return false;
  const hub = realLocation(HUB_DIR);
  const abs = realLocation(p);
  return abs === hub || abs.startsWith(hub + path.sep);
}
// A worker launched with no subagent_type is general-purpose and would inherit her Opus;
// the hook gives it Sonnet unless the brief named a model.
export function defaultWorkerModel(toolInput) {
  const t = toolInput?.subagent_type;
  if (toolInput?.model) return toolInput.model;
  if (AGENT_MODEL[t]) return AGENT_MODEL[t];
  return !t || t === 'general-purpose' ? 'sonnet' : '';
}
function withModel(input) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return {};
  const ti = input.tool_input || {};
  if (ti.model || (ti.subagent_type && ti.subagent_type !== 'general-purpose')) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, model: 'sonnet' } } };
}
/** `recentUserText`: a string, or a function returning the person's recent words (newest message decides) — used only when no `gate` is given.
 *  `nightBlock`: optional, true once the night's share is used. `gate`: the push gate (createPushGate) that tracks grants per message and dispatch. */
export function fenceHook(recentUserText, nightBlock, gate) {
  const words = () => (typeof recentUserText === 'function' ? recentUserText() : recentUserText);
  return async (input) => {
    const onMainThread = !input.agent_id;
    if (onMainThread) {
      if (input.tool_name === 'Bash') {
        const cmd = String(input.tool_input?.command || '');
        const blocked = blockedBy(cmd);
        if (blocked) return deny(blocked.why);
        const ro = readOnlyBash(cmd);
        if (!ro.ok) return deny(`Sahar's own commands are read-only looks only: ${ro.why}. Otherwise hand this "Bash" to a worker (Agent tool, in the background)`);
        return {};
      }
      if (!MAIN_ALLOWED.has(input.tool_name)) {
        return deny(`Sahar never does the work herself — hand "${input.tool_name}" to a worker (Agent tool, in the background)`);
      }
      if ((input.tool_name === 'Write' || input.tool_name === 'Edit') && !insideHub(input.tool_input?.file_path)) {
        return deny(`Sahar only writes her own notes, and they live in ${HUB_DIR} (e.g. ${path.join(HUB_DIR, 'mind', 'workload.md')}) — check the path; anything outside it goes to a builder`);
      }
      if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && input.tool_input?.run_in_background === false) {
        return deny('workers run in the background so Sahar stays available — call it again without run_in_background:false');
      }
      if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && nightBlock?.()) {
        return deny("the night's share of the budget is used — no new workers until the person is back");
      }
      if (input.tool_name === 'Agent' || input.tool_name === 'Task') gate?.onDispatch(input.tool_use_id, input.tool_input?.description);
      return withModel(input);
    }
    const desc = gate?.descOf(input.agent_id) || '';
    const worker = { worker: true, desc };
    if (MIND_TOOLS.includes(input.tool_name)) return deny('the mind belongs to Sahar herself — a worker reports back and she writes it down', worker);
    if (input.tool_name !== 'Bash') return withModel(input);
    const cmd = String(input.tool_input?.command || '');
    const blocked = blockedBy(cmd);
    if (blocked) return deny(blocked.why, { ...worker, ask: blocked.ask });
    for (const [re, why, kind] of NEEDS_WORD) {
      if (!re.test(cmd)) continue;
      const g = gate ? gate.lookup(input.agent_id) : legacyLookup(words());
      if (!g || g.done) {
        const label = pushLabel(g, cmd, desc);
        const ask = kind === 'pr' ? `Say create PR for ${label} to open it.` : `Say push ${label} to send it.`;
        return deny(g?.done ? 'the push this message allowed already went — one push per "push"' : why, { ...worker, ask });
      }
      const item = g.grant.item;
      if (item && g.desc && !itemMatches(item, g.desc) && !itemMatches(item, cmd)) {
        return deny(`push is for "${item}" — ask the person which item before pushing this one`, { ...worker, ask: `Say push ${pushLabel(null, cmd, g.desc)} to send this one.` });
      }
    }
    return {};
  };
}
/** After a worker's Bash succeeds: a git push spends that worker's one push. */
export function postPushHook(gate) {
  const push = new RegExp(GIT + String.raw`push\b`);
  return async (input) => {
    if (input.agent_id && input.tool_name === 'Bash' && push.test(String(input.tool_input?.command || ''))) gate.pushed(input.agent_id);
    return {};
  };
}
function deny(reason, opts = {}) {
  console.log(`[fence] denied: ${reason}`);
  if (opts.worker) {
    const recent = blockedLog.some((b) => b.why === reason && Date.now() - b.at < 10 * 60 * 1000);
    if (!recent) blockedLog.push({ at: Date.now(), why: reason, ask: opts.ask || '', desc: opts.desc || '' });
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Fenced by the hub: ${reason}.${opts.ask ? ` Ask: "${opts.ask}"` : ''}`,
    },
  };
}

// ── persistence: the hidden session id and the visible thread ─────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}
function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}
function loadThread() {
  try { return JSON.parse(fs.readFileSync(THREAD_FILE, 'utf8')); } catch { return []; }
}
function appendThread(entry) {
  const t = loadThread();
  const item = { t: Date.now(), ...entry };
  t.push(item);
  fs.writeFileSync(THREAD_FILE, JSON.stringify(t.slice(-THREAD_CAP)));
  return item;
}

// What a fresh hidden conversation reads before its first word.
function mindBoot(opening = 'normal') {
  const read = (rel) => {
    try { return fs.readFileSync(path.join(HUB_DIR, rel), 'utf8'); } catch { return `(missing: ${rel})`; }
  };
  const list = (rel) => {
    try { return fs.readdirSync(path.join(HUB_DIR, rel)).filter((f) => f.endsWith('.md')).join(', '); } catch { return '(none)'; }
  };
  const spokenBefore = loadThread().some((e) => e.kind === 'tally');
  // A fresh brain ships with starter files; the agreement's first line marks First Contact as pending.
  let agreementText = '';
  try { agreementText = fs.readFileSync(path.join(HUB_DIR, 'mind', 'agreement.md'), 'utf8'); } catch {}
  const blank = !agreementText || agreementText.includes('first-contact: pending');
  const firstContact = opening === 'restore'
    ? 'NOT NEEDED — we have met before; follow the <restore> instruction below instead of a blank-slate First Contact.'
    : spokenBefore
      ? 'ALREADY HAPPENED in this thread — do not re-introduce yourself or redo it; continue the conversation as the same Sahar. If the agreement is still DRAFT or missing, carry on with what is left of First Contact in passing.'
      : blank
        ? 'PENDING, BLANK SLATE — you have never met this person and your notes are empty. Follow "First Contact — blank slate" in CLAUDE.md.'
        : 'PENDING — this is the first time you speak in this thread; your notes already describe their world.';
  return `<mind>
Attached because a hidden conversation is starting. First Contact: ${firstContact}

<setup>
${setupCheck(tmConnected)}
</setup>
Your decisions with reasons, history, project notes and lessons live in your mind (TrueMemory): call ask_mind before answering or briefing on any task, and before re-reading local files. Fallback when TrueMemory is not connected (the tool says so): read the local files — mind/ → ${list('mind')}; mind/repos/ → ${list('mind/repos')}; history/ → ${list('history')} (recall only) — and behave as before.

=== mind/workload.md ===
${read('mind/workload.md')}

=== mind/standing-rules.md ===
${read('mind/standing-rules.md')}

=== mind/agreement.md ===
${read('mind/agreement.md')}
${fs.existsSync(path.join(HUB_DIR, 'mind', 'persona.md')) ? `\n=== mind/persona.md ===\n${read('mind/persona.md')}\n` : ''}</mind>${opening === 'restore' ? `\n${RESTORE_NOTE}` : ''}`;
}

// ── how a fresh conversation opens: restore from TrueMemory on an empty machine that TrueMemory already knows ──
let pendingOpening = 'normal';
/** Decided before the first message reaches a fresh conversation (async: asks TrueMemory). Existing hubs never reach the network. */
async function prepareOpening() {
  pendingOpening = 'normal';
  if (live.q || loadState().sessionId || loadThread().some((e) => e.kind === 'tally')) return;
  const hubEmpty = hubIsEmpty(HUB_DIR);
  if (!hubEmpty) return;
  let connected = false;
  let mindHasContent = false;
  try {
    connected = !!(await tm.status()).connected;
    if (connected) {
      const c = await tm.consult('Who is this person, how do they work, and what are they working on right now?');
      mindHasContent = (c?.excerpts || []).length > 0 || (c?.memories || []).length > 0;
    }
  } catch {}
  pendingOpening = decideOpening({ hubEmpty, tmConnected: connected, mindHasContent });
  console.log(`[opening] ${pendingOpening} (hub empty, TrueMemory ${connected ? (mindHasContent ? 'knows them' : 'knows nothing yet') : 'not connected'})`);
}

function nowLine() {
  const now = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  return `<now>${now}</now>`;
}

// Plain-English activity lines — the window shows what she's doing, never the machinery.
function activityLine(toolUse) {
  const name = toolUse.name || '';
  const input = toolUse.input || {};
  switch (name) {
    case 'Read': return 'checking my notes';
    case 'Write':
    case 'Edit': return 'writing it down';
    case 'Grep':
    case 'Glob': return 'searching my notes';
    case 'Task':
    case 'Agent': return `handing off: ${input.description || 'a task'}`.toLowerCase();
    case 'mcp__mind__ask_mind': return 'asking my mind';
    case 'mcp__mind__remember':
    case 'mcp__mind__save_knowledge': return 'writing it into my mind';
    case 'TodoWrite': return 'updating the plan';
    case 'WebFetch':
    case 'WebSearch': return 'looking something up';
    default: return 'thinking';
  }
}

// ── main tasks, live: her file + which tasks have workers running right now ──────
const TASKS_FILE = path.join(HUB_DIR, 'mind', 'main-tasks.json');
const CHECKS_DIR = path.join(HUB_DIR, 'mind', 'checks');
const CHECKS_FILE = path.join(DATA_DIR, '.checks.json');
function loadChecks() {
  try { return JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8')) || {}; } catch { return {}; }
}
/** A worker finished on "[Task] …": the task's result now waits for her own check. */
function recordWorkerDone(description) {
  const tag = taskOfWorker(description);
  const card = tag && matchCard(readTasksRaw(), tag);
  const slug = slugOf(card ? card.name : tag);
  if (!slug) return;
  const s = loadChecks();
  s[slug] = Date.now();
  try { fs.writeFileSync(CHECKS_FILE, JSON.stringify(s)); } catch {}
}
function checkMtime(slug) {
  try { return fs.statSync(path.join(CHECKS_DIR, `${slug}.md`)).mtimeMs; } catch { return null; }
}
function readTasksRaw() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  return Array.isArray(tasks) ? tasks : [];
}
/** Raw tasks in a done-ish stage that she has not checked herself yet. */
function uncheckedNow() {
  return uncheckedTasks(readTasksRaw(), loadChecks(), checkMtime);
}
function mainTasks() {
  const tasks = readTasksRaw();
  const running = [...live.workers.values()].filter((w) => w.shown);
  const runningOn = new Map();
  for (const w of running) {
    const card = matchCard(tasks, taskOfWorker(w.task));
    if (card) runningOn.set(card, (runningOn.get(card) || 0) + 1);
  }
  const unchecked = new Set(uncheckedNow().map((t) => slugOf(t.name)));
  return tasks.slice(0, 40).filter((t) => String(t?.stage) !== 'merged').map((t) => {
    const name = String(t?.name || '').slice(0, 60);
    return overlayVerify({
      name,
      title: String(t?.title || '').slice(0, 70),
      now: String(t?.now || '').slice(0, 90),
      project: String(t?.project || '').slice(0, 40),
      stage: String(t?.stage || 'plan'),
      state: String(t?.state || 'waiting'),
      line: String(t?.line || '').slice(0, 140),
      focus: t?.focus !== false,
      running: runningOn.get(t) || 0,
    }, unchecked.has(slugOf(name)));
  });
}
/** A worker started on "[Task] …" and that task has no card yet → add it, so nothing runs unseen. */
function ensureCard(description) {
  const m = String(description || '').match(/^\s*\[([^\]]{2,60})\]\s*(.*)$/);
  if (!m) return;
  const name = m[1].trim();
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch {}
  if (!Array.isArray(tasks)) tasks = [];
  if (matchCard(tasks, name)) return; // same task under a slightly different tag — never a duplicate card
  tasks.push({ name, title: name, project: '', stage: 'build', state: 'moving', line: '', now: m[2].slice(0, 90) });
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 1)); console.log(`[cards] added "${name}" (worker started, no card)`); } catch {}
  pushTasks();
}

let lastTasks = '';
function pushTasks(force = false) {
  const tasks = mainTasks();
  const key = JSON.stringify(tasks);
  if (!force && key === lastTasks) return;
  lastTasks = key;
  broadcast({ type: 'tasks', tasks });
}
const progress = createScheduler({ hub: HUB_DIR, stateFile: path.join(DATA_DIR, '.progress.json'), log: (m) => console.log(m) });
// ── worktree cleanup: when a task closes (done stage or gone from main-tasks.json) its worktrees are removed if provably safe ──
const CLEANUP_STATE = path.join(DATA_DIR, '.cleanup.json');
// finish-first nudge: a NEW card while LOAD_NUDGE_AT or more are open queues one <load> note for her next turn
const LOAD_NUDGE_AT = Number(process.env.LOAD_NUDGE_AT || 8);
const knownCards = new Set();
const loadNotes = [];
let loadBaselined = false;
function loadCheck() {
  const tasks = readTasksRaw();
  if (!tasks.length) return;
  if (!loadBaselined) { loadBaselined = true; loadNudge(tasks, knownCards, Infinity); return; } // existing cards never trigger
  const { note } = loadNudge(tasks, knownCards, LOAD_NUDGE_AT);
  if (note) { loadNotes.push(note); console.log('[load] too many open, nudge queued'); }
}
const cleanupOn = process.env.SAHAR_CLEANUP !== 'off';
const cleanupNotes = []; // short "kept: why" lines, handed to her with the person's next message
let cleanupBusy = false;
let cleanupTimer = null;
const loadCleanup = () => { try { return JSON.parse(fs.readFileSync(CLEANUP_STATE, 'utf8')); } catch { return { tasks: {}, lastFullDay: '' }; } };
const saveCleanup = (s) => { try { fs.writeFileSync(CLEANUP_STATE, JSON.stringify(s, null, 1) + '\n'); } catch {} };
async function cleanupPass({ closedTasks = null } = {}) {
  if (!cleanupOn || cleanupBusy) return;
  cleanupBusy = true;
  try {
    const filter = closedTasks ? (w) => closedTasks.some((t) => matchesTask(t, w)) : null;
    const out = await runCleanup({ apply: true, filter, hub: HUB_DIR, log: (m) => console.log(m) });
    const t = out.report.totals;
    console.log(`[cleanup] ${closedTasks ? `closed task ${closedTasks.map((x) => x.name).join(', ')}` : 'full pass'}: ${out.removed.length} removed, ${t.keep} kept, ${out.failed.length} failed`);
    const note = keptNote(closedTasks ? out.rows : out.rows.filter((r) => r.verdict === 'keep' && r.codes?.some((c) => c === 'uncommitted' || c === 'unpushed')));
    if (note) cleanupNotes.push(closedTasks ? note : `full pass kept worktrees with unfinished work:\n${note}`);
    for (const f of out.failed) cleanupNotes.push(`could not remove ${path.basename(f.row.path)}: ${f.why}`);
  } catch (err) { console.log(`[cleanup] pass failed: ${err?.message}`); }
  cleanupBusy = false;
}
/** Debounced: read the cards, find the tasks that just closed, clean their worktrees. First run only records the baseline. */
function cleanupPoke() {
  if (!cleanupOn) return;
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(async () => {
    const st = loadCleanup();
    const baseline = !st.tasks || !Object.keys(st.tasks).length;
    const { closed, next } = diffClosed(readTasksRaw(), st.tasks || {});
    saveCleanup({ ...st, tasks: next });
    if (baseline || !closed.length) return;
    await cleanupPass({ closedTasks: closed });
  }, 20000);
  cleanupTimer.unref?.();
}
function cleanupNoteForPrefix() {
  if (!cleanupNotes.length) return '';
  const n = cleanupNotes.splice(0).join('\n');
  return `<cleanup>Worktree cleanup kept or could not remove these. Tell the person in one short line why, in plain words, and do nothing else about it:\n${n}</cleanup>\n`;
}
function cleanupFullPassDaily(now = Date.now()) {
  const day = dayKey(now, DAY_TZ);
  const st = loadCleanup();
  if (st.lastFullDay === day) return;
  saveCleanup({ ...st, lastFullDay: day });
  cleanupPass();
}
function watchTasks() {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  try {
    fs.watch(path.dirname(TASKS_FILE), (_e, f) => {
      if (f === 'main-tasks.json') setTimeout(() => pushTasks(), 150);
      if (f === 'main-tasks.json' || f === 'standing-rules.md' || f === 'agreement.md') { progress.poke(); cleanupPoke(); loadCheck(); } // progress memories + knowledge docs, debounced, non-blocking
    });
  } catch {}
  fs.mkdirSync(CHECKS_DIR, { recursive: true });
  try { fs.watch(CHECKS_DIR, () => setTimeout(() => pushTasks(), 150)); } catch {}
}

// ── live clients (Server-Sent Events) ─────────────────────────────────────────
const clients = new Set();
function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}

// ── the one long-lived conversation ───────────────────────────────────────────
const live = {
  q: null,             // the SDK query
  push: null,          // feeds a user message into it
  close: null,         // ends its input stream
  turnActive: false,   // she is composing a reply right now
  workers: new Map(),  // task_id → { agent, model, task }
  workerByToolUse: new Map(), // tool_use_id → { agent, model, task }
  mainModel: '',
  lastCtx: 0,
  windowSize: 200000,
  rotating: false,
  heldDuringRotation: [], // messages that arrive while she writes down; delivered to the fresh conversation
  recentWords: [],     // the person's last few messages (display/debug only; push unlock lives in pushGate)
  lastActivityAt: Date.now(), // last message or worker finish (rotation waits for quiet)
  pendingMarks: {},    // morning/wrap/ask marks, committed only once the turn that carried them succeeds
};
const pushGate = createPushGate();

function recentUserText() {
  return live.recentWords.join('\n\u0000');
}

function makeInput() {
  const pending = [];
  let wake = null;
  let ended = false;
  async function* stream() {
    while (!ended) {
      if (pending.length === 0) {
        await new Promise((r) => { wake = r; });
        wake = null;
        continue;
      }
      yield pending.shift();
    }
  }
  return {
    stream: stream(),
    push(text, extraBlocks = []) {
      pending.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }, ...extraBlocks] },
        parent_tool_use_id: null,
        session_id: '',
      });
      if (wake) wake();
    },
    end() {
      ended = true;
      if (wake) wake();
    },
  };
}

// The last TrueMemory proof result, kept so the panel can show it again after a page refresh.
let lastProof = null;

function setBusy(on) {
  live.turnActive = on;
  broadcast({ type: 'busy', on });
}

function startConversation({ resume } = {}) {
  const input = makeInput();
  const q = query({
    prompt: input.stream,
    options: {
      cwd: HUB_DIR,
      model: MAIN_MODEL,
      ...(resume ? { resume } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SAHAR_STYLE },
      // The person's own global Claude Code instructions apply (SAHAR_USER_SETTINGS=off skips them).
      settingSources: process.env.SAHAR_USER_SETTINGS === 'off' ? ['project'] : ['user', 'project'],
      agents: AGENTS,
      permissionMode: 'default',
      canUseTool: async (_name, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
      mcpServers: { mind: mindServer },
      hooks: {
        PreToolUse: [{ hooks: [fenceHook(recentUserText, nightCapReached, pushGate)] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [postPushHook(pushGate)] }],
      },
    },
  });
  live.q = q;
  live.push = input.push;
  live.close = () => { input.end(); try { q.close(); } catch {} };
  consume(q).catch((err) => {
    console.log(`[conversation] ended with error: ${err?.message}`);
    if (resume && /resume|session|conversation|not found|no such/i.test(String(err?.message))) {
      clearState();
      say('I lost my thread for a moment and rebuilt it from my notes.');
    } else {
      say(`Something broke on my side — not a quiet day: ${err?.message}`);
    }
    live.q = null;
    live.push = null;
    setBusy(false);
  });
  return q;
}

function say(text) {
  const item = appendThread({ kind: 'tally', text, model: modelLabel(live.mainModel) });
  broadcast({ type: 'text', text, model: item.model });
}

async function consume(q) {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      live.mainModel = m.model;
      saveState({ ...loadState(), sessionId: m.session_id });
      broadcast({ type: 'model', model: modelLabel(m.model) });
    } else if (m.type === 'system' && m.subtype === 'task_started') {
      const meta = live.workerByToolUse.get(m.tool_use_id) || {
        agent: m.subagent_type || 'worker', model: AGENT_MODEL[m.subagent_type] ? ALIAS_LABEL[AGENT_MODEL[m.subagent_type]] : '', task: m.description,
      };
      if (m.ambient) continue;
      // Only real workers (Agent tasks) show in the thread; a worker's own background
      // commands still count as running work, so a restart never cuts them off.
      meta.shown = m.task_type ? m.task_type === 'local_agent' : !!m.subagent_type;
      live.workers.set(m.task_id, meta);
      pushGate.bindTask(m.tool_use_id, m.task_id);
      live.lastActivityAt = Date.now();
      if (meta.shown) ensureCard(meta.task);
      broadcast({ type: 'workers', count: live.workers.size });
      pushTasks();
    } else if (m.type === 'system' && m.subtype === 'task_notification') {
      const meta = live.workers.get(m.task_id);
      live.workers.delete(m.task_id);
      pushGate.finish(m.task_id);
      live.lastActivityAt = Date.now();
      if (meta && meta.shown && !m.ambient && m.status === 'completed') recordWorkerDone(meta.task);
      broadcast({ type: 'workers', count: live.workers.size });
      pushTasks();
      if (meta && meta.shown && !m.ambient) {
        const item = appendThread({ kind: 'worker', phase: 'done', status: m.status, agent: meta.agent, model: meta.model, task: meta.task });
        broadcast({ type: 'worker', ...item });
      }
    } else if (m.type === 'assistant') {
      if (m.parent_tool_use_id) continue; // a worker's own messages — not Sahar speaking
      if (!live.turnActive) setBusy(true);
      const u = m.message?.usage;
      if (u) live.lastCtx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          if (live.rotating) continue;
          if (night.nightActive) { nightHeard(block.text); continue; }
          say(block.text);
        } else if (block.type === 'tool_use') {
          broadcast({ type: 'status', text: activityLine(block) });
          if (block.name === 'Task' || block.name === 'Agent') {
            const t = block.input?.subagent_type || 'general-purpose';
            const alias = defaultWorkerModel(block.input);
            const meta = {
              agent: t,
              model: alias ? ALIAS_LABEL[alias] || modelLabel(alias) : 'same model',
              task: block.input?.description || '',
            };
            live.workerByToolUse.set(block.id, meta);
            const item = appendThread({ kind: 'worker', phase: 'start', ...meta });
            broadcast({ type: 'worker', ...item });
          }
        }
      }
    } else if (m.type === 'result') {
      // Loud, never quiet: a turn that failed (usage limit, API error) says so.
      if (m.is_error || (m.subtype && m.subtype !== 'success')) {
        const why = (typeof m.result === 'string' && m.result.trim()) || (m.errors || []).join('; ') || m.subtype;
        console.log(`[turn] failed: ${why}`);
        say(`That didn't go through on my side — ${why}`);
        live.pendingMarks = {}; // a morning/wrap that did not land is not "done" — it is retried
        nightTurnFailed(why);
      } else {
        commitMarks();
      }
      live.nightTurn = false;
      const mu = m.modelUsage?.[live.mainModel];
      if (mu?.contextWindow) live.windowSize = mu.contextWindow;
      setBusy(false);
      afterTurn();
    }
  }
}

// After each reply: rotate if the hidden conversation got heavy and no worker is running.
function afterTurn() {
  if (live.rotating) {
    console.log('[rotate] written down — the next message starts fresh from the mind');
    live.rotating = false;
    live.close?.();
    live.q = null;
    live.push = null;
    clearState();
    applySync({ hub: HUB_DIR, log: (m) => console.log(`[tm-sync] ${m}`) }).then((r) => console.log(`[tm-sync] after rotation: ${r.uploaded} new, ${r.replaced} replaced, ${r.memories} memories, ${r.errors.length} errors`)).catch((err) => console.log(`[tm-sync] skipped: ${tm.friendlyError(err)}`));
    const held = live.heldDuringRotation.splice(0);
    for (const m of held) deliver(m.text, m.attachments, m.opts);
    return;
  }
  const share = live.windowSize ? live.lastCtx / live.windowSize : 0;
  saveState({ ...loadState(), lastCtx: live.lastCtx, share: Number(share.toFixed(3)) });
  if (maybeRotate()) return;
  nightCapCheck();
}

/** Rotate only when heavy AND idle (no workers, no turn, no unchecked verdict, 2 minutes quiet). Also polled on a timer, since a busy moment can end without another turn. */
function maybeRotate() {
  const d = rotateDecision({
    ctx: live.lastCtx, windowSize: live.windowSize, rotateAt: ROTATE_AT, rotateTokens: ROTATE_TOKENS,
    workers: live.workers.size, turnActive: live.turnActive, rotating: live.rotating, hasConversation: !!live.push,
    unchecked: uncheckedNow().length, sinceActivityMs: Date.now() - live.lastActivityAt,
  });
  if (!d.rotate) return false;
  console.log(`[rotate] context ${live.lastCtx}/${live.windowSize} — idle, writing down first`);
  live.rotating = true;
  live.push(ROTATION_PROMPT);
  return true;
}
/** A morning/wrap/ask mark counts only once the turn that carried it succeeded. */
function commitMarks() {
  const p = live.pendingMarks;
  live.pendingMarks = {};
  if (!p.morningDay && !p.wrapDay && !p.askedAt) return;
  if (p.morningDay) night.lastMorningDate = p.morningDay;
  if (p.wrapDay) night.lastWrapDate = p.wrapDay;
  if (p.askedAt) night.askedAt = p.askedAt;
  saveNight();
}

/** A dropped file, resolved safely inside the upload folder — or null. */
function uploadedFile(name) {
  const safe = path.basename(String(name || ''));
  const full = path.join(UPLOAD_DIR, safe);
  return safe && fs.existsSync(full) ? { name: safe, full } : null;
}

// opts.user: typed by the person (ends a night shift with a briefing). opts.night: the server's own night-shift note.
function deliver(text, attachments = [], opts = {}) {
  // Never feed a message into a conversation that is being written down and closed —
  // it would be answered inside the hidden rotation turn and the reply lost.
  if (live.rotating) {
    live.heldDuringRotation.push({ text, attachments, opts });
    if (!live.turnActive) setBusy(true);
    return;
  }
  live.lastActivityAt = Date.now();
  // A night-shift note must never count as the person's words (it mentions "push" and "PR"). Each of the person's
  // messages replaces the push allowance: no push word → nothing is unlocked for what she dispatches in reply.
  if (!opts.night && !opts.wrap) {
    live.recentWords = [...live.recentWords, text].slice(-3);
    pushGate.onMessage(text, readTasksRaw().map((t) => String(t?.name || '')).filter(Boolean));
  } else {
    pushGate.clearLive();
  }
  const cards = mainTasks().map((t) => `${t.title || t.name} (${t.stage})`).join(' · ') || 'none';
  let prefix = nowLine() + `\n<cards>Cards now: ${cards}. If this message starts, agrees or names a task with no card, add its card now; if it closes, merges, drops or parks one, remove that card now.</cards>\n`;
  const today = dayKey(Date.now(), DAY_TZ);
  const morning = opts.user && morningDue({ now: Date.now(), lastMorningDate: night.lastMorningDate }) && live.pendingMarks.morningDay !== today;
  if (morning) {
    // marked done only when the turn succeeds (commitMarks), so a briefing lost to a limit is given on the next message
    live.pendingMarks.morningDay = today;
    const ask = askDue({ now: Date.now(), answeredAt: usageAnsweredAt(), askedAt: night.askedAt });
    if (ask) live.pendingMarks.askedAt = Date.now();
    prefix += `<morning>${morningNote(ask)}${night.nightActive ? ' The night shift ran too: merge it into this same briefing, not a second one.' : ''}</morning>\n`;
  }
  if (opts.user && night.nightActive) {
    prefix += `<briefing>The person is back after your night shift. Open mind/night/${nightDate()}.md and any other file in mind/night from this shift, then start your reply with ONE short briefing (merged with the <morning> note if there is one): Done (checked and passed) / Decided alone (each with its reason and how to undo it) / Needs you (questions and blockers, with the evidence). Update the cards and main-tasks.json to match, then answer their message.</briefing>\n`;
    night.nightActive = false;
    night.nightIdle = false;
    saveNight();
  }
  prefix += cleanupNoteForPrefix();
  if (loadNotes.length) prefix += loadNotes.splice(0).join('\n') + '\n';
  prefix += blockedNote();
  prefix += uncheckedNote(uncheckedNow());
  if (!live.q) {
    const { sessionId } = loadState();
    startConversation({ resume: sessionId });
    if (!sessionId) { prefix += mindBoot(pendingOpening) + '\n'; pendingOpening = 'normal'; }
  }
  // Every file is named with its local path (workers open it from there); images small
  // enough are also attached so she sees them herself.
  const blocks = [];
  const lines = [];
  for (const a of attachments) {
    const f = uploadedFile(a.name);
    if (!f) continue;
    lines.push(`- ${a.label || f.name} → ${f.full}`);
    const size = fs.statSync(f.full).size;
    if (IMAGE_TYPES.has(a.type) && size <= MAX_INLINE_IMAGE_BYTES) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: fs.readFileSync(f.full).toString('base64') } });
    }
  }
  const files = lines.length ? `\n\n<attached>The person attached these files (saved on this machine; hand a worker the path when it needs them):\n${lines.join('\n')}</attached>` : '';
  if (opts.wrapDay) live.pendingMarks.wrapDay = opts.wrapDay;
  live.push(prefix + (text || '(see the attached files)') + files, blocks);
  if (!live.turnActive) setBusy(true);
}

const MORNING_BASE = "First message of the day. Before answering, call ask_mind, then open with ONE short briefing: today's focus (main-tasks.json and mind/workload.md); what is due, or waiting on someone and for how long; the items nearest to done to close first; what you will start now.";
const MORNING_ASK = " No calendar is connected: end with ONE line asking any meetings today to plan around, and roughly how much of this week's usage is left; save meetings via remember() and the budget as {\"weeklyRemainingUnits\": N, \"setAt\": epoch ms} in .budget.json. Ask it this once; if the person does not answer, let it go.";
const MORNING_NO_ASK = " Do NOT ask about meetings or usage: it was answered in the last 7 days or already asked today.";
const MORNING_TAIL = " If knowledge doc vision-and-priorities.md does not exist yet, draft it from ask_mind and the agreement and ask the person to correct it once.";
const morningNote = (ask) => MORNING_BASE + (ask ? MORNING_ASK : MORNING_NO_ASK) + MORNING_TAIL;
/** When the person last gave the usage numbers (ms), or 0. */
function usageAnsweredAt() {
  try { return Number(JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')).setAt) || 0; } catch { return 0; }
}
/** Fence denials of her workers, handed to her once so the person hears of them in her next reply. */
function blockedNote() {
  const items = takeBlocked();
  if (!items.length) return '';
  markNeedsYou(items);
  const lines = items.slice(0, 5).map((b) => `- ${b.why}${b.ask ? ` → ${b.ask}` : ''}`).join('\n');
  return `<blocked>A fence stopped a worker. Begin your reply with a short "Blocked:" line: what was stopped and the ONE thing the person must do (use the sentence given). The card is marked needs-you.\n${lines}</blocked>\n`;
}
/** The blocked worker's card shows needs-you in the strip (other fields untouched). */
function markNeedsYou(items) {
  const tasks = readTasksRaw();
  let changed = false;
  for (const b of items) {
    const tag = taskOfWorker(b.desc);
    const card = tag && matchCard(tasks, tag);
    if (card && card.state !== 'needs-you') { card.state = 'needs-you'; card.line = `Blocked: ${b.why}`.split(/\s+/).slice(0, 12).join(' '); changed = true; }
  }
  if (changed) { try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 1)); } catch {} pushTasks(); }
}
const DAY_WRAP_HOUR = parseWrapHour(process.env.DAY_WRAP_HOUR, 18.5);
const BUDGET_FILE = path.join(DATA_DIR, '.budget.json');
/** Remaining weekly units she saved from the person's answer; only valid until the weekly reset. */
function budgetHint(week) {
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    const n = Number(b.weeklyRemainingUnits);
    return Number.isFinite(n) && n >= 0 && b.setAt >= week.start && b.setAt < week.next ? { remaining: n, setAt: b.setAt } : null;
  } catch { return null; }
}

// ── the night shift: her own clock ─────────────────────────────────────────────
// A heartbeat plus a single wake after a limit resets. When the person has been away for
// a while she gets ONE hidden instruction turn; nothing here loops while a limit is on.
const NIGHT_HEARTBEAT_MIN = Number(process.env.NIGHT_HEARTBEAT_MIN || 30);
const NIGHT_AWAY_MIN = Number(process.env.NIGHT_AWAY_MIN || 45);
const NIGHT_AFTER_RESET_MS = 3 * 60 * 1000;
const NIGHT_MAX_UNITS = Number(process.env.NIGHT_MAX_UNITS || 30); // flat per-night cap, in estimated units (night.mjs)
const NIGHT_WEEKLY_BUDGET_UNITS = process.env.NIGHT_WEEKLY_BUDGET_UNITS ? Number(process.env.NIGHT_WEEKLY_BUDGET_UNITS) : NaN;
const NIGHT_WEEK = { dow: Number(process.env.NIGHT_WEEK_RESET_DOW ?? 2), hour: Number(process.env.NIGHT_WEEK_RESET_HOUR ?? 1) };
const NIGHT_FILE = path.join(DATA_DIR, '.night.json');
const NIGHT_LOGS = process.env.NIGHT_LOGS_DIR || path.join(os.homedir(), '.claude', 'projects', HUB_DIR.replace(/[^A-Za-z0-9]/g, '-'));
const meter = createUsageMeter(NIGHT_LOGS);
const night = (() => {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(NIGHT_FILE, 'utf8')); } catch {}
  if (!s.lastUserAt) {
    const last = loadThread().filter((e) => e.kind === 'user').pop();
    s.lastUserAt = last?.t || 0;
  }
  return { limitedUntil: 0, lastWakeAt: 0, nightActive: false, nightStartedAt: 0, nightIdle: false, capNoted: false, ...s };
})();
let nextHeartbeatAt = 0;
let lastTickLine = '';
let limitTimer = null;
function saveNight() {
  try { fs.writeFileSync(NIGHT_FILE, JSON.stringify(night)); } catch {}
}
function touchUser() {
  night.lastUserAt = Date.now();
  night.nightIdle = false;
  saveNight();
}
function nightDate() {
  const d = new Date(night.nightStartedAt || Date.now());
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
// ESTIMATE only: spend is summed from her own session logs with rough price weights; the real
// remaining allowance is not readable anywhere.
function nightCap(now = Date.now()) {
  const week = weekWindow(now, NIGHT_WEEK);
  const hint = budgetHint(week);
  return {
    ...capMath({
      ...(Number.isFinite(NIGHT_WEEKLY_BUDGET_UNITS) || !hint
        ? { budget: NIGHT_WEEKLY_BUDGET_UNITS, usedThisWeek: Number.isFinite(NIGHT_WEEKLY_BUDGET_UNITS) ? meter.unitsSince(week.start, now) : 0 }
        : { budget: hint.remaining, usedThisWeek: 0 }),
      now, nextReset: week.next, maxUnits: NIGHT_MAX_UNITS,
      nightSpent: night.nightActive && night.nightStartedAt ? meter.unitsSince(night.nightStartedAt, now) : 0,
    }),
    weekResetAt: week.next,
  };
}
function nightCapReached() {
  return night.nightActive && !nightCap().ok;
}
function nightHeard(text) {
  if (/night shift:\s*nothing left/i.test(text)) { night.nightIdle = true; saveNight(); }
  try {
    fs.mkdirSync(path.join(HUB_DIR, 'mind', 'night'), { recursive: true });
    fs.appendFileSync(path.join(HUB_DIR, 'mind', 'night', `${nightDate()}.talk.md`), `- ${new Date().toTimeString().slice(0, 5)} ${String(text).replace(/\s+/g, ' ').trim().slice(0, 400)}\n`);
  } catch {}
}
function scheduleLimitWake() {
  clearTimeout(limitTimer);
  limitTimer = null;
  const wait = night.limitedUntil - Date.now();
  if (wait <= 0) return;
  limitTimer = setTimeout(() => (Date.now() >= night.limitedUntil ? nightTick('limit-reset') : scheduleLimitWake()), Math.min(wait + 500, 2 ** 31 - 1));
}
/** A failed turn: a limit message sets ONE wake just after its reset; any other failure of a night turn backs off an hour. */
function nightTurnFailed(why) {
  const now = Date.now();
  if (looksLikeLimit(why)) {
    const reset = parseResetTime(why, now);
    const until = reset ? reset + NIGHT_AFTER_RESET_MS : now + 60 * 60 * 1000;
    const fresh = !(night.limitedUntil > now) || Math.abs(until - night.limitedUntil) > 10 * 60 * 1000;
    night.limitedUntil = until;
    if (fresh) {
      // said once, in the log and in the window — the heartbeat stays quiet until the reset
      console.log(`[night] limit hit — no wakes until ${new Date(until).toISOString()}${reset ? '' : ' (no reset time in the message; 1h fallback)'}`);
      const text = `Limited until ${limitClock(reset || until, now)}`;
      const item = appendThread({ kind: 'note', text });
      broadcast({ type: 'note', ...item });
    }
  } else if (live.nightTurn) {
    night.limitedUntil = now + 60 * 60 * 1000;
    console.log('[night] a night turn failed — backing off 1h');
  } else return;
  saveNight();
  scheduleLimitWake();
}
/** "17:30" for today, "Tue 13 Oct, 01:00" for another day (her own clock's time zone). */
function limitClock(ms, now = Date.now()) {
  const time = new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: DAY_TZ });
  if (dayKey(ms, DAY_TZ) === dayKey(now, DAY_TZ)) return time;
  return `${new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: DAY_TZ })}, ${time}`;
}
function nightInstruction(cap) {
  const f = `mind/night/${nightDate()}.md`;
  return `${nowLine()}
<night-shift>The person has been away for ${NIGHT_AWAY_MIN}+ minutes. Run the night shift per your rules (hub CLAUDE.md "Night shift"): work the pending list in main-tasks.json in priority order, focus first; local, reversible steps only; every fence unchanged; small calls only inside an agreed decision in mind/decisions.md, logged with reason and undo; everything else to "Needs you". Every worker brief has a "Done means:" checklist and you check the real result yourself against it (one retry, then park). Save every brief and check result in ${f} (${HUB_DIR}/${f}). Estimated night spend so far ${cap.spent.toFixed(1)} of ${cap.cap.toFixed(1)} units. If nothing doable is left, reply exactly: night shift: nothing left.</night-shift>`;
}
/** Heartbeat and limit-reset wakes both come through here. */
/** End-of-day wrap: once per local day, a visible turn, only when she is idle and the person wrote today. */
function wrapTick(now = Date.now()) {
  if (night.limitedUntil > now) return { wrap: false, reason: 'limited until reset' };
  const tries = night.wrapTries?.day === dayKey(now, DAY_TZ) ? night.wrapTries.n : 0;
  if (tries >= 3) return { wrap: false, reason: 'wrap failed 3 times today' };
  const d = wrapDecision({
    now, lastUserAt: night.lastUserAt, lastWrapDate: night.lastWrapDate, wrapHour: DAY_WRAP_HOUR,
    turnActive: live.turnActive, rotating: live.rotating, workers: live.workers.size, nightActive: night.nightActive,
  });
  if (!d.wrap) return d;
  // lastWrapDate is set only when the wrap turn succeeds (commitMarks); a wrap lost to a limit is retried after the reset
  night.wrapTries = { day: dayKey(now, DAY_TZ), n: tries + 1 };
  saveNight();
  console.log('[day] end-of-day wrap');
  cleanupFullPassDaily(now);
  deliver(`${nowLine()}\n<wrap>It is the end of the day. Give the person ONE short wrap, after ask_mind: what closed today, what moved, what is stuck and why, tomorrow's first moves. Then remember() the day's outcome in one note. Update the cards to match.</wrap>`, [], { wrap: true, wrapDay: dayKey(now, DAY_TZ) });
  return d;
}
function nightTick(source) {
  const now = Date.now();
  if (source === 'heartbeat') nextHeartbeatAt = now + NIGHT_HEARTBEAT_MIN * 60000;
  if (night.limitedUntil && now >= night.limitedUntil) { night.limitedUntil = 0; saveNight(); }
  if (wrapTick(now).wrap) return { wake: false, reason: 'day wrap' };
  const cap = nightCap(now);
  const d = wakeDecision({
    now, away: isAway({ now, lastUserAt: night.lastUserAt, awayMs: NIGHT_AWAY_MIN * 60000 }),
    limitedUntil: night.limitedUntil, turnActive: live.turnActive, rotating: live.rotating,
    workers: live.workers.size, nightIdle: night.nightIdle, capOk: cap.ok,
  });
  const line = d.wake ? 'waking her' : d.reason;
  if (source !== 'heartbeat' || line !== lastTickLine) console.log(`[night] ${source}: ${line}`); // a quiet heartbeat logs only when its answer changes
  lastTickLine = line;
  if (!d.wake) return d;
  if (!night.nightActive) {
    Object.assign(night, { nightActive: true, nightStartedAt: now, nightIdle: false, capNoted: false });
    try { fs.mkdirSync(path.join(HUB_DIR, 'mind', 'night'), { recursive: true }); } catch {}
  }
  night.lastWakeAt = now;
  saveNight();
  live.nightTurn = true;
  deliver(nightInstruction(nightCap(now)), [], { night: true });
  return d;
}
/** After each turn of a night shift: once the night's share is used, tell her once to stop and note it. */
function nightCapCheck() {
  if (!night.nightActive || night.capNoted || live.rotating) return;
  const cap = nightCap();
  if (cap.ok) return;
  night.capNoted = true;
  night.nightIdle = true;
  saveNight();
  console.log(`[night] share used (${cap.spent.toFixed(1)}/${cap.cap.toFixed(1)} units) — telling her to stop`);
  live.nightTurn = true;
  deliver(`${nowLine()}\n<night-shift>The night's share of the budget is used (about ${cap.spent.toFixed(1)} of ${cap.cap.toFixed(1)} estimated units). Launch no new workers. Let running ones finish, add a line to mind/night/${nightDate()}.md saying the cap stopped the shift and what is still pending, then reply exactly: night shift: nothing left.</night-shift>`, [], { night: true });
}
function nightStatus() {
  const now = Date.now();
  const cap = nightCap(now);
  return {
    now: new Date(now).toISOString(),
    away: isAway({ now, lastUserAt: night.lastUserAt, awayMs: NIGHT_AWAY_MIN * 60000 }),
    awayAfterMin: NIGHT_AWAY_MIN,
    lastUserAt: night.lastUserAt ? new Date(night.lastUserAt).toISOString() : null,
    limitedUntil: night.limitedUntil > now ? new Date(night.limitedUntil).toISOString() : null,
    nextWake: night.limitedUntil > now ? new Date(night.limitedUntil).toISOString() : (nextHeartbeatAt ? new Date(nextHeartbeatAt).toISOString() : null),
    nextWakeKind: night.limitedUntil > now ? 'limit-reset' : 'heartbeat',
    lastWakeAt: night.lastWakeAt ? new Date(night.lastWakeAt).toISOString() : null,
    nightActive: night.nightActive,
    nightIdle: night.nightIdle,
    spend: { estimate: true, nightUnits: Number(cap.spent.toFixed(2)), capUnits: Number(cap.cap.toFixed(2)), weeklyBudgetUnits: Number.isFinite(NIGHT_WEEKLY_BUDGET_UNITS) ? NIGHT_WEEKLY_BUDGET_UNITS : null, weeklyRemainingUnits: cap.remaining, weekResetsAt: new Date(cap.weekResetAt).toISOString() },
    caffeinate: process.env.NIGHT_CAFFEINATE === '1',
  };
}
function startNight() {
  scheduleLimitWake();
  nextHeartbeatAt = Date.now() + NIGHT_HEARTBEAT_MIN * 60000;
  setInterval(() => nightTick('heartbeat'), NIGHT_HEARTBEAT_MIN * 60000);
  setInterval(() => { try { maybeRotate(); } catch (err) { console.log(`[rotate] check failed: ${err?.message}`); } }, 30000);
  if (process.env.NIGHT_CAFFEINATE === '1') {
    // keeps the Mac from idle-sleeping for as long as this process lives; changes no system setting
    try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}); } catch {}
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(UI_DIR, 'public', 'index.html')));
  } else if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', busy: live.turnActive, workers: live.workers.size, model: modelLabel(live.mainModel || MAIN_MODEL), modelId: MAIN_MODEL, models: MODEL_CHOICES.map((id) => ({ id, label: modelLabel(id) })), tasks: mainTasks() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  } else if (req.method === 'POST' && req.url === '/upload') {
    // One file per request; the body is the raw bytes. Name + type ride in headers.
    const label = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).slice(0, 200);
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) { res.writeHead(413).end(); return; }
      chunks.push(c);
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${path.basename(label).replace(/[^\w.\-]+/g, '_')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, label, type, size }));
  } else if (req.method === 'GET' && req.url.startsWith('/uploads/')) {
    const f = uploadedFile(decodeURIComponent(req.url.slice('/uploads/'.length)));
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff' });
    res.end(fs.readFileSync(f.full));
  } else if (req.method === 'POST' && req.url === '/message') {
    let text = '';
    let hidden = false;
    let attachments = [];
    try { ({ text, hidden = false, attachments = [] } = JSON.parse(await readBody(req))); } catch {}
    text = String(text || '').trim();
    attachments = Array.isArray(attachments) ? attachments.filter((a) => uploadedFile(a?.name)).slice(0, 10) : [];
    if (!text && attachments.length === 0) { res.writeHead(400).end(); return; }
    if (!hidden) {
      const item = appendThread({ kind: 'user', text, attachments });
      broadcast({ type: 'user', ...item });
      touchUser();
    }
    await prepareOpening();
    deliver(text, attachments, { user: !hidden });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === 'POST' && req.url === '/model') {
    let model = '';
    try { ({ model = '' } = JSON.parse(await readBody(req))); } catch {}
    if (!MODEL_CHOICES.includes(model)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown model' })); return; }
    MAIN_MODEL = model;
    try { fs.writeFileSync(MODEL_FILE, model); } catch {}
    if (live.q) { try { await live.q.setModel(model); } catch (err) { console.log(`[model] switch failed: ${err?.message}`); } }
    live.mainModel = model;
    console.log(`[model] now ${model}`);
    broadcast({ type: 'model', model: modelLabel(model), id: model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model }));
  } else if (req.method === 'POST' && req.url === '/stop') {
    // Stops what she is saying or doing right now; background workers keep going.
    if (live.q && live.turnActive) {
      try { await live.q.interrupt(); } catch (err) { console.log(`[stop] interrupt failed: ${err?.message}`); }
      setBusy(false);
      const item = appendThread({ kind: 'note', text: 'stopped' });
      broadcast({ type: 'note', ...item });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workers: live.workers.size }));
  } else if (req.method === 'GET' && req.url === '/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mainTasks()));
  } else if (req.method === 'GET' && req.url === '/thread') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadThread()));
  } else if (req.method === 'GET' && req.url === '/night') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nightStatus()));
  } else if (req.method === 'POST' && req.url === '/tm/connect') {
    let email = '', password = '';
    try { ({ email = '', password = '' } = JSON.parse(await readBody(req))); } catch {}
    email = String(email).trim(); password = String(password);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!email || !password) { res.end(JSON.stringify({ ok: false, error: 'Enter your TrueMemory email and password.' })); return; }
    try {
      const { user } = await tm.connect(email, password);
      tmConnected = true;
      res.end(JSON.stringify({ ok: true, user }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: tm.friendlyError(err) }));
    }
  } else if (req.method === 'POST' && req.url === '/tm/set-password') {
    let email = '';
    try { ({ email = '' } = JSON.parse(await readBody(req))); } catch {}
    email = String(email).trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!email) { res.end(JSON.stringify({ ok: false, error: 'Enter your TrueMemory email first.' })); return; }
    try { await tm.sendSetPasswordEmail(email); res.end(JSON.stringify({ ok: true })); }
    catch (err) { res.end(JSON.stringify({ ok: false, error: tm.friendlyError(err) })); }
  } else if (req.method === 'GET' && req.url === '/tm/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify({ ...(await tm.status()), lastProof })); } catch (err) { res.end(JSON.stringify({ connected: false, error: tm.friendlyError(err) })); }
  } else if (req.method === 'POST' && req.url === '/tm/proof') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try { lastProof = { ...(await tm.runProof()), at: Date.now() }; } catch (err) { lastProof = { passed: false, at: Date.now(), steps: [{ step: 'proof', ok: false, error: tm.friendlyError(err) }] }; }
    res.end(JSON.stringify(lastProof));
  } else if (req.method === 'GET' && req.url === '/health') {
    const s = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hub: HUB_DIR, model: MAIN_MODEL, session: s.sessionId || null, live: !!live.q, busy: live.turnActive, workers: live.workers.size, share: s.share || 0 }));
  } else {
    res.writeHead(404).end();
  }
});

// Listen only when run directly; tests import the fence without starting a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureHub();
  watchTasks();
  loadCheck(); progress.poke(); cleanupPoke(); // catch up on changes made while the server was down
  startNight();
  refreshTmSetup();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Sahar on http://localhost:${PORT} — hub: ${HUB_DIR} — ${MAIN_MODEL} — never busy, workers in the background — rotate at ${Math.round(ROTATE_AT * 100)}% or ${ROTATE_TOKENS} tokens`);
  });
}
