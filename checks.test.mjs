// Pure-helper tests for checks.mjs.
import { slugOf, taskOfWorker, isChecked, uncheckedTasks, overlayVerify, uncheckedNote, VERIFY_LINE, matchCard, sameCard, cardWords } from './checks.mjs';
let bad = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { bad++; console.log(`MISMATCH ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`); } };

eq('slug basic', slugOf('Search page'), 'search-page');
eq('slug punctuation', slugOf("Remind the team about the open items"), 'remind-the-team-about-the-open-items');
eq('slug trims', slugOf('  --Checkout PR!! '), 'checkout-pr');
eq('slug empty', slugOf(''), '');
eq('slug caps length', slugOf('a'.repeat(100)).length, 60);
eq('worker tag', taskOfWorker('[Search page] fix the band'), 'Search page');
eq('worker no tag', taskOfWorker('fix the band'), null);

eq('no worker record = nothing to check', isChecked({}, 'checkout', null), true);
eq('worker done, no file', isChecked({ checkout: 100 }, 'checkout', null), false);
eq('file older than worker', isChecked({ checkout: 100 }, 'checkout', 50), false);
eq('file same instant is not enough', isChecked({ checkout: 100 }, 'checkout', 100), false);
eq('file newer', isChecked({ checkout: 100 }, 'checkout', 101), true);

const tasks = [
  { name: 'Checkout', stage: 'ready' }, { name: 'Search', stage: 'build' }, { name: 'PR one', stage: 'pr' },
  { name: 'Safe one', stage: 'safe' }, { name: 'Old', stage: 'merged' }, { name: 'Fresh', stage: 'test' },
];
const state = { checkout: 100, 'search': 100, 'pr-one': 100, 'safe-one': 100, old: 100 };
const mt = (slug) => ({ 'safe-one': 200 }[slug] ?? null);
eq('unchecked picks checked-stage tasks only', uncheckedTasks(tasks, state, mt).map((t) => t.name), ['Checkout', 'PR one', 'Old']);
eq('non-array tolerated', uncheckedTasks(null, state, mt), []);
eq('overlay unchecked', overlayVerify({ name: 'a', stage: 'pr', now: 'x' }, true), { name: 'a', stage: 'verify', now: VERIFY_LINE });
eq('overlay checked untouched', overlayVerify({ name: 'a', stage: 'pr', now: 'x' }, false), { name: 'a', stage: 'pr', now: 'x' });
eq('note empty', uncheckedNote([]), '');
eq('note lists titles', /Checkout, PR one/.test(uncheckedNote([{ name: 'm', title: 'Checkout' }, { name: 'PR one' }])), true);
eq('note tag', uncheckedNote([{ name: 'a' }]).startsWith('<unchecked>'), true);

// ── a worker's tag finds its existing card ──
const cards = [{ name: 'Search page', title: 'Finishing the search page' }, { name: 'Checkout PR', title: 'Moving checkout to the new provider' }, { name: 'Offer page', title: 'Offer page proof pass' }];
eq('words drop filler and punctuation', cardWords('The Search-page, PR!'), ['search', 'page']);
eq('exact', matchCard(cards, 'Search page')?.name, 'Search page');
eq('case + punctuation', matchCard(cards, 'search  PAGE!')?.name, 'Search page');
eq('the is ignored', matchCard(cards, 'the Search page')?.name, 'Search page');
eq('plural', matchCard(cards, 'Search pages')?.name, 'Search page');
eq('matches the title too', matchCard(cards, 'Finishing the search page')?.name, 'Search page');
eq('prefix at 70%+', sameCard('Offer page proof', 'Offer page proof pass'), true);
eq('too short a prefix is a different task', sameCard('Offer', 'Offer page proof pass'), false);
eq('different task', matchCard(cards, 'Offer reveal'), null);
eq('reordered words ≥70%', sameCard('page search', 'Search page'), true);
eq('one shared word of three is not a match', sameCard('Search page fix now', 'Search cards'), false);
eq('no cards', matchCard([], 'x'), null);

console.log(bad ? `FAILED (${bad})` : `checks: all ${n} cases ok`);
process.exit(bad ? 1 : 0);
