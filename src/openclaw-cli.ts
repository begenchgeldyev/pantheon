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

    const mainTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");

      // Escalate to SIGKILL after 2 seconds if process doesn't exit
      setTimeout(() => {
        if (timedOut) {
          proc.kill("SIGKILL");
        }
      }, 2000);
    }, timeoutMs);

    try {
      const timeoutMsg = `command timed out after ${timeoutMs}ms: ${bin} ${args[0] ?? ""}`;

      // Race the actual work against a deadline that monitors timeout
      const work = (async () => {
        const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
        const code = await proc.exited;
        if (timedOut) throw new Error(timeoutMsg);
        return { code, stdout, stderr };
      })();

      // Deadline promise that rejects if timeout occurs during work
      const deadline = (async () => {
        while (!timedOut) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(timeoutMsg);
      })();

      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(mainTimer);
    }
  };
}
