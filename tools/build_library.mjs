// Scheduled SOP library builder. It runs the SAME engine as the page (the block between ENGINE-START and
// ENGINE-END in index.html): one family at a time in OTC order, each finished completely before the next.
// Output: library/sop2/<family>.json (every part of that family) and library/sop2/index.json.
import fs from 'node:fs';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.log('GEMINI_API_KEY secret is not set. Nothing to do.'); process.exit(0); }
const MODEL = process.env.MODEL || 'gemini-3.8-flash';
const FALLBACK = process.env.FALLBACK_MODEL || 'gemini-3.5-flash-lite';
let model = MODEL;
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_CALLS = Number(process.env.MAX_CALLS || 40);
const MAX_MS = Number(process.env.MAX_MINUTES || 30) * 60000;
const GAP = Number(process.env.GAP_MS || 4000);
const DIR = 'library/sop2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const today = () => new Date().toISOString().slice(0, 10);

const html = fs.readFileSync('index.html', 'utf8');
const a = html.indexOf('/*ENGINE-START*/'), b = html.indexOf('/*ENGINE-END*/');
if (a < 0 || b < 0) { console.log('Engine block not found in index.html'); process.exit(1); }
const SOPE = new Function(html.slice(a, b) + ';return SOPE')();

fs.mkdirSync(DIR, { recursive: true });
const families = SOPE.order([]);
const store = new Map();                       // key -> payload
const fileOf = fam => slug(fam) + '.json';
for (const fam of families) {
  try { const j = JSON.parse(fs.readFileSync(`${DIR}/${fileOf(fam)}`, 'utf8')); for (const k of Object.keys(j)) store.set(k, j[k]); } catch {}
}
let state = { skip: {}, fail: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(`${DIR}/state.json`, 'utf8'))); } catch {}

let calls = 0;
async function call(system, input, o = {}) {
  if (calls >= MAX_CALLS) throw Object.assign(new Error('call budget for this run used'), { rate: true });
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: Math.min(32000, Math.max(8000, o.max || 8000) * 2) } };
  if (o.search) body.tools = [{ google_search: {} }]; else body.generationConfig.responseMimeType = 'application/json';
  calls++;
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('empty answer');
      await sleep(GAP);
      return { text, src: (j.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean).slice(0, 6) };
    }
    const raw = await r.text();
    let msg = raw; try { msg = JSON.parse(raw).error?.message || raw; } catch {}
    last = new Error(`HTTP ${r.status} [${model}] ${String(msg).replace(/\s+/g, ' ').slice(0, 600)}`);
    if (r.status === 429) {
      last.rate = true;
      if (/quota/i.test(msg) && model !== FALLBACK) { console.log(`Quota problem on ${model}; switching this run to ${FALLBACK}.`); model = FALLBACK; i = -1; continue; }
      if (/quota/i.test(msg)) throw last;
    }
    if ([400, 401, 403, 404].includes(r.status)) { last.fatal = true; throw last; }
    await sleep(Number(process.env.RETRY_MS || 3000) * Math.pow(2, i));
  }
  throw last;
}
const io = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, call };
const get = k => store.get(k);

function saveFamily(fam) {
  const fl = SOPE.lc(fam), out = {};
  for (const [k, v] of store) if (SOPE.famOfKey(k) === fl) out[k] = v;
  if (Object.keys(out).length) fs.writeFileSync(`${DIR}/${fileOf(fam)}`, JSON.stringify(out));
}
function saveIndex() {
  const idx = { updated: today(), families: {} };
  for (const fam of families) {
    const fl = SOPE.lc(fam), keys = [...store.keys()].filter(k => SOPE.famOfKey(k) === fl);
    if (!keys.length) continue;
    const v = store.get(SOPE.key('variants', fam));
    let stamp = ''; for (const k of keys) { const g = store.get(k)?.generated || ''; if (g > stamp) stamp = g; }
    idx.families[fl] = { name: fam, file: fileOf(fam), keys, updated: stamp + ':' + keys.length, complete: !!v && SOPE.missing(fam, get).length === 0, variants: v?.variants?.length || 0 };
  }
  fs.writeFileSync(`${DIR}/index.json`, JSON.stringify(idx));
  fs.writeFileSync(`${DIR}/state.json`, JSON.stringify(state));
  return idx;
}

const t0 = Date.now();
let built = 0, stop = '';
while (calls < MAX_CALLS && Date.now() - t0 < MAX_MS) {
  const j = SOPE.next(get, state.skip, Date.now(), []);
  if (!j) { stop = 'library complete'; break; }
  const pk = SOPE.pkey(j.fam, j.part, j.variant), label = `${j.fam}${j.variant ? ' > ' + j.variant : ''} -- ${SOPE.LABEL[j.part]}`;
  try {
    await SOPE.generate(j.part, j.fam, j.variant, io, {});
    delete state.fail[pk]; delete state.skip[pk];
    built++; console.log('written:', label);
  } catch (e) {
    console.log('failed:', label, '--', String(e.message).slice(0, 700));
    if (e.fatal) { stop = 'key or model problem: ' + String(e.message).slice(0, 120); break; }
    if (e.rate) { stop = 'rate limit or run budget reached'; break; }
    state.fail[pk] = (state.fail[pk] || 0) + 1;
    state.skip[pk] = Date.now() + (e.wait ? 600e3 : state.fail[pk] >= 2 ? 3 * 864e5 : 1800e3);
  }
  saveFamily(j.fam); saveIndex();
}
const idx = saveIndex();
const done = Object.values(idx.families).filter(f => f.complete).length;
console.log(`Run finished: ${built} parts written with ${calls} AI calls${stop ? ' (' + stop + ')' : ''}. ${done} of ${families.length} families complete.`);
