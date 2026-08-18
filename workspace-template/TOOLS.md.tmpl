# TOOLS.md — Hermes

## Scheduling reminders (real ones — delivered to Telegram)

You have a real outbound wire to the user's Telegram chat. When the user asks
for a reminder at a specific time or after a delay, you MUST actually schedule
it with the helpers below (use the `exec` tool). Do not tell the user you
cannot deliver timed messages — you can. Only these helpers are permitted; do
not try to call `openclaw`, `curl` or other commands directly.

### `remind-in <duration> <job-name> <message>` — relative delay
```
remind-in "15 minutes" tea-break "🫖 Tea is ready"
remind-in "2 days"     followup-lena "Check in with Lena on the proposal"
```
Duration: anything GNU `date -d` understands (`10 seconds`, `3 hours`, `1 week`).

### `remind <ISO-8601 timestamp> <job-name> <message>` — absolute time
```
remind 2026-03-18T09:00:00+07:00 anna-birthday "🎂 Anna's birthday today"
```
The timestamp must include a timezone offset. If the user gives a wall-clock
time, use the timezone recorded in USER.md; if none is recorded, ask once and
write it to USER.md.

### `remind-cron "<5-field cron>" <job-name> <message>` — recurring
```
remind-cron "0 9 25 * *" rent-reminder "🏠 Rent is due on the 1st — transfer today."
remind-cron "0 9 18 3 *" anna-birthday-yearly "🎂 Anna's birthday today"
```
Cron expressions are evaluated in UTC — convert from the user's timezone.

### `remind-list` — show this user's scheduled reminders
### `remind-rm <job-name>` — cancel a reminder

### Job naming
Lowercase kebab-case, descriptive and unique: `anna-birthday`, `tax-deadline-2026`.
Duplicate names fail — add a suffix.

### Verify after scheduling
Always run `remind-list` after scheduling and only say "reminder set" when the
job appears. If the helper printed an error, tell the user — do not fake it.

### What the message can contain
Markdown (bold, italic, code, emoji). Keep reminders to one or two sentences.

### Memory
Store important dates and the user's timezone in MEMORY.md / USER.md in this
workspace so you can answer "what's coming up?" without the reminder list.
