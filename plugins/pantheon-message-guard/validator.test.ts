import { describe, expect, test } from "bun:test";
import { validateMessage } from "./validator";

const send = { action: "send", channel: "telegram", target: "fixture-target" };
const poll = { ...send, action: "poll", pollQuestion: "Choose", pollOption: ["A", "B"] };

describe("action-specific validation", () => {
  test.each([
    { ...send, message: "hello" }, poll,
    { ...send, action: "pin", messageId: "fixture-id" },
    { ...send, location: { latitude: 0, longitude: 0 } },
    { ...send, location: { latitude: -90, longitude: 180, accuracy: 1500, name: "Place", address: "Road" } },
    { ...poll, pollDurationSeconds: 1 }, { ...poll, pollDurationHours: 24 },
    { ...send, message: "hello", location: null, pollDurationHours: 0, pollDurationSeconds: 0, clawhub: null },
    { ...send, message: "hello", clawhub: "" },
    { ...send, action: "pin", location: { name: " " }, pollDurationSeconds: -1 },
    { ...send, location: { latitude: 90, longitude: -180, accuracy: 0 }, message: " ", media: "", mediaUrl: "", mediaUrls: [], asVideoNote: false },
  ])("allows minimal/action-irrelevant payload %#", (params) => {
    expect(validateMessage("message", params)).toBeUndefined();
  });

  test.each([
    [{ ...send, clawhub: { slug: "private-payload" } }, "clawhub: remove; use a plain Telegram message."],
    [{ ...poll, pollDurationSeconds: 60, pollDurationHours: 1 }, "pollDurationSeconds/pollDurationHours: supply only one duration."],
    ...[0, -1, NaN, Infinity, 0.5, 1.5, "60"].map(value => [
      { ...poll, pollDurationSeconds: value }, "pollDurationSeconds: supply a finite positive integer or omit."
    ]),
    [{ ...poll, pollDurationHours: -1 }, "pollDurationHours: supply a finite positive integer or omit."],
    [{ ...send, location: [] }, "location: supply an object or omit."],
    [{ ...send, location: { longitude: 0 } }, "location.latitude: supply a finite number between -90 and 90."],
    [{ ...send, location: { latitude: NaN, longitude: 0 } }, "location.latitude: supply a finite number between -90 and 90."],
    [{ ...send, location: { latitude: 0, longitude: Infinity } }, "location.longitude: supply a finite number between -180 and 180."],
    [{ ...send, location: { latitude: 0, longitude: 0, accuracy: 1501 } }, "location.accuracy: supply a finite number between 0 and 1500."],
    [{ ...send, location: { latitude: 0, longitude: 0, name: null } }, "location.name: supply nonblank text or omit."],
    [{ ...send, location: { latitude: 91, longitude: 0 } }, "location.latitude: supply a finite number between -90 and 90."],
    [{ ...send, location: { latitude: 0, longitude: -181 } }, "location.longitude: supply a finite number between -180 and 180."],
    [{ ...send, location: { latitude: 0, longitude: 0, accuracy: -1 } }, "location.accuracy: supply a finite number between 0 and 1500."],
    [{ ...send, location: { latitude: 0, longitude: 0, name: "  " } }, "location.name: supply nonblank text or omit."],
    [{ ...send, location: { latitude: 0, longitude: 0, address: "\t" } }, "location.address: supply nonblank text or omit."],
    [{ ...send, location: { latitude: 0, longitude: 0, name: "Place" } }, "location.name/location.address: supply both venue fields or omit both."],
    [{ ...send, location: { latitude: 0, longitude: 0, address: "Road" } }, "location.name/location.address: supply both venue fields or omit both."],
    ...["source", "isLive", "caption"].map(field => [
      { ...send, location: { latitude: 0, longitude: 0, [field]: false } }, `location.${field}: remove unsupported field.`
    ]),
    ...[{ message: "private-text" }, { media: "private-path" }, { mediaUrl: "private-url" }, { mediaUrls: ["private-url"] }, { asVideoNote: true }].map(extra => [
      { ...send, ...extra, location: { latitude: 0, longitude: 0 } }, "location/message/media: send location separately from text, media, and video notes."
    ]),
  ])("blocks known invalid payload %# with field-only repair", (params, reason) => {
    expect(validateMessage("message", params)).toEqual({ block: true, blockReason: reason });
  });

  test("does not mutate frozen input or leak values into a repeated veto", () => {
    const params = Object.freeze({ ...send, message: "secret", clawhub: Object.freeze({ slug: "secret" }) });
    for (let i = 0; i < 5; i++) {
      expect(validateMessage("message", params)).toEqual({ block: true, blockReason: "clawhub: remove; use a plain Telegram message." });
    }
  });

  test("leaves unrelated tools/channels and opaque envelopes alone", () => {
    expect(validateMessage("exec", { ...send, clawhub: {} })).toBeUndefined();
    expect(validateMessage("dispatch_action", { tool: "message", input: { ...send, clawhub: {} } })).toBeUndefined();
    expect(validateMessage("message", { ...send, channel: "discord", clawhub: {}, location: { name: " " } })).toBeUndefined();
    for (const params of [undefined, null, [], "text"]) expect(validateMessage("message", params)).toBeUndefined();
  });

  test("applies only documented shared poll duration constraints to other channels", () => {
    expect(validateMessage("message", { ...poll, channel: "discord", pollDurationHours: 1.5 })).toBeUndefined();
    expect(validateMessage("message", { ...poll, channel: "discord", pollDurationHours: -1 }))
      .toEqual({ block: true, blockReason: "pollDurationHours: supply a number at least 1 or omit." });
    expect(validateMessage("message", { ...poll, channel: "discord", pollDurationHours: 1, pollDurationSeconds: 60 }))
      .toEqual({ block: true, blockReason: "pollDurationSeconds/pollDurationHours: supply only one duration." });
  });

  test.each([
    [{ durationSeconds: 60, pollDurationHours: 1 }, "durationSeconds/pollDurationHours: supply only one duration."],
    [{ pollDurationSeconds: 60, durationHours: 1 }, "pollDurationSeconds/durationHours: supply only one duration."],
    [{ durationSeconds: 60, durationHours: 1 }, "durationSeconds/durationHours: supply only one duration."],
    ...[0, -1, NaN, Infinity, 0.5, 1.5].flatMap(value => [
      [{ durationSeconds: value }, "durationSeconds: supply a finite positive integer or omit."],
      [{ durationHours: value }, "durationHours: supply a finite positive integer or omit."],
    ]),
  ])("rejects selected Telegram duration aliases and cross-alias conflicts %#", (durations, reason) => {
    expect(validateMessage("message", { ...poll, ...durations })).toEqual({ block: true, blockReason: reason });
  });

  test.each([
    { durationSeconds: 60 }, { durationHours: 1 },
    { durationSeconds: 60, pollDurationSeconds: -1 },
    { durationHours: 1, pollDurationHours: NaN },
    { durationSeconds: 60, pollDurationSeconds: "ignored" },
    { durationHours: 1, pollDurationHours: null },
  ])("honors primary duration precedence without validating ignored fallback %#", durations => {
    expect(validateMessage("message", { ...poll, ...durations })).toBeUndefined();
  });

  test("duration aliases do not extend validation to unrelated actions or channels", () => {
    expect(validateMessage("message", { ...send, durationSeconds: -1 })).toBeUndefined();
    expect(validateMessage("message", { ...poll, channel: "discord", durationSeconds: -1 })).toBeUndefined();
  });

  test.each([undefined, null, "", " \t"])("omitted primary placeholder %# falls through without creating duration intent", placeholder => {
    expect(validateMessage("message", { ...poll, durationSeconds: placeholder, pollDurationSeconds: 60 })).toBeUndefined();
    expect(validateMessage("message", { ...poll, durationHours: placeholder, pollDurationHours: 1 })).toBeUndefined();
    expect(validateMessage("message", { ...poll, durationSeconds: placeholder, durationHours: placeholder,
      pollDurationSeconds: placeholder, pollDurationHours: placeholder })).toBeUndefined();
    expect(validateMessage("message", { ...poll, durationSeconds: placeholder, pollDurationSeconds: 60, durationHours: 1 }))
      .toEqual({ block: true, blockReason: "pollDurationSeconds/durationHours: supply only one duration." });
    expect(validateMessage("message", { ...poll, durationHours: placeholder, pollDurationHours: 1, durationSeconds: 60 }))
      .toEqual({ block: true, blockReason: "durationSeconds/pollDurationHours: supply only one duration." });
  });

  test("invalid supplied primary cannot be rescued by a valid fallback", () => {
    expect(validateMessage("message", { ...poll, durationSeconds: 0, pollDurationSeconds: 60 }))
      .toEqual({ block: true, blockReason: "durationSeconds: supply a finite positive integer or omit." });
    expect(validateMessage("message", { ...poll, durationHours: -1, pollDurationHours: 1 }))
      .toEqual({ block: true, blockReason: "durationHours: supply a finite positive integer or omit." });
  });

  test.each([101, 102])("%i-field placeholders preserve minimal real intent", (count) => {
    const params: Record<string, unknown> = { ...send, message: "hello", location: null, clawhub: null, pollDurationSeconds: 0, pollDurationHours: 0 };
    while (Object.keys(params).length < count) params[`unused${Object.keys(params).length}`] = "";
    expect(Object.keys(params)).toHaveLength(count);
    expect(validateMessage("message", params)).toBeUndefined();
    params.clawhub = { slug: "card" };
    expect(validateMessage("message", params)?.block).toBe(true);
    delete params.clawhub;
    expect(validateMessage("message", params)).toBeUndefined();
  });
});
