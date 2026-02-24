import { spawn } from "node:child_process";
import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";

const inputSchema = z.object({
  code: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120000).default(15000).optional(),
});

function runPython(code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python", ["-c", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Python execution timeout after ${timeoutMs}ms`));
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

export const pythonExecTool: NativeTool = {
  name: "python-exec",
  description: "执行 Python 代码片段，用于绘图和计算任务。不要用于美化输出，请改用 Markdown。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    try {
      const result = await runPython(input.code, input.timeoutMs ?? 15000);
      return { value: JSON.stringify(result) };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "Python execution failed"}` };
    }
  },
};
