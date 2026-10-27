// Pure-helper tests for tm.mjs (no network, no Keychain).
import { expiryFrom, needsRefresh, parseTokens, publicUser, friendlyError, findMarker, TmError, MIND_NAME, AGENT_ID, pickMind, pickMindWithLegacy, loadWithFallback } from './tm.mjs';
let bad = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { bad++; console.log(`MISMATCH ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`); } };

eq('expiry from string seconds', expiryFrom(1000, '3600'), 1000 + 3600000);
eq('expiry from number', expiryFrom(0, 60), 60000);
eq('expiry bad value defaults to 1h', expiryFrom(0, 'abc'), 3600000);
eq('expiry zero defaults to 1h', expiryFrom(0, 0), 3600000);
const exp = 10_000_000;
eq('fresh token: no refresh', needsRefresh(exp, exp - 6 * 60000), false);
eq('inside 5 min window: refresh', needsRefresh(exp, exp - 4 * 60000), true);
eq('exactly 5 min: refresh', needsRefresh(exp, exp - 5 * 60000), true);
eq('expired: refresh', needsRefresh(exp, exp + 1), true);
eq('never signed in: refresh', needsRefresh(0, 5), true);

eq('parse good login', parseTokens({ id_token: 'a', refresh_token: 'b', expires_in: '3600', user: { id: 'u', email: 'e@x.com', display_name: 'E' } }),
  { idToken: 'a', refreshToken: 'b', expiresIn: '3600', user: { id: 'u', email: 'e@x.com', display_name: 'E' } });
eq('parse refresh (no user)', parseTokens({ id_token: 'a', refresh_token: 'b', expires_in: 3600 })?.user, null);
eq('parse missing id_token', parseTokens({ refresh_token: 'b' }), null);
eq('parse null', parseTokens(null), null);
eq('parse missing refresh token', parseTokens({ id_token: 'a' })?.refreshToken, null);
eq('publicUser maps fields only', publicUser({ id: 'u', email: 'e', display_name: 'N', secret: 'x' }), { id: 'u', email: 'e', name: 'N' });
eq('publicUser null', publicUser(null), null);

eq('friendly keeps TmError text', friendlyError(new TmError('plain words')), 'plain words');
eq('friendly hides raw errors', /Can't reach TrueMemory/.test(friendlyError(new Error('ECONNREFUSED 1.2.3.4'))), true);
eq('marker found in nested excerpts', findMarker([{ filename: 'f', content: 'x una-proof-1 y' }], 'una-proof-1'), true);
eq('marker absent', findMarker([{ content: 'nope' }], 'una-proof-1'), false);
eq('marker on undefined', findMarker(undefined, 'm'), false);
eq('defaults', [MIND_NAME, AGENT_ID], ['una', 'sahar']);
eq('pickMind from a bare list, case-insensitive', pickMind([{ id: 'a', name: 'Other' }, { id: 'b', name: ' una ' }])?.id, 'b');
eq('pickMind from { minds }', pickMind({ minds: [{ id: 'c', name: 'una' }] })?.id, 'c');
eq('pickMind none', pickMind([{ id: 'a', name: 'Other' }]), null);
eq('pickMind garbage', pickMind(null), null);
eq('pickMind ignores entries without an id', pickMind([{ name: 'una' }]), null);

// keychain: una.truememory first, else migrate sahar.truememory
{
  const mk = (store) => async (cmd, args) => {
    const svc = args[args.indexOf('-s') + 1];
    if (args[0] === 'delete-generic-password') { const had = svc in store; delete store[svc]; return { code: had ? 0 : 44, out: '' }; }
    const e = store[svc];
    if (!e) return { code: 44, out: '' };
    return { code: 0, out: args.includes('-w') ? e.token + '\n' : `    "acct"<blob>="${e.email}"\n` };
  };
  const mkSave = (store) => async (email, token) => { store['una.truememory'] = { email, token }; };
  let st = { 'una.truememory': { email: 'a@x.com', token: 't-new' }, 'sahar.truememory': { email: 'old@x.com', token: 't-old' } };
  eq('keychain: current wins', await loadWithFallback(mk(st), mkSave(st)), { email: 'a@x.com', token: 't-new' });
  eq('keychain: current wins leaves legacy', 'sahar.truememory' in st, true);
  st = { 'sahar.truememory': { email: 'old@x.com', token: 't-old' } };
  eq('keychain: legacy returned', await loadWithFallback(mk(st), mkSave(st)), { email: 'old@x.com', token: 't-old' });
  eq('keychain: migrated to una', st['una.truememory'], { email: 'old@x.com', token: 't-old' });
  eq('keychain: legacy deleted', 'sahar.truememory' in st, false);
  st = {};
  eq('keychain: nothing', await loadWithFallback(mk(st), mkSave(st)), null);
  st = { 'sahar.truememory': { email: 'old@x.com', token: 't-old' } };
  const failSave = async () => { throw new Error('boom'); };
  eq('keychain: failed save keeps legacy', [(await loadWithFallback(mk(st), failSave))?.token, 'sahar.truememory' in st], ['t-old', true]);
}

eq('mind: una wins over legacy', pickMindWithLegacy([{ id: 'o', name: 'Sahar' }, { id: 'n', name: 'una' }])?.id, 'n');
eq('mind: legacy Sahar used when no una', pickMindWithLegacy([{ id: 'o', name: 'Sahar' }])?.id, 'o');
eq('mind: neither -> null (caller creates una)', pickMindWithLegacy([{ id: 'x', name: 'Other' }]), null);
console.log(bad ? `${bad} of ${n} FAILED` : `all ${n} tm tests pass`);
process.exit(bad ? 1 : 0);
