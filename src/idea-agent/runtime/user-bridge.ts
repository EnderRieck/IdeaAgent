import type { AskUserOption, AskUserQuestion } from "../core/types";
import * as S from "../ui/styles";
import { renderMarkdown } from "../ui/markdown";

export interface UserBridge {
  ask(question: AskUserQuestion): Promise<string>;
  respond(message: string): Promise<void>;
}

function normalizeText(value: string): string {
  return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(question: AskUserQuestion): AskUserQuestion {
  const prompt = normalizeText(question.prompt);
  const details = typeof question.details === "string" ? normalizeText(question.details) : undefined;
  const options = normalizeOptions(question.options);

  return {
    prompt: prompt.length > 0 ? prompt : "请选择",
    details: details && details.length > 0 ? details : undefined,
    options,
    allowMultiple: question.allowMultiple === true,
  };
}

function normalizeOptions(options?: AskUserOption[]): AskUserOption[] {
  if (!options || options.length === 0) {
    return [];
  }

  const normalized = options
    .map((option, index) => {
      const id = normalizeText(option.id || `O${index + 1}`);
      const text = normalizeText(option.text || "");
      return {
        id: id.length > 0 ? id : `O${index + 1}`,
        text,
      };
    })
    .filter((option) => option.text.length > 0);

  const deduped: AskUserOption[] = [];
  const seenId = new Set<string>();
  for (const option of normalized) {
    if (seenId.has(option.id)) {
      let suffix = 2;
      let nextId = `${option.id}_${suffix}`;
      while (seenId.has(nextId)) {
        suffix += 1;
        nextId = `${option.id}_${suffix}`;
      }
      deduped.push({ id: nextId, text: option.text });
      seenId.add(nextId);
    } else {
      deduped.push(option);
      seenId.add(option.id);
    }
  }

  return deduped;
}

/* ── interactive arrow-key select (zero dependencies) ───── */

interface SelectResult {
  selected: AskUserOption[];
}

async function interactiveSelect(
  options: AskUserOption[],
  allowMultiple: boolean,
): Promise<SelectResult> {
  const totalItems = options.length;
  let cursor = 0;
  const checked = new Set<number>();

  const write = (s: string) => process.stdout.write(s);
  const hideCursor = () => write("\x1b[?25l");
  const showCursor = () => write("\x1b[?25h");

  const totalLines = totalItems * 2 - 1;

  function render(firstTime: boolean) {
    if (!firstTime) {
      write(`\x1b[${totalLines}A`);
    }
    for (let i = 0; i < totalItems; i++) {
      write("\x1b[2K");
      const isActive = i === cursor;
      const opt = options[i];
      const ptr = isActive ? S.cyan("❯") : " ";
      if (allowMultiple) {
        const box = checked.has(i) ? S.green("◉") : S.dim("◯");
        const text = isActive ? S.cyan(opt.text) : opt.text;
        write(`  ${ptr} ${box} ${text}`);
      } else {
        const dot = isActive ? S.cyan("●") : S.dim("●");
        const text = isActive ? S.cyan(opt.text) : opt.text;
        write(`  ${ptr} ${dot} ${text}`);
      }
      write("\n");
      if (i < totalItems - 1) {
        write("\x1b[2K\n");
      }
    }
  }

  hideCursor();
  render(true);

  return new Promise<SelectResult>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      showCursor();
    }

    function onData(buf: Buffer) {
      const key = buf.toString();

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + totalItems) % totalItems;
        render(false);
        return;
      }
      if (key === "\x1b[B") {
        cursor = (cursor + 1) % totalItems;
        render(false);
        return;
      }
      if (key === " " && allowMultiple) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render(false);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        if (allowMultiple) {
          if (checked.size === 0) checked.add(cursor);
          const result = [...checked].sort((a, b) => a - b).map((i) => options[i]);
          resolve({ selected: result });
        } else {
          resolve({ selected: [options[cursor]] });
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

export class AutoUserBridge implements UserBridge {
  async ask(question: AskUserQuestion): Promise<string> {
    const normalized = normalizeQuestion(question);
    return `${normalized.options[0].id}: ${normalized.options[0].text}`;
  }

  async respond(message: string): Promise<void> {
    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotGreen(S.boldGreen("Agent 回复"))}\n\n`);
    process.stdout.write(`${renderMarkdown(message)}\n`);
    process.stdout.write(`${S.horizontalRule()}\n`);
  }
}

export class InteractiveUserBridge implements UserBridge {
  async ask(question: AskUserQuestion): Promise<string> {
    const normalized = normalizeQuestion(question);
    const options = normalized.options;

    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotYellow(S.boldYellow("提问"))} ${S.boldWhite(normalized.prompt)}\n`);
    if (normalized.details) {
      process.stdout.write(`  ${S.dim("说明:")} ${normalized.details}\n`);
    }

    if (process.stdin.isTTY) {
      const mode = normalized.allowMultiple ? "多选" : "单选";
      const keys = normalized.allowMultiple
        ? "↑↓ 移动 · Space 选中 · Enter 确认"
        : "↑↓ 移动 · Enter 确认";
      process.stdout.write(`  ${S.dim(`[${mode}] ${keys}`)}\n\n`);

      const result = await interactiveSelect(options, normalized.allowMultiple === true);
      if (result.selected.length === 1) {
        return `${result.selected[0].id}: ${result.selected[0].text}`;
      }
      return result.selected.map((o) => `${o.id}: ${o.text}`).join(" | ");
    }

    // Non-TTY fallback: print options and read number input
    process.stdout.write(`\n  ${S.dim("选项:")}\n`);
    for (const [index, option] of options.entries()) {
      process.stdout.write(`    ${S.boldBlue(`${index + 1}.`)} ${option.text}\n`);
    }
    process.stdout.write(`\n  ${S.dim("请输入选项编号：")}\n`);
    const rl = (await import("node:readline/promises")).default.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (await rl.question(`${S.green("❯")} `)).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        const opt = options[index - 1];
        return `${opt.id}: ${opt.text}`;
      }
      return `${options[0].id}: ${options[0].text}`;
    } finally {
      rl.close();
    }
  }

  async respond(message: string): Promise<void> {
    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotGreen(S.boldGreen("Agent 回复"))}\n\n`);
    process.stdout.write(`${renderMarkdown(message)}\n`);
    process.stdout.write(`${S.horizontalRule()}\n`);
  }

}

export class ConsoleUserBridge extends AutoUserBridge {}
