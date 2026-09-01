---
name: keep-to-csv
description: "Fetch the user's notes from the Keep web app's Supabase database and write them to a CSV file. Use when the user says 'keep to csv', 'export my keep notes', 'pull notes from keep', '/keep-to-csv', or asks to turn their note app contents into a spreadsheet."
allowed-tools: [Read, Write, Bash]
---

# Keep → CSV

Pulls the user's notes from Supabase (the Keep web app's backend) and writes them to a CSV the user can open in any spreadsheet tool.

## Project

- Supabase project_id: `sywglobxvtxayvelhunb`
- Table: `public.notes`
- The notes table is RLS-protected. Anonymous reads return empty. To fetch, use **one of**:
  1. **The Supabase MCP** (preferred — already connected in Claude Desktop / Claude Code). Tool: `execute_sql`. Bypasses RLS as the project owner.
  2. **A service role key**, if available at `~/.config/keep/service_key` (a single line, the `service_role` secret from Supabase → Settings → API). Used as both the `apikey` and `Authorization: Bearer` header in curl.

## Process

> Two kinds of row are not notes and must be skipped:
> - **Trashed** notes, flagged by a reserved `_ck:trash` entry in `labels` —
>   an export shouldn't quietly resurrect deleted notes.
> - **Image rows**, flagged `_ck:blob`, whose `body` is a base64 data URL.
>   These back the image attachments on other notes; dumping them into a CSV
>   would produce megabyte-long unreadable cells.
>
> Both queries below exclude both kinds.

1. **Fetch** all live notes (newest first):

   **Preferred (via Supabase MCP):**
   ```
   execute_sql(project_id="sywglobxvtxayvelhunb", query="
     select id, created_at, title, body
     from public.notes
     where archived = false
       and not (labels && array['_ck:trash', '_ck:blob'])
     order by created_at desc
   ")
   ```

   **Fallback (curl with service role key):**
   ```bash
   KEY=$(cat ~/.config/keep/service_key)
   curl -s \
     "https://sywglobxvtxayvelhunb.supabase.co/rest/v1/notes?select=id,created_at,title,body&archived=eq.false&labels=not.ov.%7B_ck%3Atrash,_ck%3Ablob%7D&order=created_at.desc" \
     -H "apikey: $KEY" \
     -H "Authorization: Bearer $KEY"
   ```

2. **Parse** the JSON response. If empty, tell the user "No notes" and stop.

3. **Write CSV** to `~/Downloads/keep-notes-YYYY-MM-DD.csv` with columns: `id,created_at,title,body`.
   - RFC 4180 escaping: wrap every field in `"..."`, double internal quotes, newlines inside quoted fields are fine.
   - Use a small Python script — don't roll string concatenation by hand.

4. **Confirm** to the user: row count, absolute path. Offer `open <path>` to launch it.

## Reference Python

If you fetched via the Supabase MCP, save its result to a temp file as JSON, then:

```python
import json, csv, sys, pathlib, datetime

notes = json.loads(pathlib.Path("/tmp/keep_notes.json").read_text())
if not notes:
    print("No notes"); sys.exit(0)

out = pathlib.Path.home() / "Downloads" / f"keep-notes-{datetime.date.today()}.csv"
with out.open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["id", "created_at", "title", "body"], quoting=csv.QUOTE_ALL)
    w.writeheader()
    w.writerows(notes)
print(f"Wrote {len(notes)} rows to {out}")
```
