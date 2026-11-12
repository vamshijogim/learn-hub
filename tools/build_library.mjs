// Builds the SOP library on a schedule. Reads library/topics.json, writes library/sop/*.json and library/index.json.
import fs from 'node:fs';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.log('GEMINI_API_KEY secret is not set. Nothing to do.'); process.exit(0); }
const MODEL = process.env.MODEL || 'gemini-3.8-flash';
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX = Number(process.env.MAX_PER_RUN || 20);
const REFRESH_DAYS = Number(process.env.REFRESH_DAYS || 45);
const REFRESH_MAX = Number(process.env.REFRESH_MAX || 5);
const GAP = Number(process.env.GAP_MS || 5000);
const today = () => new Date().toISOString().slice(0, 10);
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORDER = "When you search, check sources in this order and prefer the earlier ones when they disagree: (1) official SAP documentation on help.sap.com, including What's New and the Feature Scope Description; (2) the official SAP website: sap.com, SAP Learning, Roadmap Explorer, SAP Best Practices, Fiori Apps Reference Library; (3) SAP Notes and Knowledge Base Articles for standard workarounds; (4) SAP Community blogs and discussions; (5) SAP Joule documentation; (6) YouTube and public Udemy course pages; (7) public GitHub repositories (treat community repos as unverified); (8) other public documentation.";
const SYSTEM = "You are SAP Coach: a patient senior SAP mentor. The learner knows NOTHING about SAP. Explain simply first, define every term and acronym the first time, then go to real configuration detail. Use real transaction codes, Fiori app names/IDs, SPRO/IMG paths and SAP Note numbers only when confident; otherwise say verify on help.sap.com. Prefer SAP S/4HANA and mention Cloud Public vs Private Edition differences. Never invent facts. Plain text only, no markdown. " + ORDER + " Today is " + today() + ".";

function parseJSON(t) {
  t = String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.search(/[\[{]/); if (a < 0) throw new Error('BADJSON');
  const b = t.lastIndexOf(t[a] === '{' ? '}' : ']');
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error('BADJSON'); }
}

async function gemini(prompt, search) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 },
  };
  if (search) body.tools = [{ google_search: {} }]; else body.generationConfig.responseMimeType = 'application/json';
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      const src = (j.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean).slice(0, 6);
      if (!text) throw new Error('EMPTY');
      return { text, src };
    }
    const msg = (await r.text()).slice(0, 200);
    last = new Error(`HTTP ${r.status} ${msg}`); last.status = r.status;
    if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    await sleep(2000 * Math.pow(2, i));
  }
  throw last;
}

function sopPrompt(q) {
  return `Write a Standard Operating Procedure for the SAP scenario "${q}" in S/4HANA that anyone can follow. Start from what triggers this process (what happens just before it) and end with the hand-off to the next process. Use Google Search for current S/4HANA details. Return ONLY JSON: {"story":"the scenario in simple words, like a story","roles":[{"who":"","does":""}],"steps":[{"step":"what to do","who":"role","where":"tcode or Fiori app (ID)","config_needed":"what must be configured for this step to work, with SPRO path","if_missing":"what goes wrong if that config/step is missing: the SAP message text and number if known","fix":"how to fix it","check":"how to check the step worked"}],"handoffs":["module to module handoff"],"daily_ops":["how it runs day to day, monitoring"],"controls":["control or audit point"],"integrations":[{"system":"system or module it touches","how":"interface type and what data flows"}],"industry_variations":["how this differs in retail DSD, oil and gas dynamic pricing, pharma, automotive and similar, only where it truly differs"],"interview_angles":["how to talk about this in an interview"]}. 8-14 steps in the real order.`;
}

async function build(title) {
  let res;
  try { res = await gemini(sopPrompt(title), true); }
  catch (e) { if (e.status === 429) throw e; res = await gemini(sopPrompt(title).replace('Use Google Search for current S/4HANA details. ', ''), false); }
  let data;
  try { data = parseJSON(res.text); }
  catch { const r2 = await gemini(sopPrompt(title).replace('Use Google Search for current S/4HANA details. ', ''), false); data = parseJSON(r2.text); res = r2; }
  if (!Array.isArray(data.steps) || !data.steps.length) throw new Error('NOSTEPS');
  return { data, src: res.src };
}

fs.mkdirSync('library/sop', { recursive: true });
const topics = JSON.parse(fs.readFileSync('library/topics.json', 'utf8'));
let index = { items: [] };
try { index = JSON.parse(fs.readFileSync('library/index.json', 'utf8')); } catch {}
const byTitle = new Map(index.items.map(x => [x.title, x]));

let todo = topics.filter(t => !byTitle.has(t.title) || !fs.existsSync('library/' + byTitle.get(t.title).file)).slice(0, MAX);
let mode = 'new';
if (!todo.length) {
  const cut = new Date(Date.now() - REFRESH_DAYS * 864e5).toISOString().slice(0, 10);
  todo = topics.filter(t => byTitle.has(t.title) && byTitle.get(t.title).built < cut)
    .sort((a, b) => byTitle.get(a.title).built.localeCompare(byTitle.get(b.title).built)).slice(0, REFRESH_MAX);
  mode = 'refresh';
}
console.log(`Mode ${mode}: ${todo.length} to build. Library has ${index.items.length} of ${topics.length}.`);

let built = 0;
for (const t of todo) {
  try {
    const { data, src } = await build(t.title);
    const file = 'sop/' + slug(t.title) + '.json';
    fs.writeFileSync('library/' + file, JSON.stringify({ title: t.title, group: t.group, built: today(), data, src }));
    byTitle.set(t.title, { title: t.title, group: t.group, file, built: today() });
    built++; console.log('built:', t.title);
  } catch (e) {
    console.log('failed:', t.title, String(e.message).slice(0, 120));
    if (e.status === 429) { console.log('Rate limit reached. Stopping this run; the next scheduled run continues.'); break; }
  }
  await sleep(GAP);
}
index.items = topics.filter(t => byTitle.has(t.title)).map(t => byTitle.get(t.title));
index.updated = today();
fs.writeFileSync('library/index.json', JSON.stringify(index));
console.log(`Done. Built ${built}. Library now has ${index.items.length} of ${topics.length}.`);
