// Intent classification for the router (Zeus).
//
// A cheap, zero-latency keyword pass that decides which specialist god a
// message is clearly for. Returns a specialist agent id, or null when the
// message gives no clear signal (Zeus, the front door, then handles it, or the
// chat stays with whichever god it was already talking to).
//
// It never returns the router itself: you are routed *to* a specialist, and
// Zeus is only ever the fallback, not a classification target.

import { HERMES_AGENT_ID } from "./gods";

// Match on a diacritics-stripped, lower-cased copy so "résumé" == "resume".
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const HERMES_RE =
  /\b(remind|reminder|dont forget|don't forget|birthday|anniversary|appointment|deadline|renewal|rent|schedule (?:a|an|me)|wake me|at \d{1,2}(?::\d{2})?\s?(?:am|pm)?)\b/;

const ATHENA_RE =
  /\b(job|jobs|vacanc\w*|hiring|hire me|apply|applicat\w*|resume|\bcv\b|cover letter|recruiter|interview|salary|compensation|career|posting|opening|remote work|greenhouse|lever\.co|ashby)\b/;

/**
 * The specialist this message is clearly for, or null.
 * `athenaId` is the owner's job-hunt agent id (from config.ownerGods), if any.
 */
export function classifyIntent(text: string, athenaId: string | null): string | null {
  const s = fold(text);
  const hermes = HERMES_RE.test(s);
  const athena = athenaId !== null && ATHENA_RE.test(s);
  if (hermes && !athena) return HERMES_AGENT_ID;
  if (athena && !hermes) return athenaId;
  return null; // no signal, or both → ambiguous
}
