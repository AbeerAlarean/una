// Sahar's brain as tools on her main thread: an in-process SDK MCP server named "mind".
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as tm from './tm.mjs';
import { saveKnowledge } from './seed.mjs';
import { loadGlossary, saveGlossary, shapeMemory, queryWithScope, ShapeError } from './memshape.mjs';

export const MIND_TOOLS = ['mcp__mind__ask_mind', 'mcp__mind__remember', 'mcp__mind__save_knowledge'];

const NOT_CONNECTED = 'TrueMemory not connected — ask the person to Connect TrueMemory (the pill at the top of the window). Meanwhile use the local notes in mind/.';
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => ({ content: [{ type: 'text', text: err instanceof tm.TmError && /Not connected|expired|Connect/i.test(err.message) ? NOT_CONNECTED : tm.friendlyError(err) }], isError: true });

/** consult() result → compact text: ≤12 facts, ≤6 excerpts of ≤1500 chars. */
export function formatConsult(c, { maxFacts = 12, maxExcerpts = 6, maxChars = 1500 } = {}) {
  const fact = (m) => (typeof m === 'string' ? m : m?.fact || m?.content || m?.text || m?.memory || JSON.stringify(m));
  const facts = (c?.memories || []).slice(0, maxFacts).map((m) => `- ${String(fact(m)).trim()}`);
  const ex = (c?.excerpts || []).slice(0, maxExcerpts).map((e) => `[${e.filename || 'note'}]\n${String(e.content || '').slice(0, maxChars).trim()}`);
  if (!facts.length && !ex.length) return 'Nothing in the mind matched that.';
  return [facts.length ? `FACTS\n${facts.join('\n')}` : '', ex.length ? `EXCERPTS\n${ex.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
}

export const mindServer = createSdkMcpServer({
  name: 'mind',
  version: '1.0.0',
  tools: [
    tool('ask_mind', "Ask your mind (the person's TrueMemory): decisions with reasons, project notes, history, lessons. Call before answering or briefing on any task. Returns facts and note excerpts. Pass project (and feature) when the question is about one, so the answer is anchored to it.", { query: z.string().min(2), project: z.string().optional(), feature: z.string().optional() }, async ({ query, project, feature }) => {
      try { return text(formatConsult(await tm.consult(queryWithScope(query, { project, feature }, loadGlossary())))); } catch (err) { return fail(err); }
    }),
    tool('remember', "Write one decision, rule, correction, fact or task outcome into your memory, always in the one shape: project, feature, what (ONE short plain sentence, about 25 words, a non-technical reader understands), why (one short sentence, optional), when (optional date, default now). Every memory is anchored to a path in the project map (mind/project-map.json): it is stored as \"Project · Parent › Feature: what. Why: why. (Month Year)\" and the path is filled in for you. Use the map's names (aliases are resolved). A feature the map does not have yet is rejected unless you also pass parent (an existing feature of that project, or null for a top-level one) and what_is (one plain line: what the feature is for a user); then it is added to the map in its place. Plain product words only: no PR numbers, branch names, file paths, commit hashes, tickets, or words like worktree, executor, handoff.", { project: z.string().min(2), feature: z.string().min(2), what: z.string().min(8), why: z.string().optional(), when: z.string().optional(), parent: z.string().nullable().optional(), what_is: z.string().optional() }, async (input) => {
      try {
        const g = loadGlossary();
        const r = shapeMemory(input, g);
        await tm.addMemory(r.text);
        if (r.newFeature) saveGlossary(shapeMemory(input, loadGlossary()).glossary); // re-read so a parallel remember() is not overwritten
        return text(r.newFeature ? `Remembered under ${r.project} · ${r.path} (new feature, added to the project map).` : `Remembered under ${r.project} · ${r.path}.`);
      } catch (err) {
        if (err instanceof ShapeError) return { content: [{ type: 'text', text: err.message }], isError: true };
        return fail(err);
      }
    }),
    tool('save_knowledge', 'Save or replace a project note or document in your mind as markdown. Same filename replaces the earlier one.', { filename: z.string().min(3), markdown: z.string().min(1) }, async ({ filename, markdown }) => {
      try { const r = await saveKnowledge(filename, markdown); return text(`Saved ${r.name} (${r.status}).`); } catch (err) { return fail(err); }
    }),
  ],
});
