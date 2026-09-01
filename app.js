/* ══════════════════════════════════════════════════════════════════════════
   Keep — a local-first note app.

   The rule that makes this feel fast: the network is never on the critical
   path of an interaction. Every mutation is applied to the in-memory model
   and painted immediately; a background outbox pushes it to Supabase and
   retries until it lands. Nothing you do waits for a round trip, and nothing
   you type can be lost by a failed request.
   ══════════════════════════════════════════════════════════════════════════ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://sywglobxvtxayvelhunb.supabase.co";
const SUPABASE_KEY = "sb_publishable_92UpBhuxnldvBH5hXGiy7Q_voxEzcsc";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* Notes live in one flat table with no "trashed" column, and we can't run a
   migration from the browser. A reserved label carries the trash flag instead;
   anything under the `_ck:` namespace is hidden from the UI everywhere. */
const RESERVED = "_ck:";
const TRASH = "_ck:trash";

/* Images.
   Supabase Storage would be the natural home, but a bucket needs RLS policies
   on storage.objects, which can only be created from the dashboard — and the
   app has to work with no setup at all. So an image is just another row in
   `notes`: labelled `_ck:blob`, archived, with the data URL in `body`. The
   owning note points at it with a `_ck:img:<id>:<w>x<h>` label.

   That buys a lot for free: images sync across devices through the same
   table, queue through the same outbox when offline, and are covered by the
   same RLS policy. The cost is that the main pull has to skip these rows, and
   the outbox has to batch by payload size rather than row count. Both below. */
const BLOB_LABEL = "_ck:blob";
const IMG_PREFIX = "_ck:img:";
const MAX_EDGE = 1600;        // longest side, px
const MAX_CHARS = 1_400_000;  // data-URL ceiling per image

const isBlobRow = (n) => (n.labels || []).includes(BLOB_LABEL);
const imgLabel = (id, w, h) => `${IMG_PREFIX}${id}:${w}x${h}`;

/* Dimensions ride along in the label so a card can reserve the right space
   before the image has decoded — no reflow when it arrives. */
function imageRefs(n) {
  const out = [];
  for (const l of n.labels || []) {
    if (!l.startsWith(IMG_PREFIX)) continue;
    const m = l.slice(IMG_PREFIX.length).match(/^([^:]+)(?::(\d+)x(\d+))?$/);
    if (m) out.push({ id: m[1], w: +m[2] || 4, h: +m[3] || 3, label: l });
  }
  return out;
}

const COLORS = [
  ["DEFAULT", "Default"], ["RED", "Coral"], ["ORANGE", "Peach"],
  ["YELLOW", "Sand"], ["GREEN", "Mint"], ["TEAL", "Sage"],
  ["BLUE", "Fog"], ["DARKBLUE", "Storm"], ["PURPLE", "Dusk"],
  ["PINK", "Blossom"], ["BROWN", "Clay"], ["GRAY", "Chalk"],
];

const CARD_MIN = 240;   // narrowest a grid column may get
const GAP = 12;
const PAGE = 60;        // cards painted per scroll chunk
const PULL_CHUNK = 1000;

/* ── tiny helpers ─────────────────────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const raf = (fn) => requestAnimationFrame(fn);
const nowISO = () => new Date().toISOString();
const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

const ICONS = {
  menu: "M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z",
  search: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  grid: "M4 11h5V5H4v6zm0 7h5v-6H4v6zm6 0h5v-6h-5v6zm6 0h5v-6h-5v6zm-6-7h5V5h-5v6zm6-6v6h5V5h-5z",
  list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  refresh: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-8 8s3.57 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  pin: "M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2z",
  pinOff: "M17 4v7l2 3v2h-6v5l-1 1-1-1v-5H5v-2l2-3V4c0-1.1.9-2 2-2h6c1.1 0 2 .9 2 2zm-2 0H9v7.75L7.5 14h9L15 11.75V4z",
  archive: "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z",
  unarchive: "M20.55 5.22l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.15.55L3.46 5.22C3.17 5.57 3 6.01 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.49-.17-.93-.45-1.28zM12 9.5l5.5 5.5H14v2h-4v-2H6.5L12 9.5zM5.12 5l.82-1h12l.93 1H5.12z",
  trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  restore: "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z",
  palette: "M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67 0 1.38-1.12 2.5-2.5 2.5zm-5.5-9c.83 0 1.5-.67 1.5-1.5S7.33 10 6.5 10 5 10.67 5 11.5 5.67 13 6.5 13zm3-4C10.33 9 11 8.33 11 7.5S10.33 6 9.5 6 8 6.67 8 7.5 8.67 9 9.5 9zm5 0c.83 0 1.5-.67 1.5-1.5S15.33 6 14.5 6 13 6.67 13 7.5 13.67 9 14.5 9zm3 4c.83 0 1.5-.67 1.5-1.5S18.33 10 17.5 10s-1.5.67-1.5 1.5.67 1.5 1.5 1.5z",
  label: "M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z",
  labelOff: "M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16zM16 17H5V7h11l3.55 5L16 17z",
  more: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  checked: "M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  unchecked: "M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
  bulb: "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  checkCircle: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  dark: "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z",
  light: "M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 00-1.41 0 .996.996 0 000 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 000-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 000-1.41.996.996 0 00-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z",
  logout: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  keyboard: "M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  image: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
  select: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
};

const svg = (name, cls = "") =>
  `<svg viewBox="0 0 24 24" ${cls ? `class="${cls}"` : ""} aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

/* ── IndexedDB key/value store (localStorage is too small for 4k notes) ─── */
const idb = (() => {
  let p = null;
  const open = () =>
    (p ||= new Promise((res, rej) => {
      const r = indexedDB.open("ckeep", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)).catch(() => {}),
  };
})();

/* ══ State ════════════════════════════════════════════════════════════ */
let USER = null;                       // { id, email }
let notes = [];                        // every note we know about
const byId = new Map();
const outbox = new Map();              // id -> "upsert" | "delete"
const selection = new Set();

const state = {
  view: "notes",                       // notes | archive | trash | label
  label: null,
  search: "",
  limit: PAGE,
  layout: document.documentElement.classList.contains("list-view") ? "list" : "grid",
  theme: localStorage.getItem("keep_theme") || "system",
  navOpen: document.documentElement.classList.contains("nav-open"),
  syncing: false,
  syncError: false,
};

/* ── DOM ──────────────────────────────────────────────────────────────── */
const D = {
  topbar: $("#topbar"), selbar: $("#selbar"), selCount: $("#sel-count"),
  sidebar: $("#sidebar"), navList: $("#nav-list"), scrim: $("#scrim"),
  main: $("#main"), search: $("#search"), searchClear: $("#search-clear"),
  secPinned: $("#sec-pinned"), gridPinned: $("#grid-pinned"),
  secOthers: $("#sec-others"), gridOthers: $("#grid-others"),
  othersLabel: $("#others-label"), sentinel: $("#sentinel"),
  empty: $("#empty"), trashNote: $("#trash-note"),
  composer: $("#composer"), cmpStub: $("#cmp-stub"), cmpTitle: $("#cmp-title"),
  cmpBody: $("#cmp-body"), cmpList: $("#cmp-list"), cmpLabels: $("#cmp-labels"),
  edScrim: $("#editor-scrim"), editor: $("#editor"), edTitle: $("#ed-title"),
  edBody: $("#ed-body"), edList: $("#ed-list"), edLabels: $("#ed-labels"),
  edMeta: $("#ed-meta"), edPin: $("#ed-pin"),
  cmpImages: $("#cmp-images"), edImages: $("#ed-images"),
  fileInput: $("#file-input"), lightbox: $("#lightbox"), dropHint: $("#drop-hint"),
  popover: $("#popover"), snackbar: $("#snackbar"), snackText: $("#snack-text"),
  snackAction: $("#snack-action"), syncPill: $("#sync-pill"), fab: $("#fab"),
  shortcuts: $("#shortcuts"), account: $("#account-btn"),
};

/* ══ Model helpers ════════════════════════════════════════════════════ */
const isTrashed = (n) => n.labels?.includes(TRASH);
const visibleLabels = (n) => (n.labels || []).filter((l) => !l.startsWith(RESERVED));

const reindex = (n) => {
  // A blob row's body is a data URL; indexing it would put megabytes of
  // base64 into the search haystack for nothing.
  n._hay = isBlobRow(n) ? ""
    : ((n.title || "") + "\n" + (n.body || "") + "\n" + visibleLabels(n).join(" ")).toLowerCase();
  return n;
};

const put = (n) => {
  const prev = byId.get(n.id);
  if (prev) { Object.assign(prev, n); return reindex(prev); }
  byId.set(n.id, n);
  notes.push(n);
  return reindex(n);
};

const drop = (id) => {
  if (!byId.has(id)) return;
  byId.delete(id);
  const i = notes.findIndex((n) => n.id === id);
  if (i >= 0) notes.splice(i, 1);
};

/* Every note the current view should show, already sorted. */
function visible() {
  const q = state.search.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : null;
  let out = notes.filter((n) => {
    if (isBlobRow(n)) return false;
    const trashed = isTrashed(n);
    if (terms) {
      if (trashed) return false;
      return terms.every((t) => n._hay.includes(t));
    }
    if (state.view === "trash") return trashed;
    if (trashed) return false;
    if (state.view === "archive") return n.archived;
    if (state.view === "label") return (n.labels || []).includes(state.label);
    return !n.archived;
  });
  out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return out;
}

const allLabels = () => {
  const s = new Set();
  for (const n of notes) for (const l of visibleLabels(n)) s.add(l);
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
};

/* ══ Sync ═════════════════════════════════════════════════════════════ */
const cacheKey = () => `notes_${USER?.id}`;
const outboxKey = () => `outbox_${USER?.id}`;

let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!USER) return;
    idb.set(cacheKey(), notes.map(stripLocal));
    idb.set(outboxKey(), [...outbox.entries()]);
  }, 250);
}
const stripLocal = (n) => { const { _hay, ...rest } = n; return rest; };

function markDirty(id, op = "upsert") {
  if (op === "delete" && outbox.get(id) === "insert") outbox.delete(id);
  else outbox.set(id, op);
  saveLocal();
  flushSoon();
  updateSyncPill();
}

let flushTimer = null;
const flushSoon = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flushNow, 400); };

let flushing = false;
let flushPromise = null;
let syncEpoch = 0;   // bumped whenever a write is confirmed by the server

const flushNow = () => (flushPromise ||= flush().finally(() => { flushPromise = null; }));

async function flush() {
  if (flushing || !USER || !outbox.size) return;
  if (!navigator.onLine) { updateSyncPill(); return; }
  flushing = true;
  state.syncing = true;
  updateSyncPill();

  try {
    const batch = [...outbox.entries()];
    const upserts = [], deletes = [];
    for (const [id, op] of batch) {
      if (op === "delete") deletes.push(id);
      else { const n = byId.get(id); if (n) upserts.push(stripLocal(n)); else outbox.delete(id); }
    }

    // Batch by bytes: 200 rows is nothing for text notes and far too much
    // when several of them carry an image.
    let i = 0;
    while (i < upserts.length) {
      const chunk = [];
      let bytes = 0;
      while (i < upserts.length && chunk.length < 200 && bytes < 3_000_000) {
        const row = upserts[i++];
        chunk.push(row);
        bytes += (row.body ? row.body.length : 0) + 300;
      }
      const { error } = await supabase.from("notes").upsert(chunk, { onConflict: "id" });
      if (error) throw error;
      for (const n of chunk) if (outbox.get(n.id) !== "delete") outbox.delete(n.id);
    }
    for (let i = 0; i < deletes.length; i += 200) {
      const chunk = deletes.slice(i, i + 200);
      const { error } = await supabase.from("notes").delete().in("id", chunk);
      if (error) throw error;
      for (const id of chunk) outbox.delete(id);
    }
    if (upserts.length || deletes.length) syncEpoch++;
    state.syncError = false;
  } catch (e) {
    console.warn("sync failed, will retry", e);
    state.syncError = true;
    setTimeout(flushNow, 5000);
  } finally {
    flushing = false;
    state.syncing = false;
    saveLocal();
    updateSyncPill();
  }
}

/* Full pull. 4k rows is ~2 MB of JSON — a second or two, and the UI is
   already painted from cache, so nobody is looking at a spinner. */
/* Image rows are excluded server-side so the note sync stays small; their
   bodies are fetched on demand instead. If the filter is ever rejected we
   fall back to an unfiltered page rather than failing the whole pull. */
let blobFilter = true;
async function fetchPage(from) {
  let q = supabase.from("notes").select("*").eq("user_id", USER.id);
  if (blobFilter) q = q.not("labels", "cs", '{"_ck:blob"}');
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .range(from, from + PULL_CHUNK - 1);
  if (error) {
    if (blobFilter) {
      console.warn("blob filter rejected, pulling unfiltered", error);
      blobFilter = false;
      return fetchPage(from);
    }
    throw error;
  }
  return data;
}

let pulling = false;
async function pullAll({ quiet = true } = {}) {
  if (!USER || pulling) return;
  pulling = true;
  // Push before pulling, so a note written moments ago is already on the
  // server by the time we ask for the authoritative list.
  if (outbox.size) { try { await flushNow(); } catch {} }
  const fence = syncEpoch;
  if (!quiet) { state.syncing = true; updateSyncPill(); }
  try {
    const rows = [];
    for (let from = 0; ; from += PULL_CHUNK) {
      const data = await fetchPage(from);
      rows.push(...data);
      if (data.length < PULL_CHUNK) break;
    }

    // Server wins, except for notes with unsent local edits.
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.id);
      if (outbox.has(r.id)) continue;
      put(r);
    }
    // Only prune local notes the server didn't return if nothing was written
    // while this request was in flight. Otherwise a note created a moment ago
    // would be missing from `rows` purely because of timing — and deleting it
    // here is exactly the "my new note vanished" bug.
    if (syncEpoch === fence && outbox.size === 0) {
      // Blob rows are filtered out of the pull, so their absence proves nothing.
      for (const n of [...notes]) if (!seen.has(n.id) && !isBlobRow(n)) drop(n.id);
    }
    state.syncError = false;
    saveLocal();
    scheduleRender();
  } catch (e) {
    console.warn("pull failed", e);
    state.syncError = true;
  } finally {
    pulling = false;
    state.syncing = false;
    updateSyncPill();
  }
}

function updateSyncPill() {
  const pending = outbox.size;
  const offline = !navigator.onLine;
  let text = "", cls = "";
  if (offline) { text = pending ? `Offline — ${pending} change${pending > 1 ? "s" : ""} queued` : "Offline"; cls = "offline"; }
  else if (state.syncError && pending) { text = `Retrying ${pending} change${pending > 1 ? "s" : ""}…`; cls = "error"; }
  else if (pending) { text = "Saving…"; }
  if (!text) { D.syncPill.hidden = true; return; }
  D.syncPill.className = cls;
  D.syncPill.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  D.syncPill.hidden = false;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ══ Mutations — local first, always ══════════════════════════════════ */
function createNote({ title = "", body = "", pinned = false, color = "DEFAULT", labels = [], archived = false } = {}) {
  const n = put({
    id: uuid(), user_id: USER.id, title, body, pinned, archived, color,
    labels, source_url: null, google_id: null,
    created_at: nowISO(), updated_at: nowISO(),
  });
  markDirty(n.id, "insert");
  scheduleRender();
  return n;
}

function patch(n, fields) {
  Object.assign(n, fields, { updated_at: nowISO() });
  reindex(n);
  markDirty(n.id);
  scheduleRender();
  return n;
}

const setLabels = (n, labels) => patch(n, { labels: [...new Set(labels)] });
const addLabel = (n, l) => setLabels(n, [...(n.labels || []), l]);
const removeLabel = (n, l) => setLabels(n, (n.labels || []).filter((x) => x !== l));

const trash = (n) => patch(n, { labels: [...new Set([...(n.labels || []), TRASH])] });
const untrash = (n) => patch(n, { labels: (n.labels || []).filter((l) => l !== TRASH) });

function destroy(n) {
  drop(n.id);
  markDirty(n.id, "delete");
  scheduleRender();
}

/* Permanent deletion has to take the note's image rows with it, otherwise
   they linger in the table forever with nothing pointing at them. */
function destroyDeep(n) {
  const removed = [{ ...n }];
  for (const ref of imageRefs(n)) {
    const blob = byId.get(ref.id);
    if (blob) { removed.push({ ...blob }); drop(blob.id); markDirty(blob.id, "delete"); }
  }
  drop(n.id);
  markDirty(n.id, "delete");
  scheduleRender();
  return removed;
}

function restoreDeep(rows) {
  for (const r of rows) { put(r); markDirty(r.id, "insert"); }
  scheduleRender();
}

/* ══ Checklists ═══════════════════════════════════════════════════════
   Stored inside `body` as "[ ] item" / "[x] item" lines — the same shape
   import_takeout.py writes, so Keep imports light up as real checklists. */
const CL_RE = /^\s*\[([ xX])\]\s?(.*)$/;

function parseChecklist(body) {
  if (!body) return null;
  const lines = body.split("\n");
  const items = [];
  let matched = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(CL_RE);
    if (!m) return null;
    matched++;
    items.push({ checked: m[1].toLowerCase() === "x", text: m[2] });
  }
  return matched ? items : null;
}

const serializeChecklist = (items) =>
  items.map((i) => `[${i.checked ? "x" : " "}] ${i.text}`).join("\n");

const textToItems = (body) =>
  (body || "").split("\n").filter((l) => l.trim()).map((l) => ({ checked: false, text: l.trim() }));

const itemsToText = (items) => items.map((i) => i.text).join("\n");

/* Text still sitting in the trailing "List item" input hasn't been committed
   to the items array yet. Saving with ⌘+Enter beats the input's blur, so pull
   it out explicitly rather than silently dropping what was typed. */
function drainPending(ul, items) {
  const inp = ul && $(".check-add input", ul);
  const v = inp?.value.trim();
  if (v) { items.push({ checked: false, text: v }); inp.value = ""; }
}

/* ══ Images ═══════════════════════════════════════════════════════════ */

/* Downscale and re-encode before storing. Phone photos are several megabytes
   and none of that survives being shown in a 300px card. JPEG on white,
   because a transparent PNG re-encoded to JPEG otherwise comes out black. */
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const fit = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  let w = Math.max(1, Math.round(bmp.width * fit));
  let h = Math.max(1, Math.round(bmp.height * fit));

  const encode = (cw, ch, q) => {
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    return c.toDataURL("image/jpeg", q);
  };

  let q = 0.82;
  let url = encode(w, h, q);
  while (url.length > MAX_CHARS && (q > 0.4 || w > 400)) {
    if (q > 0.4) q -= 0.15;
    else { w = Math.round(w * 0.75); h = Math.round(h * 0.75); q = 0.7; }
    url = encode(w, h, q);
  }
  bmp.close?.();
  return { dataUrl: url, w, h };
}

/* Attach files to an existing note, or to the composer if none is given. */
async function addImages(files, note) {
  const pics = [...files].filter((f) => f.type.startsWith("image/"));
  if (!pics.length || !USER) return;

  let failed = 0;
  for (const file of pics) {
    let out;
    try {
      out = await compressImage(file);
    } catch {
      failed++;
      continue;
    }
    const id = uuid();
    put({
      id, user_id: USER.id,
      title: (file.name || "image").slice(0, 120),
      body: out.dataUrl,
      pinned: false, archived: true, color: "DEFAULT",
      labels: [BLOB_LABEL], source_url: null, google_id: null,
      created_at: nowISO(), updated_at: nowISO(),
    });
    markDirty(id, "insert");

    const label = imgLabel(id, out.w, out.h);
    if (note) addLabel(note, label);
    else { cmp.images.push(label); renderCmpImages(); }
  }

  if (failed) snack(`Couldn't read ${failed} file${failed > 1 ? "s" : ""}`);
  if (note && edNote === note) renderEdImages();
  scheduleRender();
}

/* Blob rows normally arrive with the cache. One that hasn't (added on another
   device) is fetched once and then lives in the model like any other note. */
const imgPending = new Set();
function getImage(id) {
  const row = byId.get(id);
  if (row?.body) return row.body;
  if (imgPending.has(id) || !USER || !navigator.onLine) return null;
  imgPending.add(id);
  supabase.from("notes").select("*").eq("id", id).maybeSingle()
    .then(({ data }) => { if (data) { put(data); saveLocal(); scheduleRender(); } })
    .catch(() => {})
    .finally(() => imgPending.delete(id));
  return null;
}

function detachImage(label, note) {
  const ref = imageRefs({ labels: [label] })[0];
  if (note) removeLabel(note, label);
  else cmp.images = cmp.images.filter((l) => l !== label);
  const blob = ref && byId.get(ref.id);
  if (blob) { drop(blob.id); markDirty(blob.id, "delete"); }
  scheduleRender();
}

/* Markup only — the actual pixels are attached in hydrateImages, so a data URL
   never has to be serialised into an innerHTML string. */
function thumbsMarkup(refs, { edit = false } = {}) {
  if (!refs.length) return "";
  const shown = edit ? refs : refs.slice(0, 4);
  const multi = !edit && shown.length > 1;
  const extra = refs.length - shown.length;
  return `<div class="thumbs${multi ? " multi" : ""}${edit ? " edit" : ""}">${
    shown.map((r, i) => {
      const ratio = multi ? "" : ` style="aspect-ratio:${r.w}/${r.h}"`;
      const badge = !edit && extra > 0 && i === shown.length - 1
        ? `<span class="more-badge">+${extra + 1}</span>` : "";
      const rm = edit
        ? `<button class="rm-img" data-rmimg="${esc(r.label)}" title="Remove image">${svg("close")}</button>` : "";
      return `<div class="thumb" data-img="${esc(r.id)}"${ratio}>${badge}${rm}</div>`;
    }).join("")}</div>`;
}

function hydrateImages(root) {
  for (const t of $$(".thumb[data-img]", root)) {
    if (t.querySelector("img")) continue;
    const src = getImage(t.dataset.img);
    if (!src) continue;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("load", () => relayout(), { once: true });
    img.src = src;
    t.prepend(img);
  }
}

function renderEdImages() {
  if (!edNote) return;
  const refs = imageRefs(edNote);
  D.edImages.innerHTML = thumbsMarkup(refs, { edit: true });
  D.edImages.hidden = !refs.length;
  hydrateImages(D.edImages);
}

function renderCmpImages() {
  const refs = imageRefs({ labels: cmp.images });
  D.cmpImages.innerHTML = thumbsMarkup(refs, { edit: true });
  D.cmpImages.hidden = !refs.length;
  hydrateImages(D.cmpImages);
}

/* File picker is shared; the caller decides where the result lands. */
let pickTarget = null;
function pickImages(note) {
  pickTarget = note || null;
  D.fileInput.value = "";
  D.fileInput.click();
}

function openLightbox(id) {
  const src = getImage(id);
  if (!src) return;
  D.lightbox.innerHTML = `<button class="lb-close" title="Close">${svg("close")}</button><img alt="">`;
  $("img", D.lightbox).src = src;
  D.lightbox.hidden = false;
}
const closeLightbox = () => { D.lightbox.hidden = true; D.lightbox.innerHTML = ""; };

/* ══ Rendering ════════════════════════════════════════════════════════ */
const cards = new Map();   // note id -> element
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  raf(() => { renderQueued = false; render(); });
}

function render() {
  const list = visible();
  const shown = list.slice(0, state.limit);
  const pinned = [], others = [];
  const groupPins = state.view === "notes" || state.view === "label";
  for (const n of shown) (groupPins && n.pinned ? pinned : others).push(n);

  // Retire cards that left the view
  const live = new Set(shown.map((n) => n.id));
  for (const [id, el] of cards) {
    if (!live.has(id)) { el.remove(); cards.delete(id); }
  }

  fillGrid(D.gridPinned, pinned);
  fillGrid(D.gridOthers, others);

  D.secPinned.hidden = pinned.length === 0;
  D.othersLabel.hidden = pinned.length === 0 || others.length === 0;
  D.secOthers.hidden = others.length === 0;

  const isEmpty = list.length === 0;
  D.empty.hidden = !isEmpty;
  if (isEmpty) renderEmpty();
  D.trashNote.hidden = state.view !== "trash" || list.length === 0;
  D.sentinel.style.height = "1px";
  D.sentinel.dataset.more = list.length > shown.length ? "1" : "";

  // Synchronous, deliberately: deferring this to a rAF leaves one frame where
  // the cards are in the DOM but still stacked at the grid origin at their
  // shrink-to-fit widths, which is visible as a flash of jumbled cards.
  layoutNow();
  renderNav();
  maybeLoadMore();

  if (document.documentElement.classList.contains("booting")) {
    raf(() => raf(() => document.documentElement.classList.remove("booting")));
  }
}

function fillGrid(grid, list) {
  let prev = null;
  for (const n of list) {
    let el = cards.get(n.id);
    if (!el) {
      el = buildCard(n);
      el.classList.add("no-anim");
      cards.set(n.id, el);
      raf(() => raf(() => el.classList.remove("no-anim")));
    } else {
      updateCard(el, n);
    }
    // insertBefore keeps DOM order == layout order without churn
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (el.parentNode !== grid || el !== want) grid.insertBefore(el, want);
    prev = el;
  }
}

function cardMarkup(n) {
  const items = parseChecklist(n.body);
  const labels = visibleLabels(n);
  const trashed = isTrashed(n);
  let bodyHtml = "";

  if (items) {
    const open = items.filter((i) => !i.checked);
    const done = items.filter((i) => i.checked);
    const show = [...open, ...done].slice(0, 10);
    bodyHtml = `<ul class="checklist">${show.map((i) => {
      const idx = items.indexOf(i);
      return `<li class="${i.checked ? "done" : ""}">
        <span class="cb" data-act="check" data-i="${idx}">${svg(i.checked ? "checked" : "unchecked")}</span>
        <span class="txt">${esc(i.text)}</span></li>`;
    }).join("")}</ul>${items.length > show.length
      ? `<div class="note-more">+ ${items.length - show.length} more</div>` : ""}`;
  } else if (n.body) {
    bodyHtml = `<div class="note-body">${esc(n.body)}</div>`;
  }

  const actions = trashed
    ? `<button class="icon-btn" data-act="restore" title="Restore">${svg("restore")}</button>
       <button class="icon-btn" data-act="destroy" title="Delete forever">${svg("trash")}</button>`
    : `<button class="icon-btn" data-act="color" title="Background options">${svg("palette")}</button>
       <button class="icon-btn" data-act="label" title="Labels">${svg("labelOff")}</button>
       <button class="icon-btn" data-act="archive" title="${n.archived ? "Unarchive" : "Archive"}">${svg(n.archived ? "unarchive" : "archive")}</button>
       <button class="icon-btn" data-act="more" title="More">${svg("more")}</button>`;

  return `
    <button class="sel-btn" data-act="select" title="Select note">${svg("check")}</button>
    ${trashed ? "" : `<button class="pin-btn" data-act="pin" title="${n.pinned ? "Unpin" : "Pin"}">${svg(n.pinned ? "pin" : "pinOff")}</button>`}
    ${thumbsMarkup(imageRefs(n))}
    ${n.title ? `<h3 class="note-title">${esc(n.title)}</h3>` : ""}
    ${bodyHtml}
    ${n.source_url ? `<a class="note-src" href="${esc(n.source_url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(n.source_url))}</a>` : ""}
    ${labels.length ? `<div class="chips">${labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>` : ""}
    ${trashed ? `<div class="note-meta">Trashed ${fmtDate(n.updated_at)}</div>` : ""}
    <div class="note-actions">${actions}</div>`;
}

function buildCard(n) {
  const el = document.createElement("article");
  el.className = "note";
  el.dataset.id = n.id;
  el.dataset.color = n.color || "DEFAULT";
  el.tabIndex = 0;
  el.innerHTML = cardMarkup(n);
  hydrateImages(el);
  el._sig = cardSig(n);
  el.classList.toggle("pinned", !!n.pinned);
  el.classList.toggle("selected", selection.has(n.id));
  return el;
}

const cardSig = (n) => JSON.stringify(
  [n.title, n.body, n.labels, n.color, n.pinned, n.archived, n.source_url, n.updated_at]);

function updateCard(el, n) {
  const sig = cardSig(n);
  if (el._sig !== sig) {
    el._sig = sig;
    el.innerHTML = cardMarkup(n);
    hydrateImages(el);
    el.dataset.color = n.color || "DEFAULT";
  }
  el.classList.toggle("pinned", !!n.pinned);
  el.classList.toggle("selected", selection.has(n.id));
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function renderEmpty() {
  const map = {
    notes: ["bulb", "Notes you add appear here", "Press <kbd>c</kbd> to write one"],
    archive: ["archive", "Your archived notes appear here", ""],
    trash: ["trash", "No notes in Trash", ""],
    label: ["label", "No notes with this label yet", ""],
  };
  const [icon, title, sub] = state.search
    ? ["search", "No matching notes", "Try a different search"]
    : map[state.view] || map.notes;
  D.empty.innerHTML = `${svg(icon)}<p>${title}</p>${sub ? `<small>${sub}</small>` : ""}`;
}

/* ── Masonry: shortest-column placement, transform-positioned so that
      every reflow animates instead of jumping. ────────────────────────── */
function layoutGrid(grid) {
  const kids = [...grid.children];
  if (!kids.length) { grid.style.height = "0px"; return; }
  const W = grid.clientWidth;
  if (!W) return;

  const cols = state.layout === "list" ? 1 : Math.max(1, Math.floor((W + GAP) / (CARD_MIN + GAP)));
  const colW = state.layout === "list"
    ? Math.min(W, 600)
    : (W - GAP * (cols - 1)) / cols;
  const offset = state.layout === "list" ? Math.max(0, (W - colW) / 2) : 0;

  for (const el of kids) el.style.width = colW + "px";
  const heights = kids.map((el) => el.offsetHeight);

  const colH = new Array(cols).fill(0);
  kids.forEach((el, i) => {
    let c = 0;
    for (let j = 1; j < cols; j++) if (colH[j] < colH[c] - 0.5) c = j;
    const x = offset + c * (colW + GAP);
    const y = colH[c];
    el.style.setProperty("--tx", x + "px");
    el.style.setProperty("--ty", y + "px");
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    colH[c] = y + heights[i] + GAP;
  });
  grid.style.height = Math.max(...colH) + "px";
  // keep the section heading aligned with the first column
  grid.parentElement?.style.setProperty("--pad", offset + "px");
  grid.classList.add("laid-out");
}

function layoutNow() {
  layoutGrid(D.gridPinned);
  layoutGrid(D.gridOthers);
}

let layoutQueued = false;
function relayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  raf(() => {
    layoutQueued = false;
    layoutNow();
    maybeLoadMore();
  });
}

/* Paint another chunk while the end of the list is still within reach. Runs
   after layout, so it settles on its own once the page is tall enough. */
function maybeLoadMore() {
  if (!D.sentinel.dataset.more) return;
  const r = D.sentinel.getBoundingClientRect();
  if (r.top > window.innerHeight + 600) return;
  state.limit += PAGE;
  scheduleRender();
}

/* ══ Note actions from a card ═════════════════════════════════════════ */
function onGridClick(e) {
  const card = e.target.closest(".note");
  if (!card) return;
  const n = byId.get(card.dataset.id);
  if (!n) return;
  const hit = e.target.closest("[data-act]");
  const act = hit?.dataset.act;

  if (e.target.closest("a")) return;

  const thumb = e.target.closest(".thumb[data-img]");
  if (thumb && !selection.size) { e.stopPropagation(); openLightbox(thumb.dataset.img); return; }

  if (act === "select") { e.stopPropagation(); toggleSelect(n, card); return; }
  if (selection.size) { toggleSelect(n, card); return; }

  switch (act) {
    case "pin":
      e.stopPropagation();
      patch(n, { pinned: !n.pinned });
      return;
    case "check": {
      e.stopPropagation();
      const items = parseChecklist(n.body);
      const i = +hit.dataset.i;
      if (items && items[i]) {
        items[i].checked = !items[i].checked;
        patch(n, { body: serializeChecklist(items) });
      }
      return;
    }
    case "color": e.stopPropagation(); colorPopover(hit, [n]); return;
    case "label": e.stopPropagation(); labelPopover(hit, [n]); return;
    case "archive":
      e.stopPropagation();
      patch(n, { archived: !n.archived });
      snack(n.archived ? "Note archived" : "Note unarchived", () => patch(n, { archived: !n.archived }));
      return;
    case "restore":
      e.stopPropagation();
      untrash(n);
      snack("Note restored", () => trash(n));
      return;
    case "destroy":
      e.stopPropagation();
      { const removed = destroyDeep(n);
        snack("Note deleted forever", () => restoreDeep(removed)); }
      return;
    case "more": e.stopPropagation(); noteMenu(hit, n); return;
  }

  openEditor(n, card);
}

function noteMenu(anchor, n) {
  const rows = [
    ["trash", "Delete note", () => {
      trash(n);
      snack("Note moved to Trash", () => untrash(n));
    }],
    ["copy", "Make a copy", () => {
      const c = createNote({
        title: n.title, body: n.body, color: n.color,
        labels: visibleLabels(n), pinned: false,
      });
      snack("Copy created", () => destroy(c));
    }],
    ["label", "Add label", () => labelPopover(anchor, [n])],
    ["download", "Copy note text", async () => {
      const text = [n.title, n.body].filter(Boolean).join("\n\n");
      try { await navigator.clipboard.writeText(text); snack("Copied to clipboard"); }
      catch { snack("Couldn't access the clipboard"); }
    }],
  ];
  openPopover(anchor, menuEl(rows));
}

function menuEl(rows) {
  const el = document.createElement("div");
  el.className = "menu";
  for (const [icon, label, fn, danger] of rows) {
    const b = document.createElement("button");
    if (danger) b.className = "danger";
    b.innerHTML = `${svg(icon)}<span>${esc(label)}</span>`;
    b.onclick = () => { closePopover(); fn(); };
    el.appendChild(b);
  }
  return el;
}

/* ══ Selection ════════════════════════════════════════════════════════ */
function toggleSelect(n, card) {
  if (selection.has(n.id)) selection.delete(n.id);
  else selection.add(n.id);
  card.classList.toggle("selected", selection.has(n.id));
  syncSelBar();
}

function clearSelection() {
  for (const id of selection) cards.get(id)?.classList.remove("selected");
  selection.clear();
  syncSelBar();
}

function syncSelBar() {
  const n = selection.size;
  document.body.classList.toggle("has-selection", n > 0);
  D.selbar.hidden = n === 0;
  D.selCount.textContent = `${n} selected`;
}

const selectedNotes = () => [...selection].map((id) => byId.get(id)).filter(Boolean);

/* ══ Composer ═════════════════════════════════════════════════════════ */
const cmp = { open: false, color: "DEFAULT", labels: [], images: [], pinned: false, list: false, items: [] };

function openComposer(listMode = false) {
  cmp.open = true;
  cmp.list = listMode;
  cmp.items = listMode ? [{ checked: false, text: "" }] : [];
  renderCmpImages();
  D.composer.classList.remove("collapsed");
  applyCmpChrome();
  renderCmpList();
  raf(() => { (listMode ? $(".txt", D.cmpList) : D.cmpBody)?.focus(); });
}

function applyCmpChrome() {
  D.composer.dataset.color = cmp.color;
  D.cmpLabels.innerHTML = cmp.labels
    .map((l) => `<span class="chip">${esc(l)}<span class="x" data-rm="${esc(l)}">${svg("close")}</span></span>`).join("");
  D.cmpLabels.hidden = !cmp.labels.length;
  $('[data-cmp="pin"]', D.composer).classList.toggle("on", cmp.pinned);
  $('[data-cmp="pin"]', D.composer).innerHTML = svg(cmp.pinned ? "pin" : "pinOff");
  D.cmpBody.hidden = cmp.list;
  D.cmpList.hidden = !cmp.list;
}

function renderCmpList() {
  if (!cmp.list) return;
  renderEditableList(D.cmpList, cmp.items, () => {});
}

function closeComposer(save = true) {
  if (!cmp.open) return;
  const title = D.cmpTitle.value.trim();
  let body;
  if (cmp.list) {
    drainPending(D.cmpList, cmp.items);
    const items = cmp.items.filter((i) => i.text.trim());
    body = items.length ? serializeChecklist(items) : "";
  } else {
    body = D.cmpBody.value.trim();
  }

  if (save && (title || body || cmp.images.length)) {
    const labels = [...cmp.labels, ...cmp.images];
    // Composing inside a label view files the note under that label, like Keep.
    if (state.view === "label" && state.label && !labels.includes(state.label)) labels.push(state.label);
    createNote({ title, body, pinned: cmp.pinned, color: cmp.color, labels });
    // A new note that lands outside the current filter would look like it was
    // swallowed, so drop back to a view that actually contains it.
    if (state.search) go(state.view === "label" ? "label" : "notes", state.label);
    else if (state.view !== "notes" && state.view !== "label") go("notes");
  }

  // Anything not saved leaves its blob rows orphaned; drop them.
  if (!save || !(title || body || cmp.images.length)) {
    for (const l of cmp.images) {
      const ref = imageRefs({ labels: [l] })[0];
      const blob = ref && byId.get(ref.id);
      if (blob) { drop(blob.id); markDirty(blob.id, "delete"); }
    }
  }
  cmp.open = false; cmp.color = "DEFAULT"; cmp.labels = []; cmp.images = []; cmp.pinned = false;
  cmp.list = false; cmp.items = [];
  renderCmpImages();
  D.cmpTitle.value = ""; D.cmpBody.value = "";
  autoGrow(D.cmpBody);
  D.composer.classList.add("collapsed");
  applyCmpChrome();
}

/* ══ Editor ═══════════════════════════════════════════════════════════ */
let edNote = null, edFrom = null, edItems = null, edClosing = false;

function openEditor(n, fromEl) {
  if (edNote) return;
  edNote = n;
  edFrom = fromEl || null;
  edItems = parseChecklist(n.body);

  D.editor.dataset.color = n.color || "DEFAULT";
  D.edTitle.value = n.title || "";
  D.edBody.value = edItems ? "" : (n.body || "");
  D.edBody.hidden = !!edItems;
  D.edList.hidden = !edItems;
  D.edPin.innerHTML = svg(n.pinned ? "pin" : "pinOff");
  D.edPin.classList.toggle("on", !!n.pinned);
  $('[data-ed="archive"]').innerHTML = svg(n.archived ? "unarchive" : "archive");
  $('[data-ed="archive"]').title = n.archived ? "Unarchive" : "Archive";
  D.edMeta.textContent = "Edited " + fmtDate(n.updated_at || n.created_at);
  renderEdLabels();
  renderEdImages();
  if (edItems) renderEditableList(D.edList, edItems, commitEditorList);

  D.edScrim.hidden = false;
  autoGrow(D.edBody);

  const r2 = D.editor.getBoundingClientRect();
  if (edFrom) {
    const r1 = edFrom.getBoundingClientRect();
    const sx = Math.max(r1.width / r2.width, 0.15);
    const sy = Math.max(r1.height / r2.height, 0.15);
    D.editor.style.transition = "none";
    D.editor.style.opacity = "0";
    D.editor.style.transform =
      `translate(${r1.left - r2.left}px, ${r1.top - r2.top}px) scale(${sx}, ${sy})`;
    edFrom.classList.add("editing-source");
    raf(() => {
      D.editor.style.transition =
        "transform .22s cubic-bezier(.2,0,.2,1), opacity .16s cubic-bezier(.2,0,.2,1)";
      D.editor.style.transform = "none";
      D.editor.style.opacity = "1";
    });
  }
  raf(() => D.edScrim.classList.add("in"));
  raf(() => { if (!edItems) D.edBody.focus({ preventScroll: true }); });
}

function commitEditor() {
  if (!edNote) return;
  const title = D.edTitle.value.trim();
  if (edItems) drainPending(D.edList, edItems);
  const body = edItems
    ? serializeChecklist(edItems.filter((i) => i.text.trim()))
    : D.edBody.value.trim();
  if (title !== (edNote.title || "") || body !== (edNote.body || "")) {
    patch(edNote, { title, body });
  }
}
const commitEditorList = () => { if (edNote && edItems) commitEditor(); };

function closeEditor() {
  if (!edNote || edClosing) return;
  edClosing = true;
  commitEditor();

  const n = edNote;
  const back = cards.get(n.id) || edFrom;
  const r2 = D.editor.getBoundingClientRect();

  const finish = () => {
    D.edScrim.hidden = true;
    D.editor.style.transition = "none";
    D.editor.style.transform = "none";
    D.editor.style.opacity = "1";
    edFrom?.classList.remove("editing-source");
    cards.get(n.id)?.classList.remove("editing-source");
    edNote = null; edFrom = null; edItems = null; edClosing = false;
  };

  D.edScrim.classList.remove("in");
  if (back && back.isConnected) {
    const r1 = back.getBoundingClientRect();
    const sx = Math.max(r1.width / r2.width, 0.15);
    const sy = Math.max(r1.height / r2.height, 0.15);
    D.editor.style.transition =
      "transform .2s cubic-bezier(.2,0,.2,1), opacity .18s cubic-bezier(.2,0,.2,1)";
    D.editor.style.transform =
      `translate(${r1.left - r2.left}px, ${r1.top - r2.top}px) scale(${sx}, ${sy})`;
    D.editor.style.opacity = "0";
    setTimeout(finish, 210);
  } else {
    setTimeout(finish, 180);
  }
}

function renderEdLabels() {
  if (!edNote) return;
  const labels = visibleLabels(edNote);
  D.edLabels.innerHTML = labels
    .map((l) => `<span class="chip">${esc(l)}<span class="x" data-rm="${esc(l)}">${svg("close")}</span></span>`).join("");
  D.edLabels.hidden = !labels.length;
}

/* ── Editable checklist shared by composer and editor ─────────────────── */
function renderEditableList(ul, items, onChange) {
  ul.innerHTML = "";
  const open = [], done = [];
  items.forEach((it, i) => (it.checked ? done : open).push(i));

  const row = (i) => {
    const it = items[i];
    const li = document.createElement("li");
    li.className = it.checked ? "done" : "";
    li.innerHTML = `<span class="cb">${svg(it.checked ? "checked" : "unchecked")}</span>
      <textarea class="txt" rows="1" placeholder="List item"></textarea>
      <button class="icon-btn rm" title="Delete item">${svg("close")}</button>`;
    const ta = $(".txt", li);
    ta.value = it.text;
    raf(() => autoGrow(ta));

    ta.addEventListener("input", () => { it.text = ta.value; autoGrow(ta); relayout(); });
    ta.addEventListener("blur", () => onChange());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const at = items.indexOf(it) + 1;
        items.splice(at, 0, { checked: false, text: "" });
        onChange();
        renderEditableList(ul, items, onChange);
        raf(() => $$(".txt", ul)[Math.min(at, items.length - 1)]?.focus());
      } else if (e.key === "Backspace" && !ta.value && items.length > 1) {
        e.preventDefault();
        const at = items.indexOf(it);
        items.splice(at, 1);
        onChange();
        renderEditableList(ul, items, onChange);
        raf(() => { const t = $$(".txt", ul)[Math.max(0, at - 1)]; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } });
      }
    });
    $(".cb", li).onclick = () => {
      it.checked = !it.checked;
      onChange();
      renderEditableList(ul, items, onChange);
    };
    $(".rm", li).onclick = () => {
      items.splice(items.indexOf(it), 1);
      if (!items.length) items.push({ checked: false, text: "" });
      onChange();
      renderEditableList(ul, items, onChange);
    };
    return li;
  };

  for (const i of open) ul.appendChild(row(i));

  const add = document.createElement("li");
  add.className = "check-add";
  add.innerHTML = `${svg("add")}<input placeholder="List item" />`;
  const inp = $("input", add);
  // Refocus only when the user pressed Enter. On blur we still keep the text,
  // but stealing focus back would make it impossible to click anything else.
  const push = (refocus) => {
    const v = inp.value.trim();
    if (!v) return;
    items.push({ checked: false, text: v });
    inp.value = "";
    onChange();
    renderEditableList(ul, items, onChange);
    if (refocus) raf(() => $(".check-add input", ul)?.focus());
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); push(true); } });
  inp.addEventListener("blur", () => push(false));
  ul.appendChild(add);

  if (done.length) {
    const sep = document.createElement("li");
    sep.className = "check-sep";
    sep.innerHTML = `${svg("check")}<span>${done.length} checked item${done.length > 1 ? "s" : ""}</span>`;
    ul.appendChild(sep);
    for (const i of done) ul.appendChild(row(i));
  }
  relayout();
}

/* ══ Popovers ═════════════════════════════════════════════════════════ */
let popCloser = null;

function openPopover(anchor, content) {
  closePopover();
  D.popover.innerHTML = "";
  D.popover.appendChild(content);
  D.popover.hidden = false;

  const r = anchor.getBoundingClientRect();
  const w = D.popover.offsetWidth, h = D.popover.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  D.popover.style.left = Math.max(8, left) + "px";
  D.popover.style.top = top + "px";

  popCloser = (e) => {
    if (D.popover.contains(e.target) || anchor.contains(e.target)) return;
    closePopover();
  };
  setTimeout(() => document.addEventListener("mousedown", popCloser), 0);
}

function closePopover() {
  if (popCloser) document.removeEventListener("mousedown", popCloser);
  popCloser = null;
  D.popover.hidden = true;
  D.popover.innerHTML = "";
}

function colorPopover(anchor, targets, onPick, currentOverride) {
  const wrap = document.createElement("div");
  wrap.className = "swatches";
  const current = currentOverride ?? (targets.length === 1 ? targets[0].color : null);
  for (const [key, name] of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch" + (key === current ? " on" : "");
    b.dataset.color = key;
    b.title = name;
    if (key === "DEFAULT") b.innerHTML = svg("palette");
    b.onclick = () => {
      closePopover();
      if (onPick) onPick(key);
      else for (const n of targets) patch(n, { color: key });
    };
    wrap.appendChild(b);
  }
  openPopover(anchor, wrap);
}

function labelPopover(anchor, targets, onToggle) {
  const wrap = document.createElement("div");
  wrap.className = "label-pop";
  wrap.innerHTML = `<h4>Label note</h4><div class="lp-search"><input placeholder="Enter label name" /></div><div class="lp-list"></div>`;
  const input = $("input", wrap);
  const list = $(".lp-list", wrap);

  const has = (l) => targets.length && targets.every((n) => (n.labels || []).includes(l));

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const opts = allLabels().filter((l) => l.toLowerCase().includes(q));
    list.innerHTML = "";
    for (const l of opts) {
      const b = document.createElement("button");
      b.className = "lp-row";
      b.innerHTML = `${svg(has(l) ? "checked" : "unchecked")}<span>${esc(l)}</span>`;
      b.onclick = () => {
        const on = has(l);
        if (onToggle) onToggle(l, !on);
        else for (const n of targets) (on ? removeLabel : addLabel)(n, l);
        renderEdLabels(); applyCmpChrome();
        draw();
      };
      list.appendChild(b);
    }
    const exact = input.value.trim();
    if (exact && !opts.some((l) => l.toLowerCase() === exact.toLowerCase())) {
      const b = document.createElement("button");
      b.className = "lp-row";
      b.innerHTML = `${svg("add")}<span>Create "${esc(exact)}"</span>`;
      b.onclick = () => {
        if (onToggle) onToggle(exact, true);
        else for (const n of targets) addLabel(n, exact);
        input.value = "";
        renderEdLabels(); applyCmpChrome();
        draw(); renderNav();
      };
      list.appendChild(b);
    }
  };

  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $(".lp-row:last-child", list)?.click(); } });
  draw();
  openPopover(anchor, wrap);
  raf(() => input.focus());
}

/* ══ Snackbar ═════════════════════════════════════════════════════════ */
let snackTimer = null;
function snack(text, undo) {
  clearTimeout(snackTimer);
  D.snackText.textContent = text;
  D.snackAction.hidden = !undo;
  D.snackAction.textContent = "Undo";
  D.snackAction.onclick = () => { hideSnack(); undo?.(); };
  D.snackbar.hidden = false;
  raf(() => D.snackbar.classList.add("in"));
  snackTimer = setTimeout(hideSnack, undo ? 6000 : 3000);
}
function hideSnack() {
  clearTimeout(snackTimer);
  D.snackbar.classList.remove("in");
  setTimeout(() => { if (!D.snackbar.classList.contains("in")) D.snackbar.hidden = true; }, 250);
}

/* ══ Navigation ═══════════════════════════════════════════════════════ */
function renderNav() {
  const labels = allLabels();
  const rows = [];
  rows.push({ icon: "bulb", text: "Notes", view: "notes" });
  if (labels.length) rows.push({ sep: true });
  for (const l of labels) rows.push({ icon: "label", text: l, view: "label", label: l });
  rows.push({ icon: "edit", text: "Edit labels", action: "edit-labels" });
  rows.push({ sep: true });
  rows.push({ icon: "archive", text: "Archive", view: "archive" });
  rows.push({ icon: "trash", text: "Trash", view: "trash" });

  const html = rows.map((r) => {
    if (r.sep) return `<div class="nav-sep"></div>`;
    const active = !r.action && r.view === state.view && (r.view !== "label" || r.label === state.label);
    return `<button class="nav-item${active ? " active" : ""}" data-view="${r.view || ""}" data-label="${esc(r.label || "")}" data-action="${r.action || ""}">
      ${svg(r.icon)}<span>${esc(r.text)}</span></button>`;
  }).join("");

  if (D.navList.innerHTML !== html) D.navList.innerHTML = html;
}

function go(view, label = null) {
  state.view = view;
  state.label = label;
  state.limit = PAGE;
  clearSelection();
  if (state.search) { state.search = ""; D.search.value = ""; D.searchClear.hidden = true; }
  document.title = view === "label" ? `${label} — Keep`
    : view === "notes" ? "Keep"
    : `${view[0].toUpperCase()}${view.slice(1)} — Keep`;
  D.composer.parentElement.hidden = view !== "notes" && view !== "label";
  window.scrollTo({ top: 0 });
  if (window.innerWidth < 900) setNav(false);
  scheduleRender();
}

const setNav = (open) => {
  state.navOpen = open;
  document.documentElement.classList.toggle("nav-open", open);
  try { localStorage.setItem("keep_nav", open ? "1" : "0"); } catch {}
  relayout();
};

/* ══ Label manager ════════════════════════════════════════════════════ */
function labelManager(anchor) {
  const wrap = document.createElement("div");
  wrap.className = "label-pop";
  wrap.style.width = "290px";
  wrap.innerHTML = `<h4>Edit labels</h4><div class="lp-list"></div>`;
  const list = $(".lp-list", wrap);

  const draw = () => {
    list.innerHTML = "";
    const labels = allLabels();
    if (!labels.length) {
      list.innerHTML = `<div class="lp-row" style="color:var(--fg-2)">No labels yet</div>`;
    }
    for (const l of labels) {
      const row = document.createElement("div");
      row.className = "lp-row";
      row.innerHTML = `${svg("label")}<span style="flex:1">${esc(l)}</span>
        <button class="icon-btn" title="Rename" style="width:28px;height:28px">${svg("edit")}</button>
        <button class="icon-btn" title="Delete label" style="width:28px;height:28px">${svg("trash")}</button>`;
      const [renameBtn, delBtn] = $$("button", row);
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        const inp = document.createElement("input");
        inp.value = l;
        inp.style.cssText = "flex:1;min-width:0;border:none;border-bottom:1px solid var(--border);background:none;outline:none;font:inherit;color:var(--fg)";
        row.replaceChild(inp, $("span", row));
        inp.focus(); inp.select();
        const done = (ok) => {
          const v = inp.value.trim();
          if (ok && v && v !== l && !v.startsWith(RESERVED)) {
            for (const n of notes) {
              if ((n.labels || []).includes(l)) setLabels(n, n.labels.map((x) => (x === l ? v : x)));
            }
            if (state.view === "label" && state.label === l) state.label = v;
          }
          draw(); renderNav(); scheduleRender();
        };
        inp.onkeydown = (ev) => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); };
        inp.onblur = () => done(true);
      };
      delBtn.onclick = (e) => {
        e.stopPropagation();
        const affected = notes.filter((n) => (n.labels || []).includes(l));
        for (const n of affected) removeLabel(n, l);
        if (state.view === "label" && state.label === l) go("notes");
        draw(); renderNav(); scheduleRender();
        snack(`Label "${l}" deleted`, () => { for (const n of affected) addLabel(n, l); draw(); renderNav(); });
      };
      list.appendChild(row);
    }
  };
  draw();
  openPopover(anchor, wrap);
}

/* ══ Theme / layout toggles ═══════════════════════════════════════════ */
function applyTheme() {
  const dark = state.theme === "dark" ||
    (state.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  $("#theme-btn").innerHTML = svg(dark ? "light" : "dark");
  $("#theme-btn").title = dark ? "Light theme" : "Dark theme";
  localStorage.setItem("keep_theme", state.theme);
}

function applyLayout() {
  document.documentElement.classList.toggle("list-view", state.layout === "list");
  $("#view-btn").innerHTML = svg(state.layout === "list" ? "grid" : "list");
  $("#view-btn").title = state.layout === "list" ? "Grid view" : "List view";
  localStorage.setItem("keep_view", state.layout);
  relayout();
}

/* ══ Misc UI helpers ══════════════════════════════════════════════════ */
function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/* ══ Wiring ═══════════════════════════════════════════════════════════ */
function wire() {
  // static icons
  $("#menu-btn").innerHTML = svg("menu");
  $("#search-btn").innerHTML = svg("search");
  $("#search-clear").innerHTML = svg("close");
  $("#refresh-btn").innerHTML = svg("refresh");
  $("#sel-close").innerHTML = svg("close");
  $("#sel-pin").innerHTML = svg("pin");
  $("#sel-color").innerHTML = svg("palette");
  $("#sel-label").innerHTML = svg("labelOff");
  $("#sel-archive").innerHTML = svg("archive");
  $("#sel-delete").innerHTML = svg("trash");
  $("#cmp-new-list").innerHTML = svg("checked");
  $('[data-cmp="color"]').innerHTML = svg("palette");
  $('[data-cmp="label"]').innerHTML = svg("labelOff");
  $('[data-cmp="check"]').innerHTML = svg("checked");
  $('[data-cmp="image"]').innerHTML = svg("image");
  $('[data-cmp="pin"]').innerHTML = svg("pinOff");
  $('[data-ed="color"]').innerHTML = svg("palette");
  $('[data-ed="label"]').innerHTML = svg("labelOff");
  $('[data-ed="check"]').innerHTML = svg("checked");
  $('[data-ed="image"]').innerHTML = svg("image");
  $('[data-ed="archive"]').innerHTML = svg("archive");
  $('[data-ed="more"]').innerHTML = svg("more");
  D.fab.innerHTML = svg("add");
  $(".brand .mark").innerHTML =
    `<svg viewBox="0 0 24 24"><path fill="#fbbc04" d="M12 2C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/><path fill="#5f6368" d="M9 19h6v1c0 .55-.45 1-1 1h-4c-.55 0-1-.45-1-1v-1z"/></svg>`;

  applyTheme();
  applyLayout();
  setNav(state.navOpen);

  // top bar
  $("#menu-btn").onclick = () => setNav(!state.navOpen);
  D.scrim.onclick = () => setNav(false);
  $("#refresh-btn").onclick = () => pullAll({ quiet: false });
  $("#view-btn").onclick = () => { state.layout = state.layout === "grid" ? "list" : "grid"; applyLayout(); };
  $("#theme-btn").onclick = () => {
    state.theme = document.documentElement.classList.contains("dark") ? "light" : "dark";
    applyTheme();
  };
  D.account.onclick = () => openPopover(D.account, menuEl([
    ["keyboard", "Keyboard shortcuts", () => showShortcuts()],
    ["refresh", "Sync now", () => pullAll({ quiet: false })],
    ["download", "Export to CSV via Claude", async () => {
      try { await navigator.clipboard.writeText("/keep-to-csv"); snack("Command copied — paste it into Claude"); }
      catch { snack("In Claude, run /keep-to-csv"); }
    }],
    ["logout", "Sign out", async () => { await supabase.auth.signOut(); location.reload(); }, true],
  ]));

  // search
  let searchTimer;
  D.search.addEventListener("input", () => {
    D.searchClear.hidden = !D.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = D.search.value;
      state.limit = PAGE;
      scheduleRender();
    }, 90);
  });
  D.searchClear.onclick = () => {
    D.search.value = ""; D.searchClear.hidden = true;
    state.search = ""; state.limit = PAGE; scheduleRender(); D.search.focus();
  };

  // nav
  D.navList.addEventListener("click", (e) => {
    const b = e.target.closest(".nav-item");
    if (!b) return;
    if (b.dataset.action === "edit-labels") return labelManager(b);
    go(b.dataset.view, b.dataset.label || null);
  });

  // composer
  D.cmpStub.addEventListener("focus", () => openComposer(false));
  D.cmpStub.addEventListener("click", () => openComposer(false));
  $("#cmp-new-list").onclick = (e) => { e.stopPropagation(); openComposer(true); };
  D.cmpBody.addEventListener("input", () => { autoGrow(D.cmpBody); relayout(); });
  D.cmpTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); (cmp.list ? $(".txt", D.cmpList) : D.cmpBody)?.focus(); }
  });
  D.composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeComposer(true); }
    if (e.key === "Escape") { e.preventDefault(); closeComposer(true); }
  });
  D.composer.addEventListener("click", (e) => {
    const act = e.target.closest("[data-cmp]")?.dataset.cmp;
    const rmImg = e.target.closest("[data-rmimg]")?.dataset.rmimg;
    if (rmImg) { e.stopPropagation(); detachImage(rmImg, null); renderCmpImages(); relayout(); return; }
    const thumb = e.target.closest(".thumb[data-img]");
    if (thumb) { openLightbox(thumb.dataset.img); return; }
    const rm = e.target.closest("[data-rm]")?.dataset.rm;
    if (rm) { cmp.labels = cmp.labels.filter((l) => l !== rm); applyCmpChrome(); return; }
    if (!act) return;
    const anchor = e.target.closest("[data-cmp]");
    if (act === "close") closeComposer(true);
    else if (act === "image") pickImages(null);
    else if (act === "pin") { cmp.pinned = !cmp.pinned; applyCmpChrome(); }
    else if (act === "color")
      colorPopover(anchor, [], (c) => { cmp.color = c; applyCmpChrome(); }, cmp.color);
    else if (act === "label")
      // a live view of cmp.labels, so the popover's ticks stay accurate
      labelPopover(anchor, [{ get labels() { return cmp.labels; } }], (l, on) => {
        cmp.labels = on ? [...new Set([...cmp.labels, l])] : cmp.labels.filter((x) => x !== l);
        applyCmpChrome();
      });
    else if (act === "check") {
      if (cmp.list) {
        D.cmpBody.value = itemsToText(cmp.items.filter((i) => i.text.trim()));
        cmp.list = false; autoGrow(D.cmpBody);
      } else {
        cmp.items = textToItems(D.cmpBody.value);
        if (!cmp.items.length) cmp.items = [{ checked: false, text: "" }];
        cmp.list = true; renderCmpList();
      }
      applyCmpChrome();
    }
  });
  // clicking outside the open composer saves it, like Keep
  document.addEventListener("mousedown", (e) => {
    if (cmp.open && !D.composer.contains(e.target) && D.popover.hidden) closeComposer(true);
  });

  D.fab.onclick = () => { if (state.view !== "notes") go("notes"); openComposer(false); };

  // grids
  D.gridPinned.addEventListener("click", onGridClick);
  D.gridOthers.addEventListener("click", onGridClick);

  // editor
  D.edScrim.addEventListener("mousedown", (e) => { if (e.target === D.edScrim) closeEditor(); });
  D.edBody.addEventListener("input", () => autoGrow(D.edBody));
  D.edTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); (edItems ? $(".txt", D.edList) : D.edBody)?.focus(); }
  });
  D.editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeEditor(); }
  });
  D.edPin.onclick = () => {
    if (!edNote) return;
    patch(edNote, { pinned: !edNote.pinned });
    D.edPin.innerHTML = svg(edNote.pinned ? "pin" : "pinOff");
    D.edPin.classList.toggle("on", !!edNote.pinned);
  };
  D.editor.addEventListener("click", (e) => {
    const rmImg = e.target.closest("[data-rmimg]")?.dataset.rmimg;
    if (rmImg && edNote) { e.stopPropagation(); detachImage(rmImg, edNote); renderEdImages(); return; }
    const thumb = e.target.closest(".thumb[data-img]");
    if (thumb) { openLightbox(thumb.dataset.img); return; }
    const rm = e.target.closest("[data-rm]")?.dataset.rm;
    if (rm && edNote) { removeLabel(edNote, rm); renderEdLabels(); relayout(); return; }
    const act = e.target.closest("[data-ed]")?.dataset.ed;
    if (!act || !edNote) return;
    const anchor = e.target.closest("[data-ed]");
    if (act === "close") closeEditor();
    else if (act === "image") pickImages(edNote);
    else if (act === "color") colorPopover(anchor, [edNote], (c) => {
      patch(edNote, { color: c }); D.editor.dataset.color = c;
    });
    else if (act === "label") labelPopover(anchor, [edNote]);
    else if (act === "archive") {
      const was = edNote.archived, n = edNote;
      commitEditor();
      patch(n, { archived: !was });
      closeEditor();
      snack(was ? "Note unarchived" : "Note archived", () => patch(n, { archived: was }));
    } else if (act === "check") {
      if (edItems) {
        D.edBody.value = itemsToText(edItems.filter((i) => i.text.trim()));
        edItems = null; D.edBody.hidden = false; D.edList.hidden = true; autoGrow(D.edBody);
      } else {
        edItems = textToItems(D.edBody.value);
        if (!edItems.length) edItems = [{ checked: false, text: "" }];
        D.edBody.hidden = true; D.edList.hidden = false;
        renderEditableList(D.edList, edItems, commitEditorList);
      }
      commitEditor();
    } else if (act === "more") {
      const n = edNote;
      openPopover(anchor, menuEl([
        ["trash", "Delete note", () => { commitEditor(); closeEditor(); trash(n); snack("Note moved to Trash", () => untrash(n)); }],
        ["copy", "Make a copy", () => {
          commitEditor();
          const c = createNote({ title: n.title, body: n.body, color: n.color, labels: visibleLabels(n) });
          closeEditor(); snack("Copy created", () => destroy(c));
        }],
      ]));
    }
  });

  // selection bar
  $("#sel-close").onclick = clearSelection;
  $("#sel-pin").onclick = () => {
    const ns = selectedNotes();
    const anyUnpinned = ns.some((n) => !n.pinned);
    for (const n of ns) patch(n, { pinned: anyUnpinned });
    clearSelection();
  };
  $("#sel-color").onclick = (e) => colorPopover(e.currentTarget, selectedNotes());
  $("#sel-label").onclick = (e) => labelPopover(e.currentTarget, selectedNotes());
  $("#sel-archive").onclick = () => {
    const ns = selectedNotes();
    const anyOpen = ns.some((n) => !n.archived);
    for (const n of ns) patch(n, { archived: anyOpen });
    clearSelection();
    snack(`${ns.length} note${ns.length > 1 ? "s" : ""} ${anyOpen ? "archived" : "unarchived"}`,
      () => { for (const n of ns) patch(n, { archived: !anyOpen }); });
  };
  $("#sel-delete").onclick = () => {
    const ns = selectedNotes();
    for (const n of ns) trash(n);
    clearSelection();
    snack(`${ns.length} note${ns.length > 1 ? "s" : ""} moved to Trash`,
      () => { for (const n of ns) untrash(n); });
  };

  // trash
  $("#empty-trash").onclick = () => {
    const ns = notes.filter(isTrashed);
    if (!ns.length) return;
    if (!confirm(`Permanently delete ${ns.length} note${ns.length > 1 ? "s" : ""}? This can't be undone.`)) return;
    for (const n of ns) destroyDeep(n);
    snack("Trash emptied");
  };

  // layout responsiveness — width is the only dimension that matters, and
  // ignoring height changes keeps relayout() from re-triggering itself.
  let lastW = 0;
  new ResizeObserver(() => {
    const w = D.main.clientWidth;
    if (w === lastW) return;
    lastW = w;
    relayout();
  }).observe(D.main);
  window.addEventListener("resize", relayout);
  document.fonts?.ready.then(relayout);

  // elevation on scroll
  const onScroll = () => {
    const s = window.scrollY > 4;
    D.topbar.classList.toggle("scrolled", s);
    D.selbar.classList.toggle("scrolled", s);
  };
  window.addEventListener("scroll", () => { onScroll(); maybeLoadMore(); }, { passive: true });
  onScroll();

  // connectivity
  window.addEventListener("online", () => { updateSyncPill(); flushNow(); pullAll(); });
  window.addEventListener("offline", updateSyncPill);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && USER) { flushNow(); pullAll(); }
  });

  // ── images: picker, paste, drag-and-drop ───────────────────────────
  D.fileInput.addEventListener("change", () => {
    const files = D.fileInput.files;
    if (files?.length) addImages(files, pickTarget);
    pickTarget = null;
    D.fileInput.value = "";
  });

  const filesFrom = (dt) => {
    if (!dt) return [];
    if (dt.files?.length) return [...dt.files];
    return [...(dt.items || [])]
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter(Boolean);
  };

  document.addEventListener("paste", (e) => {
    const files = filesFrom(e.clipboardData).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    if (edNote) return addImages(files, edNote);
    if (!cmp.open) { if (state.view !== "notes" && state.view !== "label") go("notes"); openComposer(false); }
    addImages(files, null);
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || !USER) return;
    e.preventDefault();
    if (++dragDepth === 1) D.dropHint.hidden = false;
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; D.dropHint.hidden = true; }
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e) || !USER) return;
    e.preventDefault();
    dragDepth = 0;
    D.dropHint.hidden = true;
    const files = filesFrom(e.dataTransfer).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    if (edNote) return addImages(files, edNote);
    const card = e.target.closest?.(".note");
    const onto = card && byId.get(card.dataset.id);
    if (onto && !isTrashed(onto)) return addImages(files, onto);
    if (!cmp.open) { if (state.view !== "notes" && state.view !== "label") go("notes"); openComposer(false); }
    addImages(files, null);
  });

  D.lightbox.addEventListener("click", closeLightbox);

  keyboard();
}

/* ══ Keyboard ═════════════════════════════════════════════════════════ */
function keyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!D.lightbox.hidden) return closeLightbox();
      if (!D.popover.hidden) return closePopover();
      if (!D.shortcuts.hidden) return (D.shortcuts.hidden = true);
      if (edNote) return closeEditor();
      if (cmp.open) return closeComposer(true);
      if (selection.size) return clearSelection();
      if (state.search) { D.search.value = ""; D.searchClear.hidden = true; state.search = ""; scheduleRender(); return; }
      if (document.activeElement === D.search) D.search.blur();
      return;
    }

    const t = e.target;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (edNote || cmp.open || !D.popover.hidden || !D.shortcuts.hidden || !D.lightbox.hidden) return;

    switch (e.key) {
      case "c": case "n": e.preventDefault(); if (state.view !== "notes") go("notes"); openComposer(false); break;
      case "l": e.preventDefault(); if (state.view !== "notes") go("notes"); openComposer(true); break;
      case "/": e.preventDefault(); D.search.focus(); D.search.select(); break;
      case "g": e.preventDefault(); state.layout = state.layout === "grid" ? "list" : "grid"; applyLayout(); break;
      case "m": e.preventDefault(); setNav(!state.navOpen); break;
      case "?": e.preventDefault(); showShortcuts(); break;
    }
  });
}

function showShortcuts() {
  const rows = [
    ["c or n", "New note"], ["l", "New list"], ["/", "Search"],
    ["g", "Toggle grid / list"], ["m", "Toggle menu"],
    ["Esc", "Close / clear"], ["⌘ or Ctrl + Enter", "Save and close"],
    ["Enter (in a list)", "New list item"],
    ["⌘/Ctrl + V", "Paste an image into a note"],
    ["Drag & drop", "Drop images onto a note or the page"],
    ["?", "This dialog"],
  ];
  D.shortcuts.innerHTML = `<div class="sc-card"><h3>Keyboard shortcuts</h3>
    ${rows.map(([k, v]) => `<div class="sc-row"><b>${esc(v)}</b><kbd>${esc(k)}</kbd></div>`).join("")}</div>`;
  D.shortcuts.hidden = false;
  D.shortcuts.onclick = (e) => { if (e.target === D.shortcuts) D.shortcuts.hidden = true; };
}

/* ══ Auth ═════════════════════════════════════════════════════════════ */
const authForm = $("#auth-form"), emailInput = $("#email"),
      authSubmit = $("#auth-submit"), authMsg = $("#auth-msg");

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim();
  if (!email) return;
  authSubmit.disabled = true;
  authMsg.className = "auth-msg";
  authMsg.textContent = "Sending…";
  const { error } = await supabase.auth.signInWithOtp({
    email, options: { emailRedirectTo: location.origin + "/" },
  });
  authSubmit.disabled = false;
  if (error) { authMsg.className = "auth-msg err"; authMsg.textContent = error.message; }
  else { authMsg.className = "auth-msg ok"; authMsg.textContent = `Check ${email} and tap the link to sign in.`; }
});

/* ══ Boot ═════════════════════════════════════════════════════════════ */
let booted = false;

async function boot(user) {
  if (booted && USER?.id === user.id) return;
  const first = !booted;
  booted = true;
  USER = { id: user.id, email: user.email };

  document.documentElement.classList.remove("unauth");
  document.documentElement.classList.add("authed");
  D.account.textContent = (user.email || "?")[0].toUpperCase();
  D.account.title = user.email || "Account";
  D.fab.hidden = false;

  if (first) wire();

  // 1. paint from the local cache — this is what the user sees on open
  const [cached, ob] = await Promise.all([idb.get(cacheKey()), idb.get(outboxKey())]);
  if (Array.isArray(ob)) for (const [id, op] of ob) outbox.set(id, op);
  if (Array.isArray(cached) && cached.length) {
    notes = []; byId.clear();
    for (const n of cached) put(n);
    scheduleRender();
  } else {
    scheduleRender();
  }

  // 2. anything queued from a previous session goes out now
  updateSyncPill();
  flushNow();

  // 3. reconcile with the server in the background
  pullAll();

  // 4. deep links: share target and the "New note" app shortcut
  const p = new URLSearchParams(location.search);
  const text = [p.get("text"), p.get("url")].filter(Boolean).join("\n");
  const title = p.get("title");
  if (text || title) {
    openComposer(false);
    if (title) D.cmpTitle.value = title;
    if (text) { D.cmpBody.value = text; autoGrow(D.cmpBody); }
    history.replaceState({}, "", location.pathname);
  } else if (p.get("new")) {
    openComposer(p.get("new") === "list");
    history.replaceState({}, "", location.pathname);
  }

  window.__keepReady = true;

  // 5. live updates from other devices (no-op if realtime is off)
  try {
    supabase.channel("notes-" + USER.id)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `user_id=eq.${USER.id}` },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row?.id || outbox.has(row.id)) return;
          if (payload.eventType === "DELETE") drop(row.id);
          else put(payload.new);
          saveLocal();
          scheduleRender();
        })
      .subscribe();
  } catch {}
}

function signedOut() {
  USER = null; booted = false;
  notes = []; byId.clear(); outbox.clear(); selection.clear();
  document.documentElement.classList.remove("authed");
  document.documentElement.classList.add("unauth");
}

if (window.__BOOT_USER) boot(window.__BOOT_USER);

supabase.auth.getSession().then(({ data: { session } }) => {
  if (session?.user) boot(session.user);
  else signedOut();
});

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) boot(session.user);
  else if (event === "SIGNED_OUT") signedOut();
});

// Save any in-flight composer text if the tab goes away
window.addEventListener("pagehide", () => { if (cmp.open) closeComposer(true); });

/* ══ Service worker ═══════════════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  // Reload only when an *existing* controller is replaced, i.e. a new build
  // took over. On a first visit there is no controller, and the handover fires
  // anyway — reloading there just makes the first load flash for no reason.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}


/* ══ Test hooks ═══════════════════════════════════════════════════════
   Only attached on a local dev origin; test/smoke.mjs drives these. */
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  const find = (t) => notes.find((n) => !isTrashed(n) && !isBlobRow(n) && n.title === t);
  window.__keep = {
    count: () => notes.length,
    outboxSize: () => outbox.size,
    titles: () => notes.filter((n) => !isTrashed(n) && !isBlobRow(n)).map((n) => n.title),
    trashTitles: () => notes.filter((n) => isTrashed(n) && !isBlobRow(n)).map((n) => n.title),
    bodyOf: (t) => find(t)?.body,
    make: (f) => createNote(f),
    trashByTitle: (t) => { const n = find(t); if (n) trash(n); },
    labelFirst: (l) => { const n = visible()[0]; if (n) addLabel(n, l); },
    settle: async () => {
      clearTimeout(saveTimer);
      await idb.set(cacheKey(), notes.map(stripLocal));
      await idb.set(outboxKey(), [...outbox.entries()]);
    },
    imageCount: () => notes.filter(isBlobRow).length,
    hayOf: (t) => find(t)?._hay,
    refsOf: (t) => imageRefs(find(t) || { labels: [] }).length,
    addImageTo: async (t, dataUrl) => {
      const n = find(t);
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const file = new File([blob], "test.png", { type: blob.type });
      await addImages([file], n || null);
    },
    resetForTest: async () => {
      notes = []; byId.clear(); outbox.clear(); selection.clear();
      cards.forEach((el) => el.remove()); cards.clear();
      state.view = "notes"; state.label = null; state.search = "";
      state.limit = PAGE;
      D.search.value = "";
      await idb.set(cacheKey(), []);
      await idb.set(outboxKey(), []);
      render();
    },
  };
}
