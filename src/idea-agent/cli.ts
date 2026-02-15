import type { AgentEvent } from "./core/event-bus";
import { createIdeaAgentRuntime, createInitialState } from "./index";
import { RunTextLogger } from "./observability/run-text-logger";
import * as S from "./ui/styles";
import { Spinner } from "./ui/spinner";
import { renderMarkdown } from "./ui/markdown";

interface CliOptions {
  goal?: string;
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

    if (arg === "--goal" || arg === "-g") {
      options.goal = argv[index + 1];
      index += 1;
      continue;
    }

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

  if (!options.goal && positionals.length > 0) {
    options.goal = positionals.join(" ");
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(`\n${S.boldCyan("IdeaAgent CLI")}\n\n`);
  process.stdout.write(`${S.bold("Usage:")}\n`);
  process.stdout.write(`  ${S.dim("$")} ${S.white("node dist/idea-agent/cli.js")} ${S.yellow("--goal")} ${S.green('"你的任务目标"')}\n\n`);
  process.stdout.write(`${S.bold("Options:")}\n`);
  process.stdout.write(`  ${S.yellow("-g, --goal")} ${S.dim("<text>")}                     任务目标\n`);
  process.stdout.write(`  ${S.yellow("-c, --config")} ${S.dim("<path>")}                   配置文件路径\n`);
  process.stdout.write(`  ${S.yellow("-i, --interactive")}                     开启交互问答/审批\n`);
  process.stdout.write(`      ${S.yellow("--auto-approve-sensitive-tools")}    自动批准敏感工具\n`);
  process.stdout.write(`      ${S.yellow("--max-turns")} ${S.dim("<n>")}                   覆盖最大轮数\n`);
  process.stdout.write(`      ${S.yellow("--debug-prompts")}                   可视化显示每步完整提示词输入\n`);
  process.stdout.write(`  ${S.yellow("-h, --help")}                            显示帮助\n\n`);
}

function renderProgress(event: AgentEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  const compactText = (value: unknown, maxChars: number = 220): string => {
    const raw = typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

    if (raw.length <= maxChars) {
      return raw;
    }

    return `${raw.slice(0, maxChars)}...(truncated)`;
  };

  const renderDebugInput = (value: unknown): void => {
    const content = typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();

    process.stdout.write(`${S.boldYellow("⬡ LLM 提示词输入")}\n`);
    process.stdout.write(`${S.dim("─────BEGIN LLM PROMPT INPUT─────")}\n`);
    process.stdout.write(`${S.dimWhite(content)}\n`);
    process.stdout.write(`${S.dim("─────END LLM PROMPT INPUT───────")}\n`);
  };

  const describeToolInput = (toolId: string, input: Record<string, unknown>): string => {
    switch (toolId) {
      case "research-notebook": {
        const op = String(input.operation ?? "");
        const nbId = input.notebookId ? String(input.notebookId) : "";
        switch (op) {
          case "create":
            return `创建笔记本 (目标: ${compactText(input.goal, 80)})`;
          case "list":
            return "列出所有笔记本";
          case "view":
            return `查看 ${nbId} 概览`;
          case "view_question":
            return `查看 ${nbId} Q${input.questionId ?? "?"}`;
          case "add_questions": {
            const qs = Array.isArray(input.questions) ? input.questions : [];
            const preview = qs.slice(0, 2).map((q: unknown) => compactText(q, 40)).join("; ");
            const more = qs.length > 2 ? ` (+${qs.length - 2})` : "";
            return `为 ${nbId} 添加 ${qs.length} 个问题: ${preview}${more}`;
          }
          case "update_question":
            return `更新 ${nbId} Q${input.questionId ?? "?"} [${input.status ?? ""}]`;
          case "view_full":
            return `查看 ${nbId} 完整内容`;
          default:
            return `${op} ${nbId}`;
        }
      }
      case "web-search":
        return `query="${compactText(input.query, 60)}"`;
      case "web-fetch":
        return `${input.mode ?? "auto"} ${compactText(input.url, 80)}`;
      case "arxiv-search": {
        if (input.arxivId) return `论文 ${input.arxivId}`;
        if (Array.isArray(input.queries)) return `多查询(${input.queries.length}): ${compactText(input.queries.slice(0, 2).join("; "), 60)}`;
        return `query="${compactText(input.keywords ?? input.query, 60)}"`;
      }
      case "openalex-search": {
        const action = input.action ? String(input.action) : "search";
        if (input.arxivId) return `${action} arxiv:${input.arxivId}`;
        if (Array.isArray(input.queries)) return `${action}(${input.queries.length}): ${compactText(input.queries.slice(0, 2).join("; "), 60)}`;
        return `${action} "${compactText(input.keywords ?? input.query, 60)}"`;
      }
      case "venue-search":
        return `keyword="${input.keyword ?? ""}" area=${input.area ?? "all"}`;
      case "mineru-parse":
        return compactText(input.filePath ?? input.pdfUrl ?? "", 80);
      case "pdf-parse-basic":
        return compactText(input.filePath ?? input.pdfUrl ?? "", 80);
      case "scientific-calculator":
        return compactText(input.expression, 60);
      case "python-exec":
        return `code: ${compactText(input.code, 60)}`;
      case "local-cli": {
        const args = Array.isArray(input.args) ? ` ${input.args.join(" ")}` : "";
        return `$ ${input.command}${compactText(args, 60)}`;
      }
      case "read-session-files":
        return compactText(input.filePath, 80);
      default:
        return compactText(input, 80);
    }
  };

  const describeToolOutput = (toolId: string, data: unknown): string => {
    if (data == null) return "";
    const d = typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
    switch (toolId) {
      case "research-notebook": {
        if (!d) return "";
        if (d.notebookId && d.questionCount !== undefined) return `${d.notebookId} 已创建 (${d.questionCount} 个问题)`;
        if (Array.isArray(d.added)) return `已添加 ${d.added.length} 个问题`;
        if (d.updated === true) return "已更新";
        if (Array.isArray(d.notebooks)) return `共 ${d.notebooks.length} 个笔记本`;
        if (typeof data === "string") return compactText(data, 120);
        return "";
      }
      case "web-search": {
        if (!d) return "";
        const results = Array.isArray(d.results) ? d.results : [];
        return `${results.length} 条结果 (${d.provider ?? ""})`;
      }
      case "web-fetch": {
        if (!d) return "";
        if (d.mode === "download") return `已下载 → ${compactText(d.filePath, 60)}`;
        return `${d.mode ?? "text"} ${compactText(d.title ?? "", 50)} (${d.status ?? ""})`;
      }
      case "arxiv-search": {
        if (Array.isArray(data)) return `${data.length} 篇论文`;
        if (d && d.title) return `论文: ${compactText(d.title, 60)}`;
        return "";
      }
      case "openalex-search": {
        if (Array.isArray(data)) return `${data.length} 条结果`;
        if (d && d.title) return `论文: ${compactText(d.title, 60)}`;
        return compactText(data, 80);
      }
      case "venue-search": {
        if (!d) return "";
        const items = Array.isArray(d.data) ? d.data : [];
        return `${items.length} 个会议/期刊`;
      }
      case "mineru-parse": {
        if (!d) return "";
        const md = typeof d.markdown === "string" ? d.markdown : "";
        return `解析完成 (${md.length} 字符)${d.markdownPath ? ` → ${d.markdownPath}` : ""}`;
      }
      case "pdf-parse-basic": {
        if (!d) return "";
        return `提取文本 ${d.length ?? "?"} 字符`;
      }
      case "scientific-calculator":
        return d ? `= ${d.value}` : "";
      case "python-exec": {
        if (!d) return "";
        const stdout = typeof d.stdout === "string" ? d.stdout : "";
        return `exit=${d.exitCode}${stdout ? ` stdout: ${compactText(stdout, 60)}` : ""}`;
      }
      case "local-cli": {
        if (!d) return "";
        const stdout = typeof d.stdout === "string" ? d.stdout : "";
        return `exit=${d.exitCode}${stdout ? ` ${compactText(stdout, 60)}` : ""}`;
      }
      case "read-session-files": {
        if (!d) return "";
        return `${d.size ?? "?"} bytes (${d.encoding ?? "utf-8"})`;
      }
      default:
        return compactText(data, 80);
    }
  };

  switch (event.name) {
    case "turn.started": {
      const turn = payload.turn ?? event.turn;
      process.stdout.write(`\n${S.horizontalRule()}\n`);
      process.stdout.write(`${S.boldYellow("⟡")} ${S.boldWhite(`Turn ${String(turn)}`)} ${S.dim("思考中...")}\n`);
      return;
    }
    case "decision.produced": {
      const actions = Array.isArray(payload.actions) ? payload.actions : [];
      const notes = typeof payload.notes === "string" && payload.notes.length > 0
        ? compactText(payload.notes, 120)
        : "";
      const arrow = S.dim(" → ");
      const actionStr = actions.map((a: string) => S.cyan(a)).join(arrow) || S.dim("(none)");
      process.stdout.write(`  ${S.TREE.corner} ${S.dim("决策:")} ${actionStr}${notes ? `  ${S.dim("💭")} ${S.italic(S.gray(notes))}` : ""}\n`);
      return;
    }
    case "llm.prompt.input": {
      const source = String(payload.source ?? "unknown");
      process.stdout.write(`  ${S.dim("提示词来源:")} ${S.cyan(source)}\n`);
      renderDebugInput(payload.input);
      return;
    }
    case "tool.call.requested": {
      const toolId = String(payload.toolId ?? "unknown");
      const input = typeof payload.input === "object" && payload.input !== null
        ? payload.input as Record<string, unknown>
        : {};
      const detail = describeToolInput(toolId, input);
      process.stdout.write(`\n${S.dotCyan(S.boldCyan(toolId))}\n`);
      process.stdout.write(`  ${S.TREE.corner} ${S.dim(detail)}\n`);
      return;
    }
    case "tool.call.completed": {
      const toolId = String(payload.toolId ?? "unknown");
      const detail = describeToolOutput(toolId, payload.data);
      process.stdout.write(`  ${S.green("✓")} ${S.green(toolId)}${detail ? ` ${S.dim("→")} ${detail}` : ""}\n`);
      return;
    }
    case "tool.call.failed": {
      process.stdout.write(`  ${S.red("✗")} ${S.boldRed(String(payload.toolId ?? "unknown"))} ${S.red(String(payload.error ?? ""))}\n`);
      return;
    }
    case "subagent.call.requested": {
      const agentId = String(payload.subAgentId ?? "unknown");
      const task = typeof payload.task === "string" ? compactText(payload.task, 100) : "";
      process.stdout.write(`\n${S.dotBlue(S.boldBlue(`子代理: ${agentId}`))}\n`);
      if (task) process.stdout.write(`  ${S.TREE.corner} ${S.dim(task)}\n`);
      return;
    }
    case "subagent.progress": {
      const subAgentId = String(payload.subAgentId ?? "unknown");
      const stage = String(payload.stage ?? "unknown");
      const inner = (typeof payload.payload === "object" && payload.payload !== null
        ? payload.payload
        : {}) as Record<string, unknown>;

      const tag = `  ${S.TREE.pipe} ${S.dim(`[${subAgentId}]`)}`;

      switch (stage) {
        case "run.start": {
          const m = String(inner.model ?? "");
          const mt = String(inner.maxTurns ?? "");
          const tools = Array.isArray(inner.allowedTools)
            ? (inner.allowedTools as string[]).join(", ")
            : "";
          process.stdout.write(`${tag} ${S.dim("开始调研")} ${S.gray(`模型:${m} 轮数:${mt} 工具:[${tools}]`)}\n`);
          return;
        }
        case "turn.start": {
          const st = String(inner.subTurn ?? "?");
          const mt = String(inner.maxTurns ?? "?");
          process.stdout.write(`  ${S.TREE.tee} ${S.boldWhite(`第 ${st}/${mt} 轮`)}\n`);
          return;
        }
        case "decision.produced": {
          const notes = typeof inner.notes === "string" && inner.notes.length > 0
            ? compactText(inner.notes, 120)
            : "";
          const actionType = String(inner.actionType ?? "");
          const toolId = typeof inner.toolId === "string" ? inner.toolId : "";
          if (actionType === "call_tool" && toolId) {
            process.stdout.write(`  ${S.TREE.pipe}   ${S.TREE.corner} ${notes ? `${S.italic(S.gray(notes))} → ` : ""}${S.dim("调用")} ${S.cyan(toolId)}\n`);
          } else if (actionType === "finish") {
            process.stdout.write(`  ${S.TREE.pipe}   ${S.TREE.corner} ${notes ? `${S.italic(S.gray(notes))} → ` : ""}${S.dim("结束调研")}\n`);
          }
          return;
        }
        case "decision.failed": {
          const err = compactText(inner.error, 160);
          process.stdout.write(`  ${S.TREE.pipe}   ${S.yellow("⚠")} ${S.yellow("决策失败:")} ${err}\n`);
          return;
        }
        case "tool.rejected": {
          const tid = String(inner.toolId ?? "");
          process.stdout.write(`  ${S.TREE.pipe}   ${S.yellow("⚠")} ${S.yellow(`工具 ${tid} 未授权，跳过`)}\n`);
          return;
        }
        case "tool.call.start": {
          const tid = String(inner.toolId ?? "");
          const inp = compactText(inner.input, 160);
          process.stdout.write(`  ${S.TREE.pipe}   ${S.dotCyan(S.cyan(tid))} ${S.dim(inp)}\n`);
          return;
        }
        case "tool.call.success": {
          const tid = String(inner.toolId ?? "");
          const preview = compactText(inner.data, 200);
          process.stdout.write(`  ${S.TREE.pipe}   ${S.green("✓")} ${S.green(tid)} ${S.dim("→")} ${preview}\n`);
          return;
        }
        case "tool.call.failed": {
          const tid = String(inner.toolId ?? "");
          const err = compactText(inner.error, 200);
          process.stdout.write(`  ${S.TREE.pipe}   ${S.red("✗")} ${S.red(tid)} ${S.dim("→")} ${err}\n`);
          return;
        }
        case "tool.history.updated": {
          const tid = String(inner.toolId ?? "");
          const st = String(inner.subTurn ?? "?");
          const fb = inner.fallback === true;
          const preview = compactText(inner.resultPreview, 500);
          const len = inner.resultLength ? S.dim(` (${inner.resultLength} 字符)`) : "";
          if (fb) {
            const err = typeof inner.summaryError === "string" ? inner.summaryError : "unknown";
            process.stdout.write(`  ${S.TREE.pipe}   ${S.yellow("⚠")} ${S.yellow(`第${st}轮 ${tid} 总结失败:`)} ${compactText(err, 160)}\n`);
            process.stdout.write(`  ${S.TREE.pipe}   ${S.dim("降级结果")}${len}：${preview}\n`);
          } else {
            process.stdout.write(`  ${S.TREE.pipe}   ${S.dim(`第${st}轮 ${tid} 结果`)}${len}：${preview}\n`);
          }
          return;
        }
        case "run.finish": {
          const reason = String(inner.reason ?? "");
          const preview = compactText(inner.summaryPreview, 200);
          const reasonText = reason === "llm_finish" ? "证据充分" : reason === "max_turns" ? "达到最大轮数" : reason;
          process.stdout.write(`  ${S.green("✓")} ${S.boldGreen("调研完成")} ${S.dim(`(${reasonText})`)} ${S.dim("→")} ${preview}\n`);
          return;
        }
        case "run.force_finish.start": {
          process.stdout.write(`  ${S.TREE.pipe} ${S.yellow("⏳")} ${S.yellow("已达最大轮数，强制收尾中...")}\n`);
          return;
        }
        case "run.force_finish.success": {
          const preview = compactText(inner.summaryPreview, 200);
          process.stdout.write(`  ${S.green("✓")} ${S.boldGreen("强制收尾完成")} ${S.dim("→")} ${preview}\n`);
          return;
        }
        case "run.force_finish.failed": {
          const err = compactText(inner.error, 200);
          process.stdout.write(`  ${S.red("✗")} ${S.boldRed("强制收尾失败:")} ${err}\n`);
          return;
        }
        case "syscall.start": {
          const reqType = String(inner.requestType ?? "");
          const tid = String(inner.toolId ?? "");
          const said = String(inner.subAgentId ?? "");
          const target = reqType === "call_tool" ? `工具 ${S.cyan(tid)}` : `子代理 ${S.blue(said)}`;
          process.stdout.write(`  ${S.TREE.pipe}   ${S.dim("🔄 系统调用:")} ${target}\n`);
          return;
        }
        case "syscall.tool.done": {
          const tid = String(inner.toolId ?? "");
          const ok = inner.ok === true;
          process.stdout.write(`  ${S.TREE.pipe}   ${ok ? S.green("✓") : S.red("✗")} ${S.dim("系统调用工具完成:")} ${ok ? S.green(tid) : S.red(tid)}\n`);
          return;
        }
        case "syscall.subagent.done": {
          const said = String(inner.targetSubAgentId ?? "");
          const ok = inner.ok === true;
          process.stdout.write(`  ${S.TREE.pipe}   ${ok ? S.green("✓") : S.red("✗")} ${S.dim("系统调用子代理完成:")} ${ok ? S.green(said) : S.red(said)}\n`);
          return;
        }
        case "syscall.requested": {
          const st = String(inner.syscallType ?? "");
          process.stdout.write(`  ${S.TREE.pipe}   ${S.dim("📡 发起系统调用:")} ${S.cyan(st)}\n`);
          return;
        }
        case "syscall.completed": {
          process.stdout.write(`  ${S.TREE.pipe}   ${S.green("✓")} ${S.dim("系统调用完成")}\n`);
          return;
        }
        default: {
          const detail = compactText(inner, 260);
          process.stdout.write(`  ${S.TREE.pipe}   ${S.dim(stage)} ${S.dim("::")} ${detail}\n`);
          return;
        }
      }
    }
    case "subagent.call.completed": {
      const agentId = String(payload.subAgentId ?? "unknown");
      const result = typeof payload.subAgentResult === "string" ? compactText(payload.subAgentResult, 120) : "";
      process.stdout.write(`  ${S.green("✓")} ${S.boldGreen(`子代理完成: ${agentId}`)}${result ? ` ${S.dim("→")} ${result}` : ""}\n`);
      return;
    }
    case "subagent.call.failed": {
      process.stdout.write(`  ${S.red("✗")} ${S.boldRed(`子代理失败: ${String(payload.subAgentId ?? "unknown")}`)} ${S.red(String(payload.error ?? ""))}\n`);
      return;
    }
    case "user.question.requested": {
      process.stdout.write(`\n${S.dotYellow(S.boldYellow("正在向你提问..."))}\n`);
      return;
    }
    case "agent.respond.requested": {
      process.stdout.write(`\n${S.dotBlue(S.boldBlue("正在输出回复..."))}\n`);
      return;
    }
    case "agent.respond.completed": {
      process.stdout.write(`  ${S.green("✓")} ${S.dim("回复已输出")}\n`);
      return;
    }
    case "error.detail": {
      const source = String(payload.source ?? "unknown");
      const errorMsg = String(payload.error ?? "");
      process.stdout.write(`\n${S.dotRed(S.boldRed(`错误 [${source}]`))}\n`);
      process.stdout.write(`  ${S.TREE.corner} ${S.red(compactText(errorMsg, 200))}\n`);
      return;
    }
    default:
      return;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const runtime = await createIdeaAgentRuntime({
    configPath: options.configPath,
    runtime: {
      interactive: options.interactive,
      autoApproveSensitiveTools: options.autoApproveSensitiveTools,
      maxTurns: options.maxTurns,
      debugPrompts: options.debugPrompts,
    },
  });

  const goal = options.goal ?? "请先澄清任务目标，然后执行研究与评审流程";
  const initial = createInitialState(goal);

  let runLogger: RunTextLogger | undefined;
  try {
    runLogger = await RunTextLogger.create({
      dataDir: runtime.settings.memory.dataDir,
      sessionId: initial.sessionId,
      runId: initial.runId,
      goal,
    });
    process.stdout.write(`${S.dim("📄 Run log:")} ${S.gray(runLogger.filePath)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[WARN] 创建运行日志失败: ${message}\n`);
  }

  const eventStats = new Map<string, number>();
  let logWriteWarned = false;
  const stopListen = runtime.eventBus.onAny((event) => {
    eventStats.set(event.name, (eventStats.get(event.name) ?? 0) + 1);
    renderProgress(event);

    if (runLogger) {
      void runLogger.logEvent(event).catch((error) => {
        if (logWriteWarned) {
          return;
        }
        logWriteWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[WARN] 写入运行日志失败: ${message}\n`);
      });
    }
  });

  process.stdout.write(`\n${S.inverse(S.boldWhite(` ❯ ${goal} `))}\n`);

  try {
    const finalState = await runtime.runner.run(initial);

    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.boldCyan("IdeaAgent Run Summary")}\n\n`);
    const statusColor = finalState.status === "completed" ? S.boldGreen : S.boldRed;
    process.stdout.write(`  ${S.dim("status:")}       ${statusColor(finalState.status)}\n`);
    process.stdout.write(`  ${S.dim("turn:")}         ${S.white(String(finalState.turn))}\n`);
    process.stdout.write(`  ${S.dim("goal:")}         ${S.white(finalState.goal ?? "")}\n`);
    process.stdout.write(`  ${S.dim("toolResults:")}  ${S.cyan(String(finalState.toolResults.length))}\n`);
    process.stdout.write(`  ${S.dim("subAgents:")}    ${S.cyan(String(finalState.subAgentResults.length))}\n`);
    process.stdout.write(`  ${S.dim("memory:")}       ${S.cyan(String(finalState.memorySnapshot.total ?? 0))}\n`);

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
      await runLogger.logLine(`turn: ${finalState.turn}`);
      await runLogger.logLine(`goal: ${finalState.goal ?? ""}`);
      await runLogger.logLine(`toolResults: ${finalState.toolResults.length}`);
      await runLogger.logLine(`subAgentResults: ${finalState.subAgentResults.length}`);
      await runLogger.logLine(`memory.total: ${String(finalState.memorySnapshot.total ?? 0)}`);
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
    stopListen();
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
