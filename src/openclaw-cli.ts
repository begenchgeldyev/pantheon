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
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms: ${bin} ${args[0] ?? ""}`);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}
