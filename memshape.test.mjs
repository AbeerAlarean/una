// Tests for the one memory shape and the project map (memshape.mjs) and the retired decisions sync (seed.mjs). No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPlain, composeMemory, monthYear, resolveProject, resolveFeature, featurePath, shapeMemory, queryWithScope, ShapeError, loadGlossary, saveGlossary, mapToGlossary, glossaryToMap } from './memshape.mjs';
import { buildPlan, planMarkdown } from './seed.mjs';

const G = {
  projects: {
    Storefront: { aliases: ['webshop', 'webshops', 'buying funnel', 'launch round'], features: {
      'Page builder': { description: 'Turns a finished page into a webinar page.', aliases: ['Funnel Builder', 'page drop'], parent: null },
      Tracking: { description: 'What forms report to the data team.', aliases: ['Lead tracking', 'Segment'], parent: null },
      Purchases: { description: 'Who bought the offer.', aliases: ['purchase signal'], parent: 'Tracking' },
      'Bought step': { description: 'Purchase on the timeline.', aliases: [], parent: 'Purchases' },
    } },
    Dashboard: { aliases: ['dashboard app'], features: { 'Today v2': { description: 'The Today screen.', aliases: ['Today'], parent: null } } },
  },
};

// ── names ──
assert.equal(resolveProject(G, 'Storefront'), 'Storefront');
assert.equal(resolveProject(G, 'webshop'), 'Storefront');
assert.equal(resolveProject(G, 'Web Shop'), 'Storefront');
assert.equal(resolveProject(G, 'the webshop funnel'), 'Storefront'); // long alias inside the text
assert.equal(resolveProject(G, 'launch round'), 'Storefront');
assert.equal(resolveProject(G, 'Dashboard'), 'Dashboard');
assert.equal(resolveProject(G, 'nothing here'), null);
assert.equal(resolveFeature(G, 'Storefront', 'funnel builder'), 'Page builder');
assert.equal(resolveFeature(G, 'Storefront', 'LEAD TRACKING'), 'Tracking');
assert.equal(resolveFeature(G, 'Storefront', 'Mystery'), null);
assert.equal(resolveFeature(G, 'Nope', 'Tracking'), null);

// ── plain words: rejected ──
const bad = {
  'draft PR #208 is up': /#208/,
  'merged PR 208 today': /PR number/,
  'tracked in SHOP-83': /ticket/,
  'built on feat/page-chat-rework': /branch/,
  'fixed on fix/watch-embed-full-width': /branch/,
  'chore/migrate-funnel-skill holds it': /branch/,
  'see studio-executor-handoff.md': /file name/,
  'edited apps/web/src/app/page.tsx': /file/,
  'it lives in ~/notes/mind': /file path/,
  'commit 9db6616e landed': /commit hash/,
  'in the worktree for the funnel': /engineering word/,
  'an executor builds it': /engineering word/,
  'the handoff plan': /engineering word/,
  'a database migration catch-up': /engineering word/,
};
for (const [t, re] of Object.entries(bad)) {
  const r = checkPlain(t);
  assert.equal(r.ok, false, `should reject: ${t}`);
  assert.match(r.problems.join(' | '), re, t);
}
// ── plain words: accepted ──
for (const t of [
  'The Spring Sale page now has a Monthly and Yearly toggle',
  'Pages at example.com/membership/springsale keep their order card',
  'We use Next.js and Node.js for the app',
  'The count went from 22 to 8 minutes, about 3 of 4 pages',
  'Prices of $99, $79 and $59 by tier; ratio 24/7 support',
  'Rebuild a page from its URL; link and/or button text',
  'deadbeef is not a hash because it has no digit',
]) assert.equal(checkPlain(t).ok, true, `should accept: ${t}`);

// ── dates and composing ──
const NOW = new Date(Date.UTC(2026, 9, 20, 12));
assert.equal(monthYear('2026-10-19', NOW), 'October 2026');
assert.equal(monthYear('2026-09', NOW), 'September 2026');
assert.equal(monthYear('Sep 2026', NOW), 'September 2026');
assert.equal(monthYear(undefined, NOW), 'October 2026');
assert.throws(() => monthYear('last tuesday', NOW), ShapeError);
assert.equal(composeMemory({ project: 'Storefront', feature: 'Purchases', path: 'Tracking › Purchases', what: 'A buyer shows up.', when: '2026-10-19' }, NOW), 'Storefront · Tracking › Purchases: A buyer shows up. (October 2026)');
assert.equal(
  composeMemory({ project: 'Storefront', feature: 'Tracking', what: 'The watch page sends two events.', why: 'the frame sends the rest', when: '2026-10-19' }, NOW),
  'Storefront · Tracking: The watch page sends two events. Why: the frame sends the rest. (October 2026)',
);
assert.equal(composeMemory({ project: 'A', feature: 'B', what: 'only what', when: '2026-01-05' }, NOW), 'A · B: only what. (January 2026)');

// ── shapeMemory: resolution, flags, errors ──
const ok = shapeMemory({ project: 'webshop', feature: 'Funnel Builder', what: 'Dropped pages build in one step with live progress', why: 'people got lost in a separate reading step', when: '2026-10-09' }, G, NOW);
assert.equal(ok.project, 'Storefront');
assert.equal(ok.feature, 'Page builder');
assert.equal(ok.newFeature, false);
assert.equal(ok.text, 'Storefront · Page builder: Dropped pages build in one step with live progress. Why: people got lost in a separate reading step. (October 2026)');

// the path comes from the map, at any depth
assert.equal(featurePath(G, 'Storefront', 'Purchases'), 'Tracking › Purchases');
assert.equal(featurePath(G, 'Storefront', 'Bought step'), 'Tracking › Purchases › Bought step');
assert.equal(featurePath(G, 'Storefront', 'Tracking'), 'Tracking');
const nested = shapeMemory({ project: 'Storefront', feature: 'purchase signal', what: 'A buyer shows on the timeline', why: 'we see purchases', when: '2026-10-14' }, G, NOW);
assert.equal(nested.feature, 'Purchases');
assert.equal(nested.path, 'Tracking › Purchases');
assert.equal(nested.text, 'Storefront · Tracking › Purchases: A buyer shows on the timeline. Why: we see purchases. (October 2026)');
assert.equal(shapeMemory({ project: 'Storefront', feature: 'Tracking', what: 'Two events are sent' }, G, NOW).text, 'Storefront · Tracking: Two events are sent. (October 2026)');

// an unknown feature needs parent (or null) and a one-line what_is
const before = JSON.stringify(G);
const offer = { project: 'Storefront', feature: 'Offer reveal', what: 'The offer appears at one planned time per webinar' };
assert.throws(() => shapeMemory(offer, G, NOW), (e) => e instanceof ShapeError && /not in the project map/.test(e.message) && /parent/.test(e.message) && /what_is/.test(e.message));
assert.throws(() => shapeMemory({ ...offer, parent: null }, G, NOW), /what_is/);
assert.throws(() => shapeMemory({ ...offer, parent: null, what_is: 'short' }, G, NOW), /what_is/);
assert.throws(() => shapeMemory({ ...offer, parent: null, what_is: 'x'.repeat(200) }, G, NOW), /too long/);
assert.throws(() => shapeMemory({ ...offer, parent: 'Nowhere', what_is: 'When the offer appears in a webinar' }, G, NOW), /parent "Nowhere" is not in the project map/);
assert.throws(() => shapeMemory({ ...offer, parent: null, what_is: 'Built in apps/web/src/page.tsx' }, G, NOW), /what_is contains/);
const top = shapeMemory({ ...offer, parent: null, what_is: 'When the offer appears during a webinar' }, G, NOW);
assert.equal(top.newFeature, true);
assert.equal(top.path, 'Offer reveal');
assert.deepEqual(top.glossary.projects.Storefront.features['Offer reveal'], { description: 'When the offer appears during a webinar', aliases: [], parent: null, status: 'active' });
const child = shapeMemory({ ...offer, feature: 'Reveal timing', parent: 'purchase signal', what_is: 'The planned time for the reveal' }, G, NOW);
assert.equal(child.path, 'Tracking › Purchases › Reveal timing', 'parent resolves through aliases');
assert.equal(child.glossary.projects.Storefront.features['Reveal timing'].parent, 'Purchases');
assert.equal(JSON.stringify(G), before, 'the input map is not mutated');
assert.equal(shapeMemory(offer, top.glossary, NOW).newFeature, false, 'once added, no extra params are needed');
assert.equal(shapeMemory({ ...offer, parent: 'Tracking', what_is: 'ignored for a known feature' }, top.glossary, NOW).path, 'Offer reveal', 'params are ignored when the feature is known');

// map file <-> keyed form, and the generated glossary
const mapFileShape = glossaryToMap(G);
assert.ok(Array.isArray(mapFileShape.projects) && mapFileShape.projects[0].features.find((f) => f.name === 'Purchases').parent === 'Tracking');
assert.deepEqual(mapToGlossary(mapFileShape).projects.Storefront.features.Purchases, { description: 'Who bought the offer.', aliases: ['purchase signal'], parent: 'Tracking', status: 'active' });
const hubTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projmap-'));
fs.mkdirSync(path.join(hubTmp, 'mind'));
assert.deepEqual(loadGlossary(hubTmp), { projects: {} }, 'empty hub');
saveGlossary(top.glossary, hubTmp);
assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(hubTmp, 'mind', 'project-map.json'), 'utf8')).projects), 'the map file is the array shape');
assert.ok(JSON.parse(fs.readFileSync(path.join(hubTmp, 'mind', 'glossary.json'), 'utf8')).projects.Storefront.features['Offer reveal'], 'glossary.json is generated');
assert.equal(loadGlossary(hubTmp).projects.Storefront.features['Offer reveal'].parent, null);
fs.rmSync(path.join(hubTmp, 'mind', 'project-map.json'));
assert.ok(loadGlossary(hubTmp).projects.Storefront, 'falls back to the older glossary file when there is no map');
fs.rmSync(hubTmp, { recursive: true, force: true });

assert.throws(() => shapeMemory({ project: 'Mystery', feature: 'x', what: 'Something plain happened here' }, G), /Unknown project "Mystery".*Storefront, Dashboard/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: '', what: 'Something plain happened here' }, G), /"feature" is required/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'Today', what: 'short' }, G), /"what"/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'Today', what: 'x'.repeat(600) }, G), /too long/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'Today', what: 'Today shows four meetings', why: 'x'.repeat(200) }, G), /"why" is too long/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'Today', what: 'Shipped as PR #400 on the main branch' }, G), (e) => e instanceof ShapeError && /#400/.test(e.message) && /plain product words/.test(e.message));
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'Today', what: 'Today shows four meetings', why: 'the executor said so' }, G), /why contains/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'fix/today-page', what: 'Today shows four meetings' }, G), /feature contains/);
assert.throws(() => shapeMemory({ project: 'Dashboard', feature: 'a/b', what: 'Today shows four meetings', parent: null, what_is: 'A made up feature name' }, G), /not a usable feature name/);

// ── ask_mind prefix ──
assert.equal(queryWithScope('what did we decide?', { project: 'dashboard app', feature: 'Today' }, G), 'Dashboard · Today v2: what did we decide?');
assert.equal(queryWithScope('who bought?', { project: 'webshops', feature: 'purchase signal' }, G), 'Storefront · Tracking › Purchases: who bought?');
assert.equal(queryWithScope('what did we decide?', { project: 'dashboard app' }, G), 'Dashboard: what did we decide?');
assert.equal(queryWithScope('what?', { project: 'Unknown', feature: 'Thing' }, G), 'Unknown · Thing: what?');
assert.equal(queryWithScope('plain question', {}, G), 'plain question');

// ── the map that ships in the hub template starts empty ──
const shipped = JSON.parse(fs.readFileSync(new URL('./hub-template/mind/project-map.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(shipped.projects) && shipped.projects.length === 0, 'the template project map has no projects');
assert.deepEqual(mapToGlossary(shipped), { projects: {} });

const dmd = '# Decisions\n\n## 2026-10-01 A single entry\nbody\n\n## Section\n- 2026-10-02 first bullet\n  more\n- 2026-10-03 second bullet\n';

// ── seed no longer syncs decisions as memory ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memshape-'));
fs.mkdirSync(path.join(tmp, 'mind', 'repos'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'mind', 'decisions.md'), dmd);
const plan = buildPlan(tmp);
assert.equal(plan.decisions.total, 2);
assert.equal(plan.decisions.fresh, 0);
assert.equal(plan.decisions.episodes, 0);
assert.deepEqual(plan._fresh, []);
assert.match(planMarkdown(plan), /no longer sent as raw memory/);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('memshape: all ok');
