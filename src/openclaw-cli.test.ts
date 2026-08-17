import { test, expect } from "bun:test";
import { createCliRunner } from "./openclaw-cli";

test("runs a binary and captures stdout, stderr and exit code", async () => {
  const run = createCliRunner("/bin/sh");
  const ok = await run(["-c", "echo out; echo err 1>&2; exit 3"]);
  expect(ok.stdout.trim()).toBe("out");
  expect(ok.stderr.trim()).toBe("err");
  expect(ok.code).toBe(3);
});

test("times out", async () => {
  const run = createCliRunner("/bin/sh", 100);
  await expect(run(["-c", "sleep 5"])).rejects.toThrow(/timed out/);
});

test("escalates to SIGKILL and rejects even if process ignores SIGTERM", async () => {
  const run = createCliRunner("/bin/sh", 100);
  const startTime = Date.now();
  await expect(run(["-c", 'trap "" TERM; sleep 5'])).rejects.toThrow(/timed out/);
  const elapsed = Date.now() - startTime;
  // Should reject within ~2.5s due to SIGKILL escalation after 2s grace period
  expect(elapsed).toBeLessThan(3000);
});
