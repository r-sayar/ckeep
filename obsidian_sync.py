#!/usr/bin/env python3
"""Two-way sync between an Obsidian vault and the ckeep (Supabase) note store.

Synced notes live on ckeep's dedicated **Obsidian** page — they carry the
reserved marker label ``_ck:obsidian`` plus ``_ck:path:<vault-relative path>``
so the web app keeps them off every other view. One ``.md`` file <-> one note,
matched by that path label.

Design choices (fixed per the project owner):
  * Conflicts (both sides edited since last sync): KEEP BOTH. The ckeep version
    is written to a sibling ``<name> (ckeep conflict <date>).md`` and the
    Obsidian file wins the canonical slot. Nothing is ever overwritten blind.
  * Deletions are REPORT-ONLY. A file/note vanishing is reported once and never
    propagated; it is not resurrected on later runs either.

Auth: writes go through Supabase with per-user RLS, so this needs the
``service_role`` secret at ``~/.config/keep/service_key`` (same convention as
the keep-to-csv skill). The owning account's ``user_id`` is resolved from the
Supabase Auth admin API by email, cached in the state file.

Usage:
    python3 obsidian_sync.py              # sync and print a report
    python3 obsidian_sync.py --dry-run    # show what would change, touch nothing
    python3 obsidian_sync.py --verbose
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# ── Configuration ───────────────────────────────────────────────────────────
VAULT = Path(os.environ.get("CKEEP_VAULT", "/Users/rls/Documents/Obsidian Vault"))
SUPABASE_URL = os.environ.get("CKEEP_SUPABASE_URL", "https://sywglobxvtxayvelhunb.supabase.co")
OWNER_EMAIL = os.environ.get("CKEEP_OWNER_EMAIL", "rsayar728@gmail.com")

CONFIG_DIR = Path(os.environ.get("CKEEP_CONFIG_DIR", Path.home() / ".config" / "keep"))
KEY_FILE = CONFIG_DIR / "service_key"
STATE_FILE = CONFIG_DIR / "obsidian_sync_state.json"

RESERVED = "_ck:"
OBSIDIAN = RESERVED + "obsidian"
OBS_PATH = RESERVED + "path:"
TRASH = RESERVED + "trash"

# Vault dirs we never sync (Obsidian internals, trash, git).
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules"}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── Supabase REST helpers ─────────────────────────────────────────────────────
class Supabase:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key

    def _req(self, method: str, path: str, *, body=None, headers=None):
        url = self.url + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        hdr = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if headers:
            hdr.update(headers)
        req = urllib.request.Request(url, data=data, headers=hdr, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from None

    def resolve_user_id(self, email: str) -> str:
        """Find the auth user id for an email via the admin API (service key only)."""
        page = 1
        while True:
            q = urllib.parse.urlencode({"page": page, "per_page": 200})
            data = self._req("GET", f"/auth/v1/admin/users?{q}")
            users = data.get("users", data) if isinstance(data, dict) else data
            if not users:
                break
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return u["id"]
            if len(users) < 200:
                break
            page += 1
        raise RuntimeError(f"No Supabase Auth user with email {email!r}")

    def fetch_obsidian_notes(self, user_id: str) -> list[dict]:
        q = urllib.parse.urlencode({"user_id": f"eq.{user_id}", "select": "*"})
        rows = self._req("GET", f"/rest/v1/notes?{q}") or []
        return [n for n in rows if OBSIDIAN in (n.get("labels") or [])]

    def upsert(self, row: dict) -> dict:
        res = self._req(
            "POST",
            "/rest/v1/notes?on_conflict=id",
            body=row,
            headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        )
        return (res[0] if isinstance(res, list) else res) or row


# ── Vault helpers ──────────────────────────────────────────────────────────────
def scan_vault() -> dict[str, dict]:
    """Return {relpath: {body, hash, stem}} for every .md file in the vault."""
    out: dict[str, dict] = {}
    for p in VAULT.rglob("*.md"):
        if any(part in SKIP_DIRS for part in p.relative_to(VAULT).parts):
            continue
        # Conflict copies are ordinary .md files; they sync up as their own notes.
        rel = p.relative_to(VAULT).as_posix()
        body = p.read_text(encoding="utf-8")
        out[rel] = {"body": body, "hash": sha256(body), "stem": p.stem}
    return out


def note_to_row(user_id: str, rel: str, body: str, *, existing: dict | None) -> dict:
    stem = Path(rel).stem
    base = {
        "id": existing["id"] if existing else str(uuid.uuid4()),
        "user_id": user_id,
        "title": stem,
        "body": body,
        "labels": [OBSIDIAN, OBS_PATH + rel],
        "color": (existing or {}).get("color") or "DEFAULT",
        "pinned": (existing or {}).get("pinned", False),
        "archived": (existing or {}).get("archived", False),
        "source_url": None,
        "created_at": (existing or {}).get("created_at") or now_iso(),
        "updated_at": now_iso(),
    }
    # Preserve any extra visible labels a user added in ckeep.
    if existing:
        extra = [l for l in (existing.get("labels") or [])
                 if l != OBSIDIAN and not l.startswith(OBS_PATH) and l != TRASH]
        base["labels"] = [OBSIDIAN, OBS_PATH + rel] + extra
    return base


def path_of(note: dict) -> str | None:
    for l in note.get("labels") or []:
        if l.startswith(OBS_PATH):
            return l[len(OBS_PATH):]
    return None


# ── Sync engine ───────────────────────────────────────────────────────────────
class Report:
    def __init__(self):
        self.pushed, self.pulled, self.created_local = [], [], []
        self.created_remote, self.conflicts = [], []
        self.deleted_local, self.deleted_remote, self.skipped = [], [], []

    def render(self, dry: bool) -> str:
        v = "would " if dry else ""
        lines = ["", "Obsidian <-> ckeep sync" + (" (dry run)" if dry else "")]
        def sec(label, items):
            if items:
                lines.append(f"  {label}: {len(items)}")
                for it in items:
                    lines.append(f"    - {it}")
        sec(f"{v}create note from new file".strip(), self.created_remote)
        sec(f"{v}write file from new note".strip(), self.created_local)
        sec(f"{v}push file -> ckeep".strip(), self.pushed)
        sec(f"{v}pull ckeep -> file".strip(), self.pulled)
        sec("CONFLICT (kept both)", self.conflicts)
        sec("deleted locally (report only)", self.deleted_local)
        sec("deleted in ckeep (report only)", self.deleted_remote)
        sec("skipped", self.skipped)
        total = sum(len(x) for x in (self.pushed, self.pulled, self.created_local,
                                     self.created_remote, self.conflicts))
        if total == 0 and not (self.deleted_local or self.deleted_remote):
            lines.append("  nothing to do — in sync")
        return "\n".join(lines)


def run(dry: bool, verbose: bool) -> Report:
    if not VAULT.is_dir():
        sys.exit(f"Vault not found: {VAULT}")
    if not KEY_FILE.is_file():
        sys.exit(
            f"Missing service key: {KEY_FILE}\n"
            "Create it with the service_role secret from Supabase -> Settings -> API:\n"
            f"  mkdir -p {CONFIG_DIR} && pbpaste > {KEY_FILE} && chmod 600 {KEY_FILE}"
        )
    key = KEY_FILE.read_text().strip()
    sb = Supabase(SUPABASE_URL, key)

    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.is_file() else {}
    files_state = state.get("files", {})      # rel -> {id, hash, remote_updated_at, local_deleted?, remote_deleted?}
    user_id = state.get("user_id")
    if not user_id:
        user_id = sb.resolve_user_id(OWNER_EMAIL)
        if verbose:
            print(f"resolved user_id for {OWNER_EMAIL}: {user_id}")

    local = scan_vault()
    remote = {}
    unmapped = []
    for n in sb.fetch_obsidian_notes(user_id):
        rel = path_of(n)
        if rel:
            remote[rel] = n
        else:
            unmapped.append(n.get("id"))

    rep = Report()
    for uid in unmapped:
        rep.skipped.append(f"ckeep note {uid} has no _ck:path label")

    new_files_state = dict(files_state)
    all_rels = set(local) | set(remote) | set(files_state)

    for rel in sorted(all_rels):
        lf = local.get(rel)
        rn = remote.get(rel)
        base = files_state.get(rel, {})
        local_changed = lf and lf["hash"] != base.get("hash")
        remote_changed = rn and rn.get("updated_at") != base.get("remote_updated_at")

        # ── Both present ──────────────────────────────────────────────
        if lf and rn:
            if local_changed and remote_changed:
                # Conflict: keep both. ckeep version -> sibling file; local wins canonical.
                p = VAULT / rel
                stamp = dt.date.today().isoformat()
                conflict = p.with_name(f"{p.stem} (ckeep conflict {stamp}).md")
                rep.conflicts.append(f"{rel}  (ckeep copy -> {conflict.name})")
                if not dry:
                    i = 1
                    while conflict.exists():
                        conflict = p.with_name(f"{p.stem} (ckeep conflict {stamp}-{i}).md")
                        i += 1
                    conflict.write_text(rn.get("body") or "", encoding="utf-8")
                    saved = sb.upsert(note_to_row(user_id, rel, lf["body"], existing=rn))
                    new_files_state[rel] = {
                        "id": saved["id"], "hash": lf["hash"],
                        "remote_updated_at": saved.get("updated_at"),
                    }
            elif local_changed:
                rep.pushed.append(rel)
                if not dry:
                    saved = sb.upsert(note_to_row(user_id, rel, lf["body"], existing=rn))
                    new_files_state[rel] = {
                        "id": saved["id"], "hash": lf["hash"],
                        "remote_updated_at": saved.get("updated_at"),
                    }
            elif remote_changed:
                rep.pulled.append(rel)
                if not dry:
                    p = VAULT / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(rn.get("body") or "", encoding="utf-8")
                    new_files_state[rel] = {
                        "id": rn["id"], "hash": sha256(rn.get("body") or ""),
                        "remote_updated_at": rn.get("updated_at"),
                    }
            else:
                # In sync; make sure state is populated (first run after an import).
                new_files_state[rel] = {
                    "id": rn["id"], "hash": lf["hash"],
                    "remote_updated_at": rn.get("updated_at"),
                }
            continue

        # ── File only ─────────────────────────────────────────────────
        if lf and not rn:
            if base and not base.get("remote_deleted"):
                # Had a note before, now gone from ckeep -> deleted in ckeep.
                rep.deleted_remote.append(rel)
                new_files_state[rel] = {**base, "remote_deleted": True}
            else:
                rep.created_remote.append(rel)
                if not dry:
                    saved = sb.upsert(note_to_row(user_id, rel, lf["body"], existing=None))
                    new_files_state[rel] = {
                        "id": saved["id"], "hash": lf["hash"],
                        "remote_updated_at": saved.get("updated_at"),
                    }
            continue

        # ── Note only ─────────────────────────────────────────────────
        if rn and not lf:
            if base and not base.get("local_deleted"):
                # Had a file before, now gone locally -> deleted in Obsidian.
                rep.deleted_local.append(rel)
                new_files_state[rel] = {**base, "local_deleted": True}
            else:
                rep.created_local.append(rel)
                if not dry:
                    p = VAULT / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(rn.get("body") or "", encoding="utf-8")
                    new_files_state[rel] = {
                        "id": rn["id"], "hash": sha256(rn.get("body") or ""),
                        "remote_updated_at": rn.get("updated_at"),
                    }
            continue

        # ── Neither present (only in state) → both gone; forget it. ────
        new_files_state.pop(rel, None)

    if not dry:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(
            {"user_id": user_id, "files": new_files_state, "synced_at": now_iso()},
            indent=2,
        ))
    return rep


def main():
    ap = argparse.ArgumentParser(description="Two-way sync: Obsidian vault <-> ckeep")
    ap.add_argument("--dry-run", action="store_true", help="preview; touch nothing")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    rep = run(dry=args.dry_run, verbose=args.verbose)
    print(rep.render(args.dry_run))


if __name__ == "__main__":
    main()
