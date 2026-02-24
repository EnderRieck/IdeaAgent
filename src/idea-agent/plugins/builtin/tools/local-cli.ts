import { spawn } from "node:child_process";
import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";

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

export const localCliTool: NativeTool = {
  name: "local-cli",
  description: "执行本地 Shell 命令，每次调用均需用户明确批准。",
  inputSchema,
  requiresApproval: true,
  async execute(input: z.infer<typeof inputSchema>) {
    try {
      const result = await runCommand(
        input.command,
        input.args ?? [],
        input.cwd,
        input.timeoutMs ?? 30000,
      );
      return { value: JSON.stringify(result) };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "local-cli failed"}` };
    }
  },
};
