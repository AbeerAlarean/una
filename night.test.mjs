// Deterministic tests for the night shift helpers (no model, no server).
import { parseResetTime, looksLikeLimit, isAway, wakeDecision, capMath, weekWindow, usageUnits, rotateDecision, askDue, dayKey } from './night.mjs';
import { fenceHook, defaultWorkerModel } from './server.mjs';

let bad = 0, n = 0;
const eq = (name, got, exp) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(exp)) { bad++; console.log(`MISMATCH ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`); }
};
const kl = (iso) => Date.parse(iso + '+08:00');

// ── reset-time parser (Asia/Kuala_Lumpur = UTC+8, no DST) ──
const now = kl('2026-10-11T10:00:00');
eq('time only, later today', parseResetTime("You've hit your limit · your session limit resets 5:30pm (Asia/Kuala_Lumpur)", now), kl('2026-10-11T17:30:00'));
eq('time only, already passed → tomorrow', parseResetTime('resets 5:30am (Asia/Kuala_Lumpur)', now), kl('2026-10-12T05:30:00'));
eq('no minutes', parseResetTime('your session limit resets 1pm (Asia/Kuala_Lumpur)', now), kl('2026-10-11T13:00:00'));
eq('12am is midnight', parseResetTime('resets 12:50am (Asia/Kuala_Lumpur)', now), kl('2026-10-12T00:50:00'));
eq('12pm is noon', parseResetTime('resets 12:50pm (Asia/Kuala_Lumpur)', now), kl('2026-10-11T12:50:00'));
eq('date + at', parseResetTime('resets Oct 13 at 1am (Asia/Kuala_Lumpur)', now), kl('2026-10-13T01:00:00'));
eq('date, minutes, no at', parseResetTime('resets Oct 13 1:15am (Asia/Kuala_Lumpur)', now), kl('2026-10-13T01:15:00'));
eq('other zone is honoured', parseResetTime('resets 5:30am (UTC)', kl('2026-10-11T10:00:00')), Date.parse('2026-10-11T05:30:00Z'));
eq('year rollover', parseResetTime('resets Jan 2 at 9am (Asia/Kuala_Lumpur)', kl('2026-12-31T22:00:00')), kl('2027-01-02T09:00:00'));
eq('no reset in text', parseResetTime('Not logged in · Please run /login', now), null);
eq('bad zone', parseResetTime('resets 5am (Nowhere/Land)', now), null);
eq('limit detected', looksLikeLimit("You've hit your individual spend limit · resets 10:50pm (Asia/Kuala_Lumpur)"), true);
eq('login is not a limit', looksLikeLimit('Not logged in · Please run /login'), false);

// ── away logic ──
const MIN = 60000;
eq('active 10 min ago is not away', isAway({ now: 100 * MIN, lastUserAt: 90 * MIN, awayMs: 45 * MIN }), false);
eq('46 min ago is away', isAway({ now: 100 * MIN, lastUserAt: 54 * MIN, awayMs: 45 * MIN }), true);
eq('exactly 45 min is away', isAway({ now: 100 * MIN, lastUserAt: 55 * MIN, awayMs: 45 * MIN }), true);
eq('unknown activity counts as away', isAway({ now: 100 * MIN, lastUserAt: 0, awayMs: 45 * MIN }), true);
const base = { now: 1000, away: true, limitedUntil: 0, turnActive: false, rotating: false, workers: 0, nightIdle: false, capOk: true };
eq('wakes when away and free', wakeDecision(base).wake, true);
eq('person active → no', wakeDecision({ ...base, away: false }).wake, false);
eq('limited → no (heartbeat does nothing)', wakeDecision({ ...base, limitedUntil: 2000 }).wake, false);
eq('limit passed → yes', wakeDecision({ ...base, limitedUntil: 500 }).wake, true);
eq('mid-turn → no', wakeDecision({ ...base, turnActive: true }).wake, false);
eq('rotating → no', wakeDecision({ ...base, rotating: true }).wake, false);
eq('workers running → no', wakeDecision({ ...base, workers: 1 }).wake, false);
eq('nothing left → no', wakeDecision({ ...base, nightIdle: true }).wake, false);
eq('cap used → no', wakeDecision({ ...base, capOk: false }).wake, false);

// ── cap math ──
const DAY = 86400000;
eq('flat cap, under', capMath({ now: 0, nextReset: 3 * DAY, maxUnits: 30, nightSpent: 10 }).ok, true);
eq('flat cap, reached', capMath({ now: 0, nextReset: 3 * DAY, maxUnits: 30, nightSpent: 30 }).ok, false);
const c1 = capMath({ budget: 400, usedThisWeek: 100, now: 0, nextReset: 3 * DAY, nightSpent: 0 });
eq('half of the rest over 3 days', c1.cap, 0.5 * 300 / 3);
eq('2.2 days left rounds up to 3', capMath({ budget: 400, usedThisWeek: 100, now: 0, nextReset: 2.2 * DAY }).cap, 50);
eq('last day takes at most half of what is left', capMath({ budget: 400, usedThisWeek: 300, now: 0, nextReset: 0.4 * DAY }).cap, 50);
eq('flat cap also limits a rich budget', capMath({ budget: 4000, usedThisWeek: 0, now: 0, nextReset: DAY, maxUnits: 30 }).cap, 30);
eq('overspent week → 0, not ok', capMath({ budget: 100, usedThisWeek: 150, now: 0, nextReset: DAY }).ok, false);
eq('night spend past share → stop', capMath({ budget: 400, usedThisWeek: 100, now: 0, nextReset: 3 * DAY, nightSpent: 50 }).ok, false);
const w = weekWindow(kl('2026-10-11T10:00:00'), { dow: 2, hour: 1, tz: 'Asia/Kuala_Lumpur' });
eq('week starts last Tue 1am', w.start, kl('2026-10-06T01:00:00'));
eq('week resets next Tue 1am', w.next, kl('2026-10-13T01:00:00'));
const w2 = weekWindow(kl('2026-10-13T00:30:00'), { dow: 2, hour: 1, tz: 'Asia/Kuala_Lumpur' });
eq('just before reset still old week', w2.next, kl('2026-10-13T01:00:00'));
eq('opus costs more than sonnet', usageUnits('claude-opus-5-5', { output_tokens: 1000 }) > usageUnits('claude-sonnet-5-5', { output_tokens: 1000 }), true);

// ── worker model enforcement ──
const hook = fenceHook('go', () => false);
const out = await hook({ tool_name: 'Agent', tool_input: { description: 'x', prompt: 'p' } });
eq('general-purpose gets sonnet', out.hookSpecificOutput?.updatedInput?.model, 'sonnet');
const keep = await hook({ tool_name: 'Agent', tool_input: { description: 'x', model: 'opus' } });
eq('an explicit model is kept', keep.hookSpecificOutput?.updatedInput, undefined);
const rd = await hook({ tool_name: 'Agent', tool_input: { description: 'x', subagent_type: 'reader' } });
eq('named crew member untouched', rd.hookSpecificOutput?.updatedInput, undefined);
const wk = await hook({ tool_name: 'Agent', tool_input: { description: 'x' }, agent_id: 'w1' });
eq("a worker's own sub-worker gets sonnet too", wk.hookSpecificOutput?.updatedInput?.model, 'sonnet');
const blocked = await fenceHook('go', () => true)({ tool_name: 'Agent', tool_input: { description: 'x' } });
eq('no new workers once the night share is used', blocked.hookSpecificOutput?.permissionDecision, 'deny');
eq('label for a model-less worker', defaultWorkerModel({ description: 'x' }), 'sonnet');

// ── rotation only when heavy AND idle ──
const heavy = { ctx: 170000, windowSize: 1000000, workers: 0, turnActive: false, rotating: false, hasConversation: true, unchecked: 0, sinceActivityMs: 5 * MIN };
eq('default threshold is 160000 tokens', rotateDecision({ ...heavy, ctx: 159000 }).rotate, false);
eq('heavy and idle rotates', rotateDecision(heavy).rotate, true);
eq('share alone rotates', rotateDecision({ ...heavy, ctx: 600000 }).rotate, true);
eq('worker running blocks', rotateDecision({ ...heavy, workers: 1 }).rotate, false);
eq('mid-turn blocks', rotateDecision({ ...heavy, turnActive: true }).rotate, false);
eq('pending verdict blocks', rotateDecision({ ...heavy, unchecked: 1 }).rotate, false);
eq('under 2 min since last activity blocks', rotateDecision({ ...heavy, sinceActivityMs: 119000 }).rotate, false);
eq('exactly 2 min is idle', rotateDecision({ ...heavy, sinceActivityMs: 120000 }).rotate, true);
eq('already rotating', rotateDecision({ ...heavy, rotating: true }).rotate, false);
eq('no conversation', rotateDecision({ ...heavy, hasConversation: false }).rotate, false);

// ── the morning question: not within 7 days of an answer, never twice in a day ──
const T = kl('2026-10-20T09:00:00');
eq('never asked or answered → ask', askDue({ now: T }), true);
eq('answered 3 days ago → no', askDue({ now: T, answeredAt: T - 3 * 86400000 }), false);
eq('answered 8 days ago → ask', askDue({ now: T, answeredAt: T - 8 * 86400000 }), true);
eq('asked earlier today → no', askDue({ now: T, answeredAt: 0, askedAt: kl('2026-10-20T01:00:00') }), false);
eq('asked yesterday, no answer → may ask', askDue({ now: T, answeredAt: 0, askedAt: kl('2026-10-19T09:00:00') }), true);
eq('day key in the given zone', dayKey(kl('2026-10-20T00:30:00'), 'Asia/Kuala_Lumpur'), '2026-10-20');

console.log(bad ? `FAILED (${bad}/${n})` : `night: all ${n} cases ok`);
process.exit(bad ? 1 : 0);
