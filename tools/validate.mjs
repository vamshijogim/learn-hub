// Real-key smoke test: opens both apps in a headless browser, uses the real Gemini key, and reports what works.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.GEMINI_API_KEY || '';
if (!KEY) { console.log('RESULT: GEMINI_API_KEY secret is not set.'); process.exit(0); }
const STUB = process.env.STUB_FILE ? (await import(path.resolve(process.env.STUB_FILE))).default : null;
const T = Number(process.env.STEP_TIMEOUT || 240000);
const types = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript' };
const srv = http.createServer((q, r) => {
  const p = path.join(process.cwd(), decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'text/plain' }); r.end(d); } });
}).listen(8811);

const browser = await chromium.launch();
const results = [], net = {};
async function open(file, keyName) {
  const page = await browser.newPage();
  await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} window.__fcBgMs = 1e9; }, [keyName, KEY]);
  page.on('pageerror', e => results.push(['PAGE ERROR', file, String(e.message).slice(0, 200)]));
  page.on('response', async r => {
    if (!/generativelanguage/.test(r.url())) return;
    const model = (r.url().match(/models\/([^:]+)/) || [])[1] || '?';
    let extra = '';
    if (r.status() !== 200) { try { extra = ' ' + String((await r.json()).error?.message || '').replace(/\s+/g, ' ').slice(0, 90); } catch (e) {} }
    const k = model + ' HTTP ' + r.status() + extra; net[k] = (net[k] || 0) + 1;
  });
  if (STUB) await page.route(/generativelanguage/, async route => {
    const b = JSON.parse(route.request().postData());
    const a = STUB.stubAnswer(b.systemInstruction.parts[0].text, b.contents.map(c => c.parts.map(p => p.text || '').join('')).join('\n'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: a ? JSON.stringify(a) : 'A plain answer.' }] } }] }) });
  });
  await page.goto('http://127.0.0.1:8811/' + file);
  return page;
}
async function step(page, app, name, fn) {
  const t0 = Date.now(); let ok = true, info = '';
  try { info = String(await fn() || ''); } catch (e) { ok = false; info = String(e.message).split('\n')[0].slice(0, 160); }
  let toast = ''; try { toast = await page.$eval('#toast', e => getComputedStyle(e).display !== 'none' && /err/.test(e.className) ? e.textContent : ''); } catch (e) {}
  results.push([ok ? 'PASS' : 'FAIL', app + ': ' + name, Math.round((Date.now() - t0) / 1000) + 's', info.replace(/\s+/g, ' ').slice(0, 170) + (toast ? ' | message shown: ' + toast.slice(0, 140) : '')]);
  try { await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.display = 'none'; }); } catch (e) {}
}
const tab = (page, t) => page.click(`[data-a="tab"][data-t="${t}"]`);

// ---------- Study Notes ----------
{
  const page = await open('index.html', 'sc_key');
  await step(page, 'Study Notes', 'Mentor lesson (Pricing procedure)', async () => {
    await tab(page, 'mentor'); await page.fill('[data-m="mTopic"]', 'Pricing procedure'); await page.click('[data-a="mTeach"]');
    await page.waitForFunction(() => SC.S.lib.some(x => x.kind === 'lesson'), null, { timeout: T });
    return page.evaluate(() => { const l = SC.S.lib.find(x => x.kind === 'lesson'); return 'title: ' + l.title + ' | config steps: ' + (l.data.configuration_table || []).length + ' | quiz: ' + (l.data.check_questions || []).length; });
  });
  await step(page, 'Study Notes', 'Mentor follow-up chat', async () => {
    await tab(page, 'mentor'); await page.fill('[data-m="chatIn"]', 'In one sentence, what is ATP in SAP sales?'); await page.click('[data-a="send"]');
    await page.waitForFunction(() => SC.S.chat.some(m => m.r === 'm'), null, { timeout: T });
    return page.evaluate(() => 'reply: ' + SC.S.chat.filter(m => m.r === 'm').slice(-1)[0].t);
  });
  await step(page, 'Study Notes', 'Practice: generate questions', async () => {
    await tab(page, 'qbank'); await page.selectOption('[data-m="qCat"]', 'OTC'); await page.click('[data-a="qbGen"]');
    await page.waitForFunction(() => SC.QB.list.some(q => q.status === 'New') || (!SC.U.load && document.querySelector('#toast.err')), null, { timeout: T });
    const n = await page.evaluate(() => SC.QB.list.filter(q => q.status === 'New').length); if (!n) throw new Error('no valid questions came back');
    return page.evaluate(() => { const q = SC.QB.list.filter(q => q.status === 'New'); return q.length + ' new, e.g. ' + q[0].q; });
  });
  await step(page, 'Study Notes', 'SOP Builder: find variants (Returns)', async () => {
    await tab(page, 'sop'); await page.fill('[data-m="sQ"]', 'Returns'); await page.click('[data-a="sopNew"]');
    await page.waitForSelector('[data-a="sopNow"]', { timeout: 30000 }).catch(() => {});
    const have = await page.evaluate(() => [...SC.DB.keys].some(k => k.includes('|variants|returns')));
    if (!have) { await page.click('[data-a="sopNow"]'); await page.waitForFunction(() => [...SC.DB.keys].some(k => k.includes('|variants|returns')), null, { timeout: T }); }
    return page.evaluate(async () => { const k = [...SC.DB.keys].find(k => k.includes('|variants|returns')); const v = await SC.DB.get(k); return (have => 'variants: ' + v.variants.map(x => x.name).join('; '))(); });
  });
  await step(page, 'Study Notes', 'Shared SOP library loads', async () => {
    await tab(page, 'sop'); await page.waitForTimeout(3000);
    return page.evaluate(() => document.querySelectorAll('.fcard.s2').length + ' complete, ' + document.querySelectorAll('.fcard.s1').length + ' in progress on the board');
  });
  await step(page, 'Study Notes', 'Panel Session: first question', async () => {
    await tab(page, 'interview'); await page.fill('[data-m="pnTopic"]', 'Order-to-Cash'); await page.click('[data-a="pnStart"]');
    await page.waitForFunction(() => SC.U.pn && SC.U.pn.log.length > 0, null, { timeout: T });
    return page.evaluate(() => SC.U.pn.log[0].who + ': ' + SC.U.pn.log[0].text);
  });
  await step(page, 'Study Notes', 'Panel Session: follow-up to my answer', async () => {
    await page.fill('[data-m="pnAns"]', 'I led an S/4HANA order-to-cash rollout across four countries and cut order cycle time by 20 percent.'); await page.click('[data-a="pnSend"]');
    await page.waitForFunction(() => SC.U.pn.log.filter(x => x.r === 'p').length > 1, null, { timeout: T });
    return page.evaluate(() => { const x = SC.U.pn.log.filter(x => x.r === 'p')[1]; return x.who + ': ' + x.text; });
  });
  await page.close();
}
// ---------- FamilyCoach ----------
{
  const page = await open('family.html', 'fc_key');
  await step(page, 'FamilyCoach', 'Add a learner', async () => {
    await page.fill('[data-f="name"]', 'Tester'); await page.selectOption('[data-f="stage"]', 'middle'); await page.fill('[data-f="grade"]', '7th grade'); await page.click('[data-a="saveProf"]');
    await page.waitForFunction(() => FC.U.tab === 'today', null, { timeout: 15000 }); return 'Today tab opened';
  });
  await step(page, 'FamilyCoach', 'Learn: lesson on fractions', async () => {
    await page.click('nav [data-t="learn"]'); await page.fill('[data-m="learnTopic"]', 'fractions'); await page.click('[data-a="learn"]');
    await page.waitForFunction(() => FC.U.lesson && FC.U.lesson.cards && FC.U.lesson.cards.length > 0, null, { timeout: T });
    return page.evaluate(() => 'idea: ' + FC.U.lesson.idea + ' | cards: ' + FC.U.lesson.cards.length);
  });
  await step(page, 'FamilyCoach', 'Practice: questions on addition', async () => {
    await page.click('nav [data-t="practice"]'); await page.fill('[data-m="prTopic"]', 'adding fractions'); await page.click('[data-a="prStart"]');
    await page.waitForFunction(() => FC.U.pr && FC.U.pr.q && FC.U.pr.q.length > 0, null, { timeout: T });
    return page.evaluate(() => FC.U.pr.q.length + ' questions, first: ' + FC.U.pr.q[0].q);
  });
  await step(page, 'FamilyCoach', 'Mentor chat', async () => {
    await page.click('nav [data-t="mentor"]'); await page.fill('[data-m="chatIn"]', 'How can I get better at math homework?'); await page.click('[data-a="send"]');
    await page.waitForFunction(() => FC.S.profiles[0].chat.some(m => m.r === 'm'), null, { timeout: T });
    return page.evaluate(() => 'reply: ' + FC.S.profiles[0].chat.filter(m => m.r === 'm').slice(-1)[0].t);
  });
  await step(page, 'FamilyCoach', 'Languages: Spanish words', async () => {
    await page.click('nav [data-t="lang"]'); await page.fill('[data-m="lgTopic"]', 'food'); await page.click('[data-a="lgLearn"]');
    await page.waitForFunction(() => FC.U.lg.words && FC.U.lg.words.length > 0, null, { timeout: T });
    return page.evaluate(() => FC.U.lg.words.slice(0, 4).map(w => w.n + ' = ' + w.m).join('; '));
  });
  await step(page, 'FamilyCoach', 'My Path (uses web search)', async () => {
    await page.click('nav [data-t="path"]'); await page.fill('[data-m="pathGoal"]', 'become a software engineer'); await page.click('[data-a="pathMake"]');
    await page.waitForFunction(() => FC.S.profiles[0].pathDraft && FC.S.profiles[0].pathDraft.milestones, null, { timeout: T });
    return page.evaluate(() => 'milestones: ' + FC.S.profiles[0].pathDraft.milestones.length + ', first: ' + FC.S.profiles[0].pathDraft.milestones[0].when);
  });
  await page.close();
}
await browser.close(); srv.close();
console.log('\n===== VALIDATION RESULTS =====');
for (const r of results) console.log('RESULT | ' + r.join(' | '));
console.log('===== GEMINI CALLS =====');
for (const [k, v] of Object.entries(net)) console.log('NET | ' + v + ' x ' + k);
console.log('SUMMARY | ' + results.filter(r => r[0] === 'PASS').length + ' passed, ' + results.filter(r => r[0] !== 'PASS').length + ' failed');
