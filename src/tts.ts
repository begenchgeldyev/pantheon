// Text-to-speech for god voices, via local Piper (keyless, on the server).
//
// Each god gets a distinct voice; the reply text is synthesised to WAV by
// Piper and transcoded to Opus/OGG (ffmpeg) — the format Telegram voice notes
// use. Runs entirely on the host, no external service or key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type Synthesizer = (text: string, agentId: string) => Promise<Buffer>;

// Distinct Piper voice per god (model file name without extension).
export const VOICE_BY_AGENT: Record<string, string> = {
  zeus: "en_US-ryan-high", // deep, commanding
  main: "en_US-joe-medium", // Hermes: quick, light
  athena: "en_US-amy-medium", // crisp
};
export const DEFAULT_VOICE = "en_US-joe-medium";

export function voiceForAgent(agentId: string): string {
  return VOICE_BY_AGENT[agentId] ?? DEFAULT_VOICE;
}

export function createPiperSynthesizer(piperBin: string, voicesDir: string): Synthesizer {
  const libDir = path.dirname(piperBin); // Piper's bundled .so files sit beside the binary
  return async (text, agentId) => {
    const modelPath = path.join(voicesDir, `${voiceForAgent(agentId)}.onnx`);
    const dir = mkdtempSync(path.join(tmpdir(), "pan-tts-"));
    const wavPath = path.join(dir, "out.wav");
    try {
      const piper = Bun.spawn([piperBin, "-m", modelPath, "-f", wavPath], {
        stdin: Buffer.from(text, "utf8"),
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, LD_LIBRARY_PATH: libDir },
      });
      if ((await piper.exited) !== 0) {
        throw new Error(`piper failed: ${(await new Response(piper.stderr).text()).slice(0, 200)}`);
      }
      const ffmpeg = Bun.spawn(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const ogg = Buffer.from(await new Response(ffmpeg.stdout).arrayBuffer());
      if ((await ffmpeg.exited) !== 0) {
        throw new Error(`ffmpeg failed: ${(await new Response(ffmpeg.stderr).text()).slice(0, 200)}`);
      }
      return ogg;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
