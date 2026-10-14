// Acceptance tests. Run with: node tests/run.js
// Serves the repo from a local static server, opens two separate mobile browser contexts
// (Matt's phone and Louise's phone), and intercepts the Supabase REST API with an
// in-memory table that enforces the same rules as supabase/schema.sql.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MOCK_HOST = "bwisi-test.supabase.co";
const MOCK_URL = `https://${MOCK_HOST}`;
const ANON = "test-anon-key";
const POLL_MS = 1500;
const ALLOWED_HOSTS = new Set([MOCK_HOST, "fonts.googleapis.com", "fonts.gstatic.com"]);

/* ---------------- Reporting ---------------- */
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}
async function item(name, fn) {
  try { const detail = await fn(); report(name, true, detail); }
  catch (e) { report(name, false, (e && e.message || String(e)).split("\n").slice(0, 4).join("\n      ")); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------------- Static server ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = path.join(ROOT, p === "/" ? "index.html" : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/* ---------------- In-memory Supabase ---------------- */
const table = new Map(); // key -> { key, name, stage, blob, decision, read_at, updated_at }
let clock = 0;
const now = () => { clock = Math.max(Date.now(), clock + 1); return new Date(clock).toISOString(); };
const READABLE = ["name", "stage", "blob", "decision", "read_at", "updated_at"];
const rows = () => [...table.values()];
const newest = (a, b) => b.updated_at.localeCompare(a.updated_at);
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const RPC = {
  bwisi_save({ p_key, p_name, p_stage, p_blob }) {
    if (!/^[0-9a-f]{64}$/.test(p_key || "")) throw new HttpErr(400, "bad key");
    if (!["matt", "louise"].includes(p_name) || ![1, 2].includes(p_stage)) throw new HttpErr(400, "bad name or stage");
    const t = now(), r = table.get(p_key);
    if (r) {
      if (r.name !== p_name || r.stage !== p_stage) throw new HttpErr(409, "conflict");
      r.blob = p_blob; r.updated_at = t;
    } else {
      const prev = rows().filter(x => x.name === p_name && x.stage === p_stage).sort(newest)[0];
      table.set(p_key, { key: p_key, name: p_name, stage: p_stage, blob: p_blob, decision: prev ? prev.decision : null, read_at: prev ? prev.read_at : null, updated_at: t });
    }
    return t;
  },
  bwisi_set_decision({ p_key, p_decision }) {
    if (!["yes", "unsure", "no"].includes(p_decision)) throw new HttpErr(400, "bad decision");
    const r = table.get(p_key);
    if (!r || r.stage !== 1) return false;
    r.decision = p_decision; return true;
  },
  bwisi_mark_read({ p_key_matt, p_key_louise, p_stage }) {
    const m = table.get(p_key_matt), l = table.get(p_key_louise);
    if (!m || m.name !== "matt" || m.stage !== p_stage || !l || l.name !== "louise" || l.stage !== p_stage) throw new HttpErr(400, "unknown keys");
    const at = [m.read_at, l.read_at].filter(Boolean).sort()[0] || now();
    m.read_at = at; l.read_at = at; return at;
  },
  bwisi_delete_older({ p_key }) {
    const r = table.get(p_key); if (!r) return 0;
    let n = 0;
    for (const x of rows()) if (x.name === r.name && x.stage === r.stage && x.key !== r.key && x.updated_at < r.updated_at) { table.delete(x.key); n++; }
    return n;
  },
  bwisi_reset({ p_key_matt, p_key_louise, p_stage }) {
    const m = table.get(p_key_matt), l = table.get(p_key_louise);
    if (!m || m.name !== "matt" || m.stage !== p_stage || !l || l.name !== "louise" || l.stage !== p_stage) throw new HttpErr(400, "unknown keys");
    let n = 0;
    for (const x of rows()) if (x.stage === p_stage || (p_stage === 1 && x.stage === 2)) { table.delete(x.key); n++; }
    return n;
  },
};

function handleSupabase(route) {
  const req = route.request(), u = new URL(req.url()), method = req.method();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const send = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
  if (method === "OPTIONS") return send(204);
  if (req.headers()["apikey"] !== ANON) return send(401, { message: "Invalid API key" });
  const p = u.pathname.replace(/^\/rest\/v1\//, "");
  try {
    if (method === "GET" && p === "entries") {
      const cols = (u.searchParams.get("select") || "*").split(",");
      if (cols.some(c => !READABLE.includes(c))) return send(401, { code: "42501", message: "permission denied for table entries" });
      for (const k of u.searchParams.keys()) if (k === "key") return send(401, { code: "42501", message: "permission denied for table entries" });
      let list = rows();
      const name = u.searchParams.get("name"), stage = u.searchParams.get("stage");
      if (name) list = list.filter(r => r.name === name.replace(/^eq\./, ""));
      if (stage) list = list.filter(r => r.stage === +stage.replace(/^eq\./, ""));
      list.sort(newest);
      return send(200, list.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))));
    }
    if (method === "POST" && p.startsWith("rpc/") && RPC[p.slice(4)]) return send(200, RPC[p.slice(4)](JSON.parse(req.postData() || "{}")));
    return send(401, { code: "42501", message: "permission denied for table entries" }); // no direct writes for anon
  } catch (e) { return send(e.status || 500, { message: e.message }); }
}

/* ---------------- Browser helpers ---------------- */
const requests = [], pageErrors = [];
let BASE;
async function newPhone(browser, label, cfg, colorScheme = "light") {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme, locale: "en-US" });
  ctx.on("request", r => requests.push({ label, url: r.url() }));
  await ctx.route("**/*", route => {
    const u = new URL(route.request().url());
    if (u.origin === BASE) {
      if (u.pathname === "/config.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: `window.BWISI_CONFIG = ${JSON.stringify(cfg)};` });
      return route.continue();
    }
    if (u.host === MOCK_HOST) return handleSupabase(route);
    if (u.host === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (u.host === "fonts.gstatic.com") return route.fulfill({ status: 200, body: "" });
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(`${label}: ${e.message}`));
  page.on("dialog", d => { pageErrors.push(`${label}: native dialog used (${d.type()})`); d.dismiss(); });
  await page.goto(`${BASE}/index.html`);
  return { ctx, page, label };
}
const CFG = { supabaseUrl: MOCK_URL, supabaseAnonKey: ANON, pollMs: POLL_MS };

const overflow = [];
async function noOverflow(page, where) {
  await shoot(page, where);
  const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
  if (w > 0) overflow.push(`${where}: ${w}px too wide`);
}
// Optional: BWISI_SHOTS=<dir> node tests/run.js saves light and dark screenshots of every checked screen.
let shotN = 0;
async function shoot(page, where) {
  const dir = process.env.BWISI_SHOTS; if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const n = String(++shotN).padStart(2, "0"), slug = where.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(dir, `${n}-${slug}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
const lsLeaks = [];
async function scanStorage(phone, forbiddenToken, where) {
  const dump = await phone.page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return JSON.stringify(o); });
  if (dump.includes(forbiddenToken)) lsLeaks.push(`${phone.label} at ${where}`);
}
let matt, louise;
async function scanBoth(where) { await scanStorage(matt, "LOU-", where); await scanStorage(louise, "MAT-", where); }

async function heading(page) { return (await page.locator("h2").first().textContent()).trim(); }
async function fillCurrent(page, answers) {
  for (const [id, v] of Object.entries(answers)) {
    if (typeof v === "number") { const b = page.locator(`[data-scale="${id}"][data-n="${v}"]`); if (await b.count()) await b.click(); }
    else if (["yes", "maybe", "no"].includes(v)) { const b = page.locator(`[data-ymn="${id}"][data-v="${v}"]`); if (await b.count()) await b.click(); }
    else { const t = page.locator(`#q-${id}`); if (await t.count()) await t.fill(v); }
  }
}
// From the first section of a stage: fill every section and land on the review screen.
async function fillStage(page, answers, where) {
  for (let i = 0; i < 10; i++) {
    await fillCurrent(page, answers);
    await noOverflow(page, `${where} form ${await heading(page)}`);
    const next = page.locator("#next"), label = (await next.textContent()).trim();
    await next.click();
    if (label === "Review and submit") break;
  }
  await page.locator("#submit").waitFor();
  await noOverflow(page, `${where} review`);
}
async function submitNewPassword(page, pw, where) {
  await page.locator("#submit").click();
  await page.locator("#pw1").waitFor();
  await noOverflow(page, `${where} password`);
  await page.fill("#pw1", pw); await page.fill("#pw2", pw);
  await page.click("#save-new");
  await page.locator("#saved-msg").waitFor({ timeout: 10000 });
}
async function goHome(page) {
  for (let i = 0; i < 8; i++) {
    if (await page.locator("#switch").count()) return;
    const b = page.locator("#home, #back, #prev, #done").first();
    if (!(await b.count())) break;
    await b.click();
  }
  await page.locator("#switch").waitFor();
}
const louiseRows = st => rows().filter(r => r.name === "louise" && r.stage === st).sort(newest);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/* ---------------- Fixtures ---------------- */
const MATT = { why1: "MAT-why1 copper kettle morning", why2: 9, why3: "MAT-why3 yes on my own", why4: "MAT-why4 no", why5: "MAT-why5 we stay us", why6: "MAT-why6 a trip",
  f1: "MAT-f1 feeling left out", f2: "MAT-f2 seeing a spark", f3: "MAT-f3 quiet, then hugs", f4: "MAT-f4 coworkers", f5: "MAT-f5 if you look sad",
  a1: "yes", a2: "yes", a3: "yes", a4: "yes", a5: "yes", a6: "yes", a7: "yes", a8: "yes", a9: "maybe", a10: "yes", a11: "maybe", a12: "no", a13: "maybe", a14: "yes", a15: "no",
  aOther: "MAT-other massage yes" };
const LOU = { why1: "LOU-why1 quiet harbour lantern", why2: 4, why3: "LOU-why3 probably not", why4: "LOU-why4 a little", why5: "LOU-why5 we talk more", why6: "LOU-why6 a weekend away",
  f1: "LOU-f1 being compared", f2: "LOU-f2 the messages", f3: "LOU-f3 I go silent", f4: "LOU-f4 my friends", f5: "LOU-f5 feeling ignored",
  a1: "yes", a2: "yes", a3: "maybe", a4: "no", a5: "maybe", a6: "no", a7: "maybe", a8: "yes", a9: "yes", a10: "maybe", a11: "no", a12: "no", a13: "maybe", a14: "yes", a15: "no",
  aOther: "LOU-other slow dancing maybe" };

/* ---------------- Run ---------------- */
(async () => {
  const srv = await startServer();
  BASE = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  try {
    matt = await newPhone(browser, "Matt's phone", CFG);
    louise = await newPhone(browser, "Louise's phone", CFG);
    const M = matt.page, L = louise.page;

    await item("1. Matt's draft and section survive a reload", async () => {
      await M.click("#pick-matt");
      await noOverflow(M, "home");
      await M.click('[data-start="1"]');
      await M.fill("#q-why1", MATT.why1);
      await M.click("#next");
      await M.fill("#q-f1", MATT.f1);
      await M.locator("#saved", { hasText: "Saved on this phone" }).waitFor({ timeout: 3000 });
      await scanBoth("after Matt's draft");
      await M.reload();
      await M.locator('[data-start="1"]', { hasText: "Continue Stage 1" }).waitFor();
      await M.click('[data-start="1"]');
      assert((await heading(M)) === "Feelings and fears", `resumed on "${await heading(M)}", expected section 2`);
      assert((await M.inputValue("#q-f1")) === MATT.f1, "f1 not restored");
      await M.click("#back");
      assert((await M.inputValue("#q-why1")) === MATT.why1, "why1 not restored");
      await M.click("#back"); // to home
      await M.locator("#switch").waitFor();
    });

    await item("2. Louise submits Stage 1 with a password; row holds only ciphertext", async () => {
      await L.click("#pick-louise");
      await L.click('[data-start="1"]');
      await fillStage(L, LOU, "Louise");
      await submitNewPassword(L, "river-stone", "Louise");
      assert((await L.textContent("#saved-msg")).trim() === "Saved. Your answers are sealed with your password.", "wrong saved message");
      const r = louiseRows(1);
      assert(r.length === 1, `expected 1 Louise row, found ${r.length}`);
      assert(r[0].name === "louise" && r[0].stage === 1 && r[0].blob.length > 100, "row fields wrong");
      assert(r[0].key === sha("louise:1:river-stone"), "row key is not sha256(name:stage:password)");
      const decoded = Buffer.from(r[0].blob, "base64url").toString("latin1");
      for (const v of Object.values(LOU).filter(v => typeof v === "string" && v.length > 3))
        assert(!r[0].blob.includes(v) && !decoded.includes(v), `blob contains plain text "${v}"`);
      await scanBoth("after Louise saved");
    });

    await item("3. Matt's home shows Louise saved within one poll, no reload", async () => {
      await M.evaluate(() => { window.__sameDoc = true; });
      await M.locator('.pill[data-p="louise"] .st', { hasText: /^Saved / }).waitFor({ timeout: POLL_MS * 2 + 1000 });
      assert(await M.evaluate(() => window.__sameDoc === true), "page reloaded");
    });

    await item("4. Matt submits Stage 1; both rows present", async () => {
      await M.click('[data-start="1"]');
      while ((await heading(M)) !== "Why, or why not") await M.click("#back");
      await fillStage(M, MATT, "Matt");
      await submitNewPassword(M, "oak-7", "Matt");
      const all = rows().filter(r => r.stage === 1);
      assert(all.length === 2 && all.some(r => r.name === "matt") && all.some(r => r.name === "louise"), `stage 1 rows: ${all.map(r => r.name)}`);
      await scanBoth("after Matt saved");
    });

    await item("5. Reading together: wrong password message, verdicts, scale flag", async () => {
      await M.click("#home");
      await M.click('[data-read="1"]');
      await noOverflow(M, "together");
      await M.fill("#pw-matt", "oak-7"); await M.fill("#pw-louise", "not-her-password");
      await M.click("#open");
      const err = M.locator("#pw-louise-err"); await err.waitFor({ timeout: 10000 });
      assert((await err.textContent()).trim() === "That password didn't open Louise's answers.", `message was "${await err.textContent()}"`);
      assert((await M.locator("#pw-matt-err").count()) === 0, "Matt's correct password was flagged");
      assert(!(await M.locator(".bar", { hasText: "Reading" }).count()), "reading opened with a wrong password");
      await M.fill("#pw-matt", "oak-7"); await M.fill("#pw-louise", "river-stone");
      await M.click("#open");
      await M.locator(".bar", { hasText: "Reading Stage 1 together · 1 of 4" }).waitFor({ timeout: 10000 });
      await noOverflow(M, "reading 1");
      assert(await M.locator(".note", { hasText: "Before you read:" }).count(), "missing Before you read note");
      assert(await M.locator(".flag", { hasText: "Scores are 5 apart. Talk about this before anything else." }).count(), "no 9 vs 4 scale flag");
      const firstAns = await M.locator(".cmp-q").first().locator(".ans").first().getAttribute("data-ans");
      assert(firstAns === "louise", "partner's answer should come first on Matt's phone");
      assert(await M.locator(".cmp-q", { hasText: "Anything other than a clear no here is worth stopping on." }).count(), "why4 note missing");
      assert(await M.locator(".cmp-q", { hasText: "this is the conversation to have before any other" }).count(), "why5 note missing");
      await M.click("#nextc"); await noOverflow(M, "reading 2");
      await M.click("#nextc"); await noOverflow(M, "reading 3");
      const verdicts = await M.locator(".verdict").allTextContents();
      for (const v of ["Agreed", "Talk it through", "Off the table"]) assert(verdicts.includes(v), `verdict "${v}" missing`);
      const a1 = await M.locator(".cmp-q").nth(0).locator(".verdict").textContent();
      const a3 = await M.locator(".cmp-q").nth(2).locator(".verdict").textContent();
      const a4 = await M.locator(".cmp-q").nth(3).locator(".verdict").textContent();
      assert(a1 === "Agreed" && a3 === "Talk it through" && a4 === "Off the table", `verdicts a1=${a1} a3=${a3} a4=${a4}`);
      await M.click("#nextc");
      await M.locator("h2", { hasText: "Where are you?" }).waitFor();
      assert(await M.locator("text=Sleep on it before you answer this.").count(), "missing sleep on it line");
      assert(await M.locator("text=You first read Stage 1 together on").count(), "missing first-read date");
      await noOverflow(M, "reading decision");
      await scanBoth("while reading");
      return "blank-scale case is checked in 5b below";
    });

    await item("6. Decisions gate Stage 2 on both phones", async () => {
      await L.click("#home");
      await L.locator("[data-decide-open]").waitFor({ timeout: POLL_MS * 2 + 1000 });
      assert(await L.locator('[data-card="2"].locked').count(), "Stage 2 should start locked");
      await L.click("[data-decide-open]");
      await noOverflow(L, "decide");
      if (await L.locator("#pw-own").count()) await L.fill("#pw-own", "river-stone");
      await L.click('[data-decide="yes"]');
      await L.locator('[data-decide="yes"][aria-pressed="true"]').waitFor({ timeout: 10000 });
      await M.click('[data-decide="yes"]');
      await M.locator('[data-decide="yes"][aria-pressed="true"]').waitFor({ timeout: 10000 });
      const d = rows().filter(r => r.stage === 1).map(r => `${r.name}=${r.decision}`).sort().join(",");
      assert(d === "louise=yes,matt=yes", `decisions in table: ${d}`);
      await L.click("#home");
      await L.locator('[data-start="2"]').waitFor({ timeout: POLL_MS * 2 + 1000 });
      await L.click("[data-decide-open]");
      await L.click('[data-decide="no"]');
      await L.locator('[data-decide="no"][aria-pressed="true"]').waitFor({ timeout: 10000 });
      await L.click("#home");
      const lock = L.locator("#s2-lock"); await lock.waitFor({ timeout: POLL_MS * 2 + 1000 });
      assert((await lock.textContent()).includes("Stage 2 stays closed, and that's a complete answer."), `lock text: ${await lock.textContent()}`);
      assert(!(await L.locator('[data-start="2"]').count()), "Stage 2 still open after a no");
      await scanBoth("after decisions");
    });

    await item("7. Louise edits her saved answers with her password", async () => {
      const before = { ...louiseRows(1)[0] };
      await L.evaluate(() => localStorage.removeItem("bwisi:draft:1:louise"));
      await L.click('[data-edit="1"]');
      await L.fill("#pw-own", "river-stone");
      await L.click("#open");
      await L.locator("#q-why1").waitFor({ timeout: 10000 });
      assert((await L.inputValue("#q-why1")) === LOU.why1, "form not prefilled from the saved row");
      await L.fill("#q-why1", LOU.why1 + " EDITED");
      await fillStage(L, {}, "Louise edit");
      await L.click("#submit");
      await L.click("#save-same");
      await L.locator("#saved-msg").waitFor({ timeout: 10000 });
      const after = louiseRows(1);
      assert(after.length === 1, `expected 1 row, found ${after.length}`);
      assert(after[0].key === before.key, "key changed");
      assert(after[0].updated_at > before.updated_at, "updated_at did not move forward");
      assert(after[0].blob !== before.blob, "blob unchanged");
      await scanBoth("after Louise's edit");
    });

    await item("8. A new password makes a second row; newest wins; older can be deleted", async () => {
      await L.click("#home");
      await L.click('[data-edit="1"]');
      await L.fill("#pw-own", "river-stone"); await L.click("#open");
      await L.locator("#next").waitFor({ timeout: 10000 });
      await fillStage(L, {}, "Louise new pw");
      await L.click("#submit");
      await L.click("#pw-new");
      await L.fill("#pw1", "new-path"); await L.fill("#pw2", "new-path");
      await L.click("#save-new");
      await L.locator("#saved-msg").waitFor({ timeout: 10000 });
      let r = louiseRows(1);
      assert(r.length === 2, `expected 2 Louise rows, found ${r.length}`);
      assert(r[0].key === sha("louise:1:new-path"), "newest row is not the new password's row");
      await L.click("#home");
      await L.click('[data-edit="1"]');
      await L.fill("#pw-own", "river-stone"); await L.click("#open");
      const err = L.locator("#pw-own-err"); await err.waitFor({ timeout: 10000 });
      assert((await err.textContent()).trim() === "That password didn't open Louise's answers.", "old password should not open the current version");
      await L.fill("#pw-own", "new-path"); await L.click("#open");
      await L.locator("[data-del-older]").waitFor({ timeout: 10000 });
      await L.click("[data-del-older]");
      await L.locator("[data-del-older]").waitFor({ state: "detached", timeout: 10000 });
      r = louiseRows(1);
      assert(r.length === 1 && r[0].key === sha("louise:1:new-path"), `after delete: ${r.length} rows`);
      await L.click("#back");
      await scanBoth("after password change");
    });

    await item("5b. Blank scale shows 'didn't answer' (and Stage 1 reset works)", async () => {
      // Reset Stage 1 for both from Matt's phone, then submit a round where Matt leaves the scale blank.
      await goHome(M);
      await M.click('[data-read="1"]');
      await M.fill("#pw-matt", "oak-7"); await M.fill("#pw-louise", "new-path"); await M.click("#open");
      await M.locator(".bar", { hasText: "Reading Stage 1" }).waitFor({ timeout: 10000 });
      for (let i = 0; i < 3; i++) await M.click("#nextc");
      await M.click("#reset"); await M.click("#c-yes");
      await M.locator("#switch").waitFor({ timeout: 10000 });
      assert(rows().length === 0, `rows left after reset: ${rows().length}`);
      await M.click('[data-start="1"]');
      while ((await heading(M)) !== "Why, or why not") await M.click("#back");
      await M.click("#clear"); await M.click("#c-yes");
      await M.fill("#q-why1", "MAT-second round");
      await fillStage(M, {}, "Matt round 2");
      await submitNewPassword(M, "oak-7", "Matt round 2");
      await goHome(L);
      await L.locator('[data-start="1"]').waitFor({ timeout: POLL_MS * 2 + 1000 });
      await L.click('[data-start="1"]');
      await fillStage(L, {}, "Louise round 2");
      await L.click("#submit");
      if (await L.locator("#save-same").count()) await L.click("#save-same");
      else { await L.fill("#pw1", "new-path"); await L.fill("#pw2", "new-path"); await L.click("#save-new"); }
      await L.locator("#saved-msg").waitFor({ timeout: 10000 });
      await M.click("#home");
      await M.locator('[data-read="1"]').waitFor({ timeout: POLL_MS * 2 + 1000 });
      await M.click('[data-read="1"]');
      await M.fill("#pw-matt", "oak-7"); await M.fill("#pw-louise", "new-path"); await M.click("#open");
      await M.locator(".bar", { hasText: "Reading Stage 1" }).waitFor({ timeout: 10000 });
      assert(await M.locator(".flag", { hasText: "One of you didn't answer this. Ask why." }).count(), "no 'didn't answer' flag");
      assert(!(await M.locator(".flag", { hasText: "Scores are" }).count()), "blank treated as a score");
      await scanBoth("round 2 reading");
      await M.click("#prev");
    });

    await item("9. No partner answer text in either phone's localStorage, at any point", async () => {
      await scanBoth("end");
      assert(lsLeaks.length === 0, `leaks: ${lsLeaks.join("; ")}`);
    });

    await item("10. No horizontal overflow at 390px (home, form, password, review, reading)", async () => {
      assert(overflow.length === 0, overflow.join("; "));
    });

    await item("11. Only the Supabase host and Google Fonts are contacted", async () => {
      const bad = requests.filter(r => { const u = new URL(r.url); return u.origin !== BASE && !ALLOWED_HOSTS.has(u.host) && !u.protocol.startsWith("data"); });
      assert(requests.some(r => r.url.startsWith(MOCK_URL)), "no Supabase requests seen at all");
      assert(bad.length === 0, `unexpected: ${[...new Set(bad.map(r => r.url))].slice(0, 5).join(", ")}`);
    });

    await item("12. Empty config.js shows the setup message and nothing throws", async () => {
      const errsBefore = pageErrors.length;
      const blank = await newPhone(browser, "Unconfigured phone", { supabaseUrl: "", supabaseAnonKey: "" });
      await blank.page.locator("#setup", { hasText: "This page isn't connected yet." }).waitFor({ timeout: 5000 });
      await blank.page.waitForTimeout(300);
      assert(pageErrors.length === errsBefore, pageErrors.slice(errsBefore).join("; "));
      assert(!requests.some(r => r.label === "Unconfigured phone" && r.url.includes(MOCK_HOST)), "unconfigured page called Supabase");
      await blank.ctx.close();
    });

    await item("No uncaught page errors or native dialogs on any phone", async () => {
      assert(pageErrors.length === 0, pageErrors.join("; "));
    });
  } finally {
    await browser.close();
    srv.close();
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
