import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120000).default(30000).optional(),
});

function runCommand(command: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`CLI execution timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (codeNum) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: codeNum ?? 0 });
    });
  });
}

export const localCliTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "local-cli",
  description: "Run local shell commands. Explicit approval is always required.",
  inputSchema,
  requiresApproval() {
    return true;
  },
  async execute(input) {
    try {
      const result = await runCommand(
        input.command,
        input.args ?? [],
        input.cwd,
        input.timeoutMs ?? 30000,
      );
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "local-cli failed" };
    }
  },
};
