# Obsidian ↔ ckeep sync

Two-way sync between the Obsidian vault at `/Users/rls/Documents/Obsidian Vault` and the ckeep note store. Synced notes appear on ckeep's dedicated **Obsidian** page (sidebar) and are kept off every other view, so they never mix with your main notes.

## How it works

Each `.md` file maps to one note, matched by a reserved `_ck:path:<vault-relative path>` label. Synced notes also carry the `_ck:obsidian` marker. Both labels start with `_ck:`, so the web app hides them from note chips and the label editor. A small state file at `~/.config/keep/obsidian_sync_state.json` remembers the last-synced content hash and remote timestamp per file, which is how the script tells which side changed.

- **New file** → creates a note. **New note** → writes a file.
- **Changed on one side** → pushed/pulled to the other.
- **Changed on BOTH sides** (conflict) → kept both: the ckeep version is written to a sibling `<name> (ckeep conflict <date>).md`, and the Obsidian file wins the canonical slot. Nothing is overwritten blind.
- **Deleted on either side** → reported only, never propagated, and not resurrected on later runs.

## One-time setup

The web app uses per-user row-level security, so the script needs the Supabase `service_role` secret (from Supabase → Settings → API). Copy it to `~/.config/keep/service_key`:

```bash
mkdir -p ~/.config/keep
pbpaste > ~/.config/keep/service_key   # after copying the service_role key
chmod 600 ~/.config/keep/service_key
```

Your ckeep account's `user_id` is resolved automatically from your email (`rsayar728@gmail.com`) and cached in the state file.

## Running it

```bash
cd scratch/keep
python3 obsidian_sync.py --dry-run     # preview; touches nothing
python3 obsidian_sync.py               # sync and print a report
```

Overridable via env vars: `CKEEP_VAULT`, `CKEEP_OWNER_EMAIL`, `CKEEP_SUPABASE_URL`, `CKEEP_CONFIG_DIR`.

## Web app changes

`app.js` adds an **Obsidian** sidebar view (`state.view === "obsidian"`) that shows only `_ck:obsidian` notes, and excludes those notes from Notes, Archive, labels, and search while you're outside that view. No database migration was needed — the separation rides entirely on reserved labels. Redeploy with `npx vercel deploy --prod`.
