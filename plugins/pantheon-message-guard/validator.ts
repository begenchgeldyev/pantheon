export type Veto = { block: true; blockReason: string };

const veto = (blockReason: string): Veto => ({ block: true, blockReason });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
const omittedDuration = (value: unknown): boolean =>
  value == null || (typeof value === "string" && value.trim() === "");

// Intentionally narrow: unknown actions, channels and schema fields belong to the host.
// No counters, logging, parameter rewrites, or executor access live in this module.
export function validateMessage(toolName: string, params: unknown): Veto | undefined {
  if (toolName.trim().toLowerCase() !== "message" || !record(params)) return;
  const telegram = typeof params.channel === "string" && params.channel.trim().toLowerCase() === "telegram";
  if (params.action === "poll") {
    // Telegram reads primary aliases first; a valid primary short-circuits its
    // poll-prefixed fallback, including malformed values in that ignored field.
    const fields = telegram ? [
      !omittedDuration(params.durationSeconds) ? "durationSeconds" : "pollDurationSeconds",
      !omittedDuration(params.durationHours) ? "durationHours" : "pollDurationHours",
    ] : ["pollDurationSeconds", "pollDurationHours"];
    for (const field of fields) {
      const value = params[field];
      if (value === undefined) continue;
      if (telegram) {
        if (omittedDuration(value)) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1)
          return veto(`${field}: supply a finite positive integer or omit.`);
      } else {
        // Shared poll normalization floors finite numbers, and ignores other types.
        if (typeof value === "number" && Number.isFinite(value) && Math.floor(value) < 1)
          return veto(`${field}: supply a number at least 1 or omit.`);
      }
    }
    if (fields.every(field => typeof params[field] === "number" && Number.isFinite(params[field])))
      return veto(`${fields[0]}/${fields[1]}: supply only one duration.`);
  }
  if (!telegram || params.action !== "send") return;
  if (params.clawhub != null && params.clawhub !== "")
    return veto("clawhub: remove; use a plain Telegram message.");
  const location = params.location;
  if (location == null) return;
  if (!record(location)) return veto("location: supply an object or omit.");
  for (const [field, min, max] of [["latitude", -90, 90], ["longitude", -180, 180], ["accuracy", 0, 1500]] as const) {
    const value = location[field];
    if (field === "accuracy" && value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      return veto(`location.${field}: supply a finite number between ${min} and ${max}.`);
  }
  for (const field of ["source", "isLive", "caption"] as const) {
    if (location[field] !== undefined) return veto(`location.${field}: remove unsupported field.`);
  }
  for (const field of ["name", "address"] as const) {
    if (location[field] !== undefined && !text(location[field]))
      return veto(`location.${field}: supply nonblank text or omit.`);
  }
  if ((location.name !== undefined) !== (location.address !== undefined))
    return veto("location.name/location.address: supply both venue fields or omit both.");
  if (text(params.message) || [params.media, params.mediaUrl].some(text) ||
      (Array.isArray(params.mediaUrls) && params.mediaUrls.some(text)) || params.asVideoNote === true)
    return veto("location/message/media: send location separately from text, media, and video notes.");
}
