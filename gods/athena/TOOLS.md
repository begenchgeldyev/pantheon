# TOOLS.md — Athena

## Fetching vacancies

Use the web/http fetch tool (`web_fetch`) to GET these endpoints. They return
JSON (or clean HTML) you can parse directly — no scraping of bot-protected
sites, no search-engine key required. Respect each source; fetch what you need,
not the whole internet.

### Aggregators (broad, remote-heavy)

- **Remotive** — `https://remotive.com/api/remote-jobs?search=<terms>&limit=50`
  Returns `{ jobs: [{ title, company_name, candidate_required_location, salary, url, publication_date, tags }] }`.
- **RemoteOK** — `https://remoteok.com/api`
  JSON array (first element is metadata — skip it). Fields: `position`, `company`, `location`, `tags`, `url`.
- **We Work Remotely** — category RSS, e.g.
  `https://weworkremotely.com/categories/remote-programming-jobs.rss` (parse the XML items: title, link, description).
- **Hacker News "Who is hiring"** (monthly thread) via Algolia —
  first find the thread: `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=Ask%20HN%20Who%20is%20hiring`,
  then its comments: `https://hn.algolia.com/api/v1/items/<threadObjectID>` (each child comment is one posting).

### Company boards (targeted — best signal)

When your charge names target companies, watch their ATS boards directly. The
board **slug** is usually the company name; confirm from their careers page.

- **Greenhouse** — `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true`
  → `{ jobs: [{ title, location: { name }, absolute_url, updated_at, content }] }`.
- **Lever** — `https://api.lever.co/v0/postings/<slug>?mode=json`
  → array of `{ text, categories: { location, team, commitment }, hostedUrl, descriptionPlain }`.
- **Ashby** — `https://api.ashbyhq.com/posting-api/job-board/<slug>` (POST or GET per their docs)
  → `{ jobs: [{ title, location, employmentType, jobUrl }] }`.

### Notes

- Parse defensively — fields vary and some are missing. Never present a field you didn't actually receive.
- The `url` / `absolute_url` / `hostedUrl` is the **real apply link** — always include it, never a guessed one.
- Filter by the stored location rule and comp floor *before* presenting. Comp is often absent; when it is, say "comp not stated," don't guess.
- If a fetch fails or returns nothing, say so plainly and try another source or a widened query.

## Memory

Keep your charge's preferences, target companies, résumé path, and roles you've
already shown in `MEMORY.md`, so each session builds on the last and you never
re-ask or re-surface the same posting.
