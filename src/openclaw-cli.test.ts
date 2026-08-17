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
