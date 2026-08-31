/* End-to-end smoke test.
 *
 * Drives the real app in headless Chrome over the DevTools protocol — no test
 * framework, no npm install. A fake (locally valid, server-rejected) Supabase
 * session is injected before first paint, so every local-first code path runs
 * for real while network sync fails in the background. That is exactly the
 * situation the app has to survive, and it is where the "my new note vanished"
 * bug used to live.
 *
 *   node test/smoke.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 8799;
const CDP_PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

const results = [];
const ok = (name) => { results.push([true, name]); console.log(`  ✓ ${name}`); };
const bad = (name, why) => { results.push([false, name]); console.log(`  ✗ ${name}\n      ${why}`); };

/* ── static server ─────────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

/* ── chrome ────────────────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), "ckeep-test-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--window-size=1280,1000",
  "about:blank",
], { stdio: "ignore" });

const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

/* ── CDP plumbing ──────────────────────────────────────────────────── */
async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome never came up on the debugging port");
}

const wsUrl = await cdpTarget();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text);
  }
};

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(method + " timed out")); }, 30000);
  });

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");

/* A session that is structurally valid and far from expiry, so supabase-js
   accepts it locally without ever asking the network. */
const FAKE = {
  access_token: "test.token.value",
  token_type: "bearer",
  expires_in: 999999,
  expires_at: Math.floor(Date.now() / 1000) + 999999,
  refresh_token: "test-refresh",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "tester@example.com",
    aud: "authenticated", role: "authenticated",
    app_metadata: {}, user_metadata: {},
    created_at: new Date().toISOString(),
  },
};

await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `try {
    localStorage.setItem("sb-sywglobxvtxayvelhunb-auth-token", ${JSON.stringify(JSON.stringify(FAKE))});
    localStorage.setItem("keep_theme", "light");
  } catch (e) {}`,
});

async function load() {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  // wait for the app to finish its first paint
  for (let i = 0; i < 80; i++) {
    const up = await evaluate(`return !!document.querySelector("#composer") &&
      document.documentElement.classList.contains("authed") &&
      !!window.__keepReady;`).catch(() => false);
    if (up) return;
    await sleep(250);
  }
  throw new Error("app did not become ready");
}

console.log("\nKeep — smoke test\n");
await load();
ok("app boots with a session and reaches ready state");

/* ── 1. clean slate ────────────────────────────────────────────────── */
await evaluate(`
  const K = window.__keep;
  await K.resetForTest();
  return true;`);

/* ── 2. add a note (the reported bug) ──────────────────────────────── */
await evaluate(`
  const q = (s) => document.querySelector(s);
  q("#cmp-stub").click();
  await new Promise(r => requestAnimationFrame(r));
  q("#cmp-title").value = "First note";
  q("#cmp-body").value  = "hello world";
  q('[data-cmp="close"]').click();
  await new Promise(r => setTimeout(r, 150));
  return true;`);

let cards = await evaluate(`return document.querySelectorAll("#grid-others .note").length;`);
cards === 1 ? ok("adding a note paints a card immediately") : bad("adding a note paints a card immediately", `got ${cards} cards`);

/* ── 3. add more notes — this is what used to fail ─────────────────── */
for (const [t, b] of [["Second", "two"], ["Third", "three"], ["Fourth", "four"]]) {
  await evaluate(`
    const q = (s) => document.querySelector(s);
    q("#cmp-stub").click();
    await new Promise(r => requestAnimationFrame(r));
    q("#cmp-title").value = ${JSON.stringify(t)};
    q("#cmp-body").value  = ${JSON.stringify(b)};
    q('[data-cmp="close"]').click();
    await new Promise(r => setTimeout(r, 150));
    return true;`);
}
cards = await evaluate(`return document.querySelectorAll("#grid-others .note").length;`);
cards === 4 ? ok("four consecutive adds all appear") : bad("four consecutive adds all appear", `got ${cards} cards`);

/* ── 4. adding while sync is failing still works ───────────────────── */
const pendingOps = await evaluate(`return window.__keep.outboxSize();`);
pendingOps === 4
  ? ok("failed sync leaves all four notes queued, none lost")
  : bad("failed sync leaves all four notes queued, none lost", `outbox has ${pendingOps}`);

/* ── 5. adding while a search filter is active ─────────────────────── */
await evaluate(`
  const q = (s) => document.querySelector(s);
  q("#search").value = "zzz-no-match";
  q("#search").dispatchEvent(new Event("input"));
  await new Promise(r => setTimeout(r, 200));
  q("#cmp-stub").click();
  await new Promise(r => requestAnimationFrame(r));
  q("#cmp-body").value = "added during search";
  q('[data-cmp="close"]').click();
  await new Promise(r => setTimeout(r, 250));
  return true;`);
const afterSearch = await evaluate(`
  return { cards: document.querySelectorAll(".note").length,
           search: document.querySelector("#search").value,
           total: window.__keep.count() };`);
afterSearch.total === 5 && afterSearch.search === "" && afterSearch.cards === 5
  ? ok("adding while a search is active clears the filter and shows the note")
  : bad("adding while a search is active clears the filter and shows the note", JSON.stringify(afterSearch));

/* ── 6. masonry sanity: no two cards overlap ───────────────────────── */
const overlap = await evaluate(`
  const rs = [...document.querySelectorAll(".note")].map(e => e.getBoundingClientRect());
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 &&
          a.top  < b.bottom - 1 && b.top  < a.bottom - 1) return [i, j];
    }
  return null;`);
overlap === null ? ok("masonry places every card without overlap") : bad("masonry places every card without overlap", `cards ${overlap} overlap`);

/* ── 7. pin moves a note into the Pinned section ───────────────────── */
await evaluate(`
  document.querySelector("#grid-others .note .pin-btn").click();
  await new Promise(r => setTimeout(r, 200));
  return true;`);
const pinned = await evaluate(`
  return { pinned: document.querySelectorAll("#grid-pinned .note").length,
           sectionShown: !document.querySelector("#sec-pinned").hidden };`);
pinned.pinned === 1 && pinned.sectionShown
  ? ok("pinning moves the note into a visible Pinned section")
  : bad("pinning moves the note into a visible Pinned section", JSON.stringify(pinned));

/* ── 8. editor opens, edits, and writes back ───────────────────────── */
await evaluate(`
  document.querySelector("#grid-others .note").click();
  await new Promise(r => setTimeout(r, 350));
  const t = document.querySelector("#ed-title");
  t.value = "Edited title";
  document.querySelector('[data-ed="close"]').click();
  await new Promise(r => setTimeout(r, 400));
  return true;`);
const edited = await evaluate(`
  return { open: !document.querySelector("#editor-scrim").hidden,
           found: window.__keep.titles().includes("Edited title") };`);
edited.found && !edited.open
  ? ok("editor saves the title and closes")
  : bad("editor saves the title and closes", JSON.stringify(edited));

/* ── 9. checklists round-trip through the body column ──────────────── */
await evaluate(`
  const K = window.__keep;
  K.make({ title: "Groceries", body: "[ ] milk\\n[ ] eggs\\n[x] bread" });
  await new Promise(r => setTimeout(r, 250));
  return true;`);
const cl = await evaluate(`
  const card = [...document.querySelectorAll(".note")].find(e => e.textContent.includes("Groceries"));
  return { boxes: card ? card.querySelectorAll(".checklist .cb").length : 0,
           done: card ? card.querySelectorAll(".checklist li.done").length : 0 };`);
cl.boxes === 3 && cl.done === 1
  ? ok("a [ ]/[x] body renders as a real checklist")
  : bad("a [ ]/[x] body renders as a real checklist", JSON.stringify(cl));

await evaluate(`
  const card = [...document.querySelectorAll(".note")].find(e => e.textContent.includes("Groceries"));
  card.querySelector('.checklist .cb[data-i="0"]').click();
  await new Promise(r => setTimeout(r, 250));
  return true;`);
const toggled = await evaluate(`return window.__keep.bodyOf("Groceries");`);
toggled.startsWith("[x] milk")
  ? ok("ticking a checklist item writes back to the note body")
  : bad("ticking a checklist item writes back to the note body", JSON.stringify(toggled));

/* ── 10. trash / restore ───────────────────────────────────────────── */
await evaluate(`
  const K = window.__keep;
  K.trashByTitle("Groceries");
  await new Promise(r => setTimeout(r, 200));
  return true;`);
const trashed = await evaluate(`
  return { inNotes: window.__keep.titles().includes("Groceries"),
           inTrash: window.__keep.trashTitles().includes("Groceries") };`);
!trashed.inNotes && trashed.inTrash
  ? ok("trashing hides the note from Notes and lists it in Trash")
  : bad("trashing hides the note from Notes and lists it in Trash", JSON.stringify(trashed));

/* ── 11. labels ────────────────────────────────────────────────────── */
await evaluate(`
  window.__keep.labelFirst("Errands");
  await new Promise(r => setTimeout(r, 200));
  return true;`);
const labelled = await evaluate(`
  return { nav: [...document.querySelectorAll("#nav-list .nav-item")].map(e => e.textContent.trim()),
           chip: !!document.querySelector(".note .chip") };`);
labelled.nav.includes("Errands") && labelled.chip
  ? ok("adding a label shows a chip and a sidebar entry")
  : bad("adding a label shows a chip and a sidebar entry", JSON.stringify(labelled));

/* ── 12. reload: cache repaints everything without the network ──────── */
await evaluate(`await window.__keep.settle(); return true;`);
await load();
await sleep(600);
const afterReload = await evaluate(`return window.__keep.count();`);
afterReload === 6
  ? ok("notes survive a reload from the local cache")
  : bad("notes survive a reload from the local cache", `count ${afterReload}, expected 6`);

/* ── 13. search finds them ─────────────────────────────────────────── */
await evaluate(`
  const s = document.querySelector("#search");
  s.value = "Edited";
  s.dispatchEvent(new Event("input"));
  await new Promise(r => setTimeout(r, 250));
  return true;`);
const searched = await evaluate(`return document.querySelectorAll(".note").length;`);
searched === 1 ? ok("search narrows the grid") : bad("search narrows the grid", `got ${searched}`);

/* ── 14. nothing blew up ───────────────────────────────────────────── */
const ignorable = (s) =>
  /supabase|Failed to load resource|401|websocket|realtime|net::ERR/i.test(s);
const realErrors = [...consoleErrors, ...pageErrors].filter((e) => !ignorable(e));
realErrors.length === 0
  ? ok("no unexpected console or page errors")
  : bad("no unexpected console or page errors", realErrors.slice(0, 4).join("\n      "));

/* ── report ────────────────────────────────────────────────────────── */
const passed = results.filter(([p]) => p).length;
console.log(`\n${passed}/${results.length} passed\n`);
cleanup();
process.exit(passed === results.length ? 0 : 1);
