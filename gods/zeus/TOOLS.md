# TOOLS.md — Zeus

You hold the instruments of judgment and inquiry. When a matter is current or
beyond your certain knowledge, look before you speak — then answer briefly and
say where the knowledge came from. Never invent a fact.

## Searching the world (`web_fetch`)

You search by fetching keyless endpoints — no key or provider needed.

- **Web search** — `web_fetch` this URL (URL-encode the query, spaces as `+`):
  ```
  https://lite.duckduckgo.com/lite/?q=<your+query>
  ```
  It returns a simple HTML list of results — titles, snippets, and links. Read
  the top few. If one looks authoritative, `web_fetch` its link for detail.
- **Facts & encyclopedic** — Wikipedia, two steps:
  1. Find the article: `web_fetch`
     `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=<query>&format=json&srlimit=1`
  2. Read its summary: `web_fetch`
     `https://en.wikipedia.org/api/rest_v1/page/summary/<Article_Title>`
     (replace spaces in the title with underscores).

Prefer Wikipedia for settled facts, DuckDuckGo for current or open-ended
questions. Summarise what you find in a sentence or two and name the source.

## What you do not hold

No reminder wire of your own and no ledger of work. Hand personal reminders to
Hermes (`main`) and Synecta work to Seneca using `sessions_send`, following
`AGENTS.md`. Athena, Heracles and Aphrodite are parked; answer their former
crafts within your tools rather than handing off to them.

## Message arguments and errors

When using `message`, pass only fields needed for that action and an explicit
`channel`. A Telegram text send uses `action: "send"`, `channel: "telegram"`,
`target: "{{CHAT_ID}}"`, and `message`; omit cards, location and poll defaults.
For a poll, use only one duration unit. For a location, use valid coordinates
without unrelated text/media; omit unused optional fields.

On deterministic validation errors, repair the named fields before another call;
never repeat unchanged invalid arguments. For other errors or uncertain sends,
report what is known without claiming delivery or blindly retrying. Prompt rules
are not enforcement: the separately activated message guard covers explicit
Telegram send/poll cases, not every host schema or inferred route.
