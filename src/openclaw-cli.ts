// Generic OpenClaw CLI runner used for management commands (agents add,
// config set, approvals ...). Argument ARRAY only — never a shell string.

export type CliResult = { code: number; stdout: string; stderr: string };
export type CliRunner = (args: string[]) => Promise<CliResult>;

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function createCliRunner(bin: string, timeoutMs = 60_000): CliRunner {
  return async (args) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    let rejectDeadline!: (e: Error) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    // Observe deadline so rejection doesn't leak if work wins the race
    deadline.catch(() => {});

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Escalate to SIGKILL after 2 seconds if process doesn't exit
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      rejectDeadline(new Error(`command timed out after ${timeoutMs}ms: ${bin} ${args.join(" ")}`));
    }, timeoutMs);

    const work = (async () => {
      const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    })();
    // Observe work so rejection doesn't leak if deadline wins the race
    work.catch(() => {});

    try {
      const result = await Promise.race([work, deadline]);
      // Check if timeout occurred after race settled
      if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms: ${bin} ${args.join(" ")}`);
      return result;
    } finally {
      clearTimeout(timer);
      // Clear killTimer only if we didn't timeout; on timeout path let SIGKILL escalation fire
      if (!timedOut && killTimer) clearTimeout(killTimer);
    }
  };
}
