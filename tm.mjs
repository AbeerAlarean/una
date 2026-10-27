// TrueMemory client for una (https://truememory.com): signs in AS THE USER (their own ID token as Bearer, no app token).
// Only the refresh token is persisted, in the macOS Keychain; the 1h ID token lives in memory.
import { spawn } from 'node:child_process';

const AUTH_URL = (process.env.TM_AUTH_URL || 'https://auth.truememory.com').replace(/\/+$/, '');
const API_URL = (process.env.TM_API_URL || 'https://api.truememory.com').replace(/\/+$/, '');
// The mind una files knowledge in: TM_MIND_ID if set, else the person's own mind named "una"
// (found by name, created on first use). Nothing is hardcoded to one account.
export const MIND_NAME = 'una';
// Memory space id kept for continuity; not user-visible. Changing it would orphan existing users' memories.
export const AGENT_ID = process.env.TM_AGENT_ID || 'sahar';
export const BRAIN_NAME = 'una notes';
export const LEGACY_MIND_NAME = 'Sahar'; // existing users' mind and brain keep their old names; used as-is, never renamed
export const LEGACY_BRAIN_NAME = 'Sahar notes';
const KEYCHAIN_SERVICE = 'una.truememory';
const LEGACY_KEYCHAIN_SERVICE = 'sahar.truememory'; // pre-rename name; read once, migrated, then deleted
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ── pure helpers (tested without network) ──
export function expiryFrom(now, expiresIn) {
  const s = Number(expiresIn);
  return now + (Number.isFinite(s) && s > 0 ? s : 3600) * 1000;
}
export function needsRefresh(expiresAt, now, skewMs = REFRESH_SKEW_MS) {
  return !expiresAt || now >= expiresAt - skewMs;
}
export function parseTokens(json) {
  if (!json || typeof json.id_token !== 'string' || !json.id_token) return null;
  return {
    idToken: json.id_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresIn: json.expires_in,
    user: json.user && typeof json.user === 'object' ? json.user : null,
  };
}
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id || null, email: u.email || null, name: u.display_name || null };
}
export function friendlyError(err) {
  if (err instanceof TmError) return err.message;
  return "Can't reach TrueMemory right now. Check the connection and try again.";
}
export function findMarker(haystack, marker) {
  return JSON.stringify(haystack ?? '').includes(marker);
}
/** The person's mind called `name` out of a /minds listing (a bare array or { minds: [...] }), or null. */
export function pickMind(list, name = MIND_NAME) {
  const arr = Array.isArray(list) ? list : Array.isArray(list?.minds) ? list.minds : [];
  const want = String(name).trim().toLowerCase();
  return arr.find((m) => m && m.id && String(m.name || '').trim().toLowerCase() === want) || null;
}

export class TmError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'TmError'; this.status = status; }
}

// ── keychain (args array only; the token never reaches a log) ──
function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve({ code: 1, out: '' }); return; }
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ code: 1, out: '' }));
    p.on('close', (code) => resolve({ code, out }));
  });
}
export async function saveRefreshToken(email, token) {
  const r = await run('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', email, '-w', token]);
  if (r.code !== 0) throw new TmError('Could not save the sign-in to the macOS Keychain.');
}
/** Read one Keychain service via an injected runner ({code,out}); null when absent. */
export async function readKeychain(runner, service) {
  const attrs = await runner('security', ['find-generic-password', '-s', service]);
  if (attrs.code !== 0) return null;
  const m = attrs.out.match(/"acct"<blob>="([^"]*)"/);
  const pw = await runner('security', ['find-generic-password', '-s', service, '-w']);
  if (pw.code !== 0 || !pw.out.trim()) return null;
  return { email: m ? m[1] : null, token: pw.out.trim() };
}
/** Current service first; if missing, fall back to the legacy one and migrate it (write new, delete old). */
export async function loadWithFallback(runner, save, current = KEYCHAIN_SERVICE, legacy = LEGACY_KEYCHAIN_SERVICE) {
  const now = await readKeychain(runner, current);
  if (now) return now;
  const old = await readKeychain(runner, legacy);
  if (!old) return null;
  if (old.email) {
    try {
      await save(old.email, old.token);
      await runner('security', ['delete-generic-password', '-s', legacy]);
    } catch { /* keep the legacy entry so the user stays connected */ }
  }
  return old;
}
export async function loadRefreshToken() {
  return loadWithFallback(run, saveRefreshToken);
}
export async function clearRefreshToken() {
  await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE]);
  await run('security', ['delete-generic-password', '-s', LEGACY_KEYCHAIN_SERVICE]);
}

// ── session (in memory) ──
const session = { idToken: null, expiresAt: 0, refreshToken: null, email: null, user: null, mindName: null, mindId: process.env.TM_MIND_ID || null };

async function http(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 30000) });
  } catch {
    throw new TmError("Can't reach TrueMemory right now. Check the connection and try again.");
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json };
}

function adopt(tokens) {
  session.idToken = tokens.idToken;
  session.expiresAt = expiryFrom(Date.now(), tokens.expiresIn);
  if (tokens.refreshToken) session.refreshToken = tokens.refreshToken;
}

/** Google-only accounts have no password: TrueMemory's own reset email lets the person add one (their Google sign-in keeps working). */
export async function sendSetPasswordEmail(email) {
  const r = await http(`${AUTH_URL}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new TmError("TrueMemory couldn't send the email just now. Try again in a moment.", r.status);
  return true;
}

export async function login(email, password) {
  const r = await http(`${AUTH_URL}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (r.status === 401 || r.status === 400 || r.status === 422) {
    throw new TmError("That email and password were not accepted. If this account only ever signed in with Google, use \"Signed up with Google? Set a password\" below, then try again.", r.status);
  }
  if (r.status === 403) throw new TmError('This TrueMemory account is disabled.', 403);
  const t = r.ok ? parseTokens(r.json) : null;
  if (!t || !t.refreshToken) throw new TmError('TrueMemory sign-in failed. Try again in a moment.', r.status);
  adopt(t);
  session.email = email;
  session.user = publicUser(t.user);
  return t;
}

export async function refresh(refreshToken = session.refreshToken) {
  if (!refreshToken) throw new TmError('Not connected to TrueMemory.');
  const r = await http(`${AUTH_URL}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (r.status === 401) { session.idToken = null; session.refreshToken = null; throw new TmError('The TrueMemory sign-in expired. Connect again.', 401); }
  const t = r.ok ? parseTokens(r.json) : null;
  if (!t) throw new TmError('Could not renew the TrueMemory sign-in.', r.status);
  adopt({ ...t, refreshToken: t.refreshToken || refreshToken });
  return t;
}

// Restores the session from the Keychain if needed; returns true when a usable refresh token exists.
async function ensureSession() {
  if (!session.refreshToken) {
    const saved = await loadRefreshToken();
    if (!saved) return false;
    session.refreshToken = saved.token;
    session.email = session.email || saved.email;
  }
  if (needsRefresh(session.expiresAt, Date.now())) {
    const t = await refresh();
    if (t.refreshToken && t.refreshToken !== session.refreshToken && session.email) await saveRefreshToken(session.email, t.refreshToken).catch(() => {});
  }
  return true;
}

export async function connect(email, password) {
  const t = await login(email, password);
  await saveRefreshToken(email, t.refreshToken);
  return { user: session.user || { id: null, email, name: null } };
}

export async function disconnect() {
  await clearRefreshToken();
  Object.assign(session, { idToken: null, expiresAt: 0, refreshToken: null, email: null, user: null, mindName: null, mindId: process.env.TM_MIND_ID || null });
}

/** True when a saved sign-in exists in the Keychain (no network). */
export async function hasLogin() {
  return !!(await loadRefreshToken());
}

// Authenticated call with the user's own ID token; one refresh-and-retry on 401.
export async function api(pathname, { method = 'GET', body, form, timeoutMs, base = API_URL } = {}) {
  if (!(await ensureSession())) throw new TmError('Not connected to TrueMemory. Click Connect TrueMemory first.');
  const go = () => http(`${base}${pathname}`, {
    method,
    timeoutMs,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.idToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let r = await go();
  if (r.status === 401) { await refresh(); r = await go(); }
  if (!r.ok) {
    const msg = r.json?.message || r.json?.error?.message || r.json?.detail;
    throw new TmError(`TrueMemory said no (${r.status}${typeof msg === 'string' ? `: ${msg.slice(0, 160)}` : ''}).`, r.status);
  }
  return r.json;
}

// Who is signed in (the auth service owns /auth/me).
async function me() {
  if (session.user?.id) return session.user;
  try {
    const u = publicUser(await api('/auth/me', { base: AUTH_URL, timeoutMs: 10000 }));
    if (u) session.user = { ...session.user, ...u };
  } catch {}
  return session.user;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The mind named "una", else an existing legacy one (used as-is), else null. */
export function pickMindWithLegacy(list) {
  return pickMind(list) || pickMind(list, LEGACY_MIND_NAME);
}

/** The id of una's mind: TM_MIND_ID, else the person's mind named "una" (created when `create` and missing). */
export async function resolveMind({ create = true } = {}) {
  if (session.mindId) return session.mindId;
  const found = pickMindWithLegacy(await api('/minds?limit=200'));
  if (found) { session.mindId = found.id; session.mindName = found.name; return found.id; }
  if (!create) return null;
  const made = await api('/minds', { method: 'POST', body: { name: MIND_NAME } });
  const id = made?.id || made?.mind?.id;
  if (!id) throw new TmError('TrueMemory did not return an id for the new mind.');
  session.mindId = id;
  session.mindName = made?.name || made?.mind?.name || MIND_NAME;
  return id;
}

export async function ensureBrain() {
  const user = await me();
  const list = await api('/brains?limit=200');
  const mine = (list?.brains || []).filter((b) => (b.name === BRAIN_NAME || b.name === LEGACY_BRAIN_NAME) && (!user?.id || !b.user_id || b.user_id === user.id));
  let brain = mine[0];
  let created = false;
  if (!brain) {
    brain = await api('/brains', { method: 'POST', body: { name: BRAIN_NAME, description: "Notes and briefs una keeps for her person." } });
    created = true;
  }
  const mid = await resolveMind();
  const inMind = await api(`/minds/${encodeURIComponent(mid)}/brains`);
  const already = Array.isArray(inMind) && inMind.some((b) => b.id === brain.id);
  if (!already) await api(`/minds/${encodeURIComponent(mid)}/brains/${encodeURIComponent(brain.id)}`, { method: 'PUT' });
  return { brainId: brain.id, created, addedToMind: !already };
}

export async function addMemory(text) {
  const res = await api('/memories/graph', {
    method: 'POST', timeoutMs: 120000,
    body: { data: text, type: 'document', agent_id: AGENT_ID, wait: true, source_description: 'una' },
  });
  if (res?.status === 'completed') return { status: 'completed' };
  if (res?.job_id) {
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const st = await api(`/memories/graph/status/${encodeURIComponent(res.job_id)}`);
      if (st?.done) {
        if (!st.succeeded) throw new TmError('TrueMemory took the memory but failed to process it.');
        return { status: 'completed', jobId: res.job_id };
      }
    }
    throw new TmError('The memory is still processing after 90 seconds.');
  }
  return { status: res?.status || 'unknown' };
}

export async function searchMemories(query, maxResults = 10) {
  const res = await api('/memories/search', { method: 'POST', body: { query, agent_id: AGENT_ID, max_results: maxResults } });
  return Array.isArray(res) ? res : [];
}

export async function uploadNote(filename, markdown, { brainId } = {}) {
  const bid = brainId || (await ensureBrain()).brainId;
  const form = new FormData();
  form.append('file', new Blob([markdown], { type: 'text/markdown' }), filename);
  const pack = await api('/knowledge-packs', { method: 'POST', form, timeoutMs: 60000 });
  if (!pack?.id) throw new TmError('TrueMemory did not return an id for the upload.');
  await api(`/brains/${encodeURIComponent(bid)}/knowledge-packs`, { method: 'POST', body: { pack_id: pack.id } });
  let status = pack.status;
  const deadline = Date.now() + 120000;
  while (status !== 'ready' && status !== 'error' && Date.now() < deadline) {
    await sleep(3000);
    const list = await api('/knowledge-packs?limit=200');
    status = (list?.packs || []).find((p) => p.id === pack.id)?.status || status;
  }
  if (status === 'error') throw new TmError('TrueMemory could not read the uploaded note.');
  if (status !== 'ready') throw new TmError('The upload is still being indexed after 2 minutes.');
  return { packId: pack.id, brainId: bid, status };
}

export async function deletePack(packId) {
  try { await api(`/knowledge-packs/${encodeURIComponent(packId)}`, { method: 'DELETE', timeoutMs: 30000 }); return true; }
  catch (err) { if (err instanceof TmError && err.status === 404) return false; throw err; }
}

// Bulk route (maintenance lane): ≤50 episodes and ≤700KB serialized per call; always async, so poll the job.
export async function addMemoriesBulk(texts, { sourceDescription = 'una decisions' } = {}) {
  if (!texts.length) return { episodes: 0 };
  const res = await api('/memories/graph/bulk', {
    method: 'POST', timeoutMs: 60000,
    body: { agent_id: AGENT_ID, mode: 'append', episodes: texts.map((data) => ({ data, type: 'document', source_description: sourceDescription })) },
  });
  if (!res?.job_id) throw new TmError('TrueMemory did not return a job for the bulk memory write.');
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    const st = await api(`/memories/graph/status/${encodeURIComponent(res.job_id)}`);
    if (st?.done) {
      if (!st.succeeded) throw new TmError('TrueMemory took the batch but failed to process it.');
      return { episodes: texts.length, jobId: res.job_id };
    }
  }
  throw new TmError('The memory batch is still processing after 15 minutes.');
}

export async function consult(query) {
  const mid = await resolveMind();
  return api(`/minds/${encodeURIComponent(mid)}/consult`, { method: 'POST', body: { query, agent_id: AGENT_ID } });
}

export async function status() {
  let connected = false;
  try { connected = await ensureSession(); } catch { connected = false; }
  if (!connected) return { connected: false };
  const user = await me();
  // Looking only: a status poll never creates the mind (the first proof or upload does).
  if (!session.mindName) {
    try {
      const id = await resolveMind({ create: false });
      if (id && !session.mindName) session.mindName = (await api(`/minds/${encodeURIComponent(id)}`, { timeoutMs: 10000 }))?.name || null;
    } catch {}
  }
  return { connected: true, user: user ? { email: user.email || session.email, name: user.name } : { email: session.email, name: null }, mind: session.mindName || `${MIND_NAME} (created on first use)`, mindId: session.mindId, agentId: AGENT_ID };
}

// Phase 0 proof: write one memory, upload one note into the una brain, read both back.
export async function runProof(now = new Date()) {
  const iso = now.toISOString();
  const stamp = iso.replace(/[:.]/g, '-');
  const marker = `una-proof-${stamp}`;
  const steps = [];
  const step = async (name, fn) => {
    try { const d = await fn(); steps.push({ step: name, ok: true, ...d }); return d; }
    catch (err) { steps.push({ step: name, ok: false, error: friendlyError(err) }); return null; }
  };
  const fact = "The person decided una's brain lives in their TrueMemory: craft in the repo, their world in TrueMemory, live state local.";

  await step('memory', async () => ({ ...(await addMemory(`Una proof ${iso}: ${fact}`)), agent: AGENT_ID }));
  const brain = await step('brain', ensureBrain);
  await step('upload', async () => {
    const md = `# Una proof note\n\n${marker}\n\nWhere does una's brain live? In the person's TrueMemory: craft stays in the repo, their world lives in TrueMemory, live state stays local.\n`;
    return uploadNote(`${marker}.md`, md, { brainId: brain?.brainId });
  });
  const q = `Where does una's brain live? ${marker}`;
  let c = null;
  await step('consult', async () => {
    for (let i = 0; i < 4; i++) {
      c = await consult(q);
      if (findMarker(c?.excerpts, marker)) break;
      await sleep(5000);
    }
    return { excerpts: (c?.excerpts || []).length, markerInExcerpts: findMarker(c?.excerpts, marker), memories: (c?.memories || []).length, sample: (c?.excerpts || []).slice(0, 2).map((e) => ({ filename: e.filename, content: String(e.content).slice(0, 200) })) };
  });
  await step('search', async () => {
    const hits = await searchMemories(`Where does una's brain live? TrueMemory`);
    const hit = findMarker(hits, 'lives in their TrueMemory');
    return { results: hits.length, factFound: hit, sample: hits.slice(0, 2).map((h) => String(h.fact || h.content || JSON.stringify(h)).slice(0, 200)) };
  });
  return { marker, passed: steps.every((s) => s.ok), steps };
}
