import React from "react";
import type { AgentEvent } from "./core/event-bus";
import { createIdeaAgentRuntime, createInitialSession } from "./index";
import { RunTextLogger } from "./observability/run-text-logger";
import { InkUserBridge } from "./runtime/ink-user-bridge";
import { App } from "./ui/ink/App";
import { initInk, getInk } from "./ui/ink/ink-api";
import * as S from "./ui/styles";

interface CliOptions {
  configPath?: string;
  interactive?: boolean;
  autoApproveSensitiveTools?: boolean;
  maxTurns?: number;
  debugPrompts?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config" || arg === "-c") {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--interactive" || arg === "-i") {
      options.interactive = true;
      continue;
    }

    if (arg === "--auto-approve-sensitive-tools") {
      options.autoApproveSensitiveTools = true;
      continue;
    }

    if (arg === "--max-turns") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        options.maxTurns = Math.floor(value);
      }
      index += 1;
      continue;
    }

    if (arg === "--debug-prompts") {
      options.debugPrompts = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    positionals.push(arg);
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(`\n${S.boldCyan("IdeaAgent CLI")}\n\n`);
  process.stdout.write(`${S.bold("Usage:")}\n`);
  process.stdout.write(`  ${S.dim("$")} ${S.white("node dist/idea-agent/cli.js")} ${S.yellow("-i")}\n\n`);
  process.stdout.write(`${S.bold("Options:")}\n`);
  process.stdout.write(`  ${S.yellow("-c, --config")} ${S.dim("<path>")}                   配置文件路径\n`);
  process.stdout.write(`  ${S.yellow("-i, --interactive")}                     开启交互问答/审批\n`);
  process.stdout.write(`      ${S.yellow("--auto-approve-sensitive-tools")}    自动批准敏感工具\n`);
  process.stdout.write(`      ${S.yellow("--max-turns")} ${S.dim("<n>")}                   覆盖最大轮数\n`);
  process.stdout.write(`      ${S.yellow("--debug-prompts")}                   可视化显示每步完整提示词输入\n`);
  process.stdout.write(`  ${S.yellow("-h, --help")}                            显示帮助\n\n`);
}

// ── Non-interactive fallback renderer ────────────────────────────

function compactText(value: unknown, maxChars: number = 220): string {
  const raw = typeof value === "string"
    ? value
    : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}...(truncated)`;
}

function renderProgress(event: AgentEvent): void {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case "run.started":
      process.stdout.write(`\n${S.dim("Session:")} ${S.gray(String(p.sessionId ?? ""))}\n`);
      return;
    case "agent.llm.start":
      process.stdout.write(`\n${S.horizontalRule()}\n`);
      process.stdout.write(`${S.boldYellow("⟡")} ${S.boldWhite(`Turn ${String(p.turn ?? event.turn)}`)} ${S.dim(`[${String(p.agent ?? "")}]`)} ${S.dim("思考中...")}\n`);
      return;
    case "agent.message": {
      const content = String(p.content ?? "").replace(/<empty>/g, "").trim();
      if (content.length > 0) {
        process.stdout.write(`\n${S.dotGreen(S.boldGreen("Agent 回复"))}\n\n${content}\n`);
      }
      return;
    }
    case "agent.tool.start":
      process.stdout.write(`\n${S.dotCyan(S.boldCyan(String(p.toolName ?? "unknown")))}\n`);
      process.stdout.write(`  ${S.TREE.corner} ${S.dim(compactText(p.input, 160))}\n`);
      return;
    case "agent.tool.complete":
      process.stdout.write(`  ${S.green("✓")} ${S.green(String(p.toolName ?? "unknown"))} ${S.dim("→")} ${compactText(p.valuePreview, 200)}\n`);
      return;
    case "agent.tool.error":
      process.stdout.write(`  ${S.red("✗")} ${S.boldRed(String(p.toolName ?? "unknown"))} ${S.red(compactText(p.error, 200))}\n`);
      return;
    case "user.message": {
      const userContent = String(p.content ?? "").trim();
      if (userContent) {
        process.stdout.write(`\n${S.boldBlue("❯")} ${S.dim(userContent)}\n`);
      }
      return;
    }
    case "agent.complete":
      process.stdout.write(`  ${S.dim(`[完成: ${String(p.reason ?? "")}]`)}\n`);
      return;
    case "run.completed":
      process.stdout.write(`\n${S.green("✓")} ${S.boldGreen("运行完成")}\n`);
      return;
    case "run.failed":
      process.stdout.write(`\n${S.red("✗")} ${S.boldRed("运行失败:")} ${String(p.error ?? "")}\n`);
      return;
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const isInteractive = options.interactive === true;

  // Ink bridge + refs for interactive mode
  const inkBridge = new InkUserBridge();
  const waitForInputResolve = { current: null as ((text: string | null) => void) | null };
  const waitForInputFlag = { current: { set: (_v: boolean) => {} } };

  const waitForUserInput = isInteractive
    ? () => new Promise<string | null>((resolve) => {
        waitForInputResolve.current = resolve;
        waitForInputFlag.current.set(true);
      })
    : undefined;

  const runtime = await createIdeaAgentRuntime({
    configPath: options.configPath,
    runtime: {
      interactive: isInteractive,
      autoApproveSensitiveTools: options.autoApproveSensitiveTools,
      maxTurns: options.maxTurns,
      debugPrompts: options.debugPrompts,
    },
    userBridge: isInteractive ? inkBridge : undefined,
    waitForUserInput,
  });

  const initial = createInitialSession();

  // Run logger (best-effort)
  let runLogger: RunTextLogger | undefined;
  try {
    runLogger = await RunTextLogger.create({
      dataDir: runtime.settings.memory.dataDir,
      sessionId: initial.sessionId,
      runId: initial.runId,
    });
    process.stdout.write(`${S.dim("📄 Run log:")} ${S.gray(runLogger.filePath)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[WARN] 创建运行日志失败: ${message}\n`);
  }

  // Event stats + run logger listener (always active)
  const eventStats = new Map<string, number>();
  let logWriteWarned = false;
  const stopLogListen = runtime.eventBus.onAny((event) => {
    eventStats.set(event.name, (eventStats.get(event.name) ?? 0) + 1);
    if (runLogger) {
      void runLogger.logEvent(event).catch((err) => {
        if (logWriteWarned) return;
        logWriteWarned = true;
        process.stderr.write(`[WARN] 写入运行日志失败: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  });

  // Non-interactive: also render progress to stdout
  let stopProgressListen: (() => void) | undefined;
  if (!isInteractive) {
    stopProgressListen = runtime.eventBus.onAny(renderProgress);
    process.stdout.write(`\n${S.inverse(S.boldWhite(` ❯ IdeaAgent `))}\n`);
  }

  // Interactive: mount Ink app
  let inkInstance: { unmount(): void } | undefined;
  if (isInteractive) {
    const ink = await initInk();
    inkInstance = ink.render(
      React.createElement(App, {
        eventBus: runtime.eventBus,
        inkBridge,
        title: "IdeaAgent",
        waitForInputResolve,
        waitForInputFlag,
      }),
    );
  }

  try {
    const finalState = await runtime.runner.run(initial);

    // Unmount Ink before printing summary
    if (inkInstance) {
      inkInstance.unmount();
    }

    // Print summary
    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.boldCyan("IdeaAgent Run Summary")}\n\n`);
    const statusColor = finalState.status === "completed" ? S.boldGreen : S.boldRed;
    process.stdout.write(`  ${S.dim("status:")}       ${statusColor(finalState.status)}\n`);
    process.stdout.write(`  ${S.dim("turns:")}        ${S.white(String(finalState.turn))}\n`);
    process.stdout.write(`  ${S.dim("messages:")}     ${S.cyan(String(finalState.messages.length))}\n`);

    if (finalState.lastError) {
      process.stdout.write(`  ${S.dim("lastError:")}   ${S.red(finalState.lastError)}\n`);
    }

    process.stdout.write(`\n  ${S.dim("事件统计:")}\n`);
    for (const [name, count] of [...eventStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      process.stdout.write(`    ${S.gray(name)} ${S.dim("×")} ${S.white(String(count))}\n`);
    }
    process.stdout.write(`${S.horizontalRule()}\n`);

    if (runLogger) {
      await runLogger.logLine("--- summary ---");
      await runLogger.logLine(`status: ${finalState.status}`);
      await runLogger.logLine(`turns: ${finalState.turn}`);
      await runLogger.logLine(`messages: ${finalState.messages.length}`);
      if (finalState.lastError) {
        await runLogger.logLine(`lastError: ${finalState.lastError}`);
      }
      await runLogger.logLine("eventCounts:");
      for (const [name, count] of [...eventStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        await runLogger.logLine(`  ${name}: ${count}`);
      }
    }

    if (finalState.status !== "completed") {
      process.exitCode = 1;
    }
  } finally {
    stopLogListen();
    stopProgressListen?.();
    if (inkInstance) {
      inkInstance.unmount();
    }
    if (runLogger) {
      await runLogger.logLine(`endAt: ${new Date().toISOString()}`);
      await runLogger.close();
    }
    await runtime.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`IdeaAgent CLI failed: ${message}\n`);
  process.exit(1);
});
