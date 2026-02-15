/**
 * Terminal ANSI style utilities — zero dependencies.
 *
 * Provides chainable helpers for colors, bold, dim, underline, etc.
 * Automatically detects whether the terminal supports colors.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/* ── capability detection ─────────────────────────────────── */

function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  if (!process.stdout.isTTY) return false;
  const term = process.env.TERM ?? "";
  if (term === "dumb") return false;
  return true;
}

const enabled = supportsColor();

/* ── low-level wrap ───────────────────────────────────────── */

function wrap(open: string, close: string, text: string): string {
  if (!enabled) return text;
  return `${open}${text}${close}`;
}

/* ── modifiers ────────────────────────────────────────────── */

export function bold(t: string): string {
  return wrap(`${ESC}1m`, RESET, t);
}
export function dim(t: string): string {
  return wrap(`${ESC}2m`, RESET, t);
}
export function italic(t: string): string {
  return wrap(`${ESC}3m`, RESET, t);
}
export function underline(t: string): string {
  return wrap(`${ESC}4m`, RESET, t);
}
export function inverse(t: string): string {
  return wrap(`${ESC}7m`, RESET, t);
}
export function strikethrough(t: string): string {
  return wrap(`${ESC}9m`, RESET, t);
}

/* ── foreground colors ────────────────────────────────────── */

export function black(t: string): string {
  return wrap(`${ESC}30m`, RESET, t);
}
export function red(t: string): string {
  return wrap(`${ESC}31m`, RESET, t);
}
export function green(t: string): string {
  return wrap(`${ESC}32m`, RESET, t);
}
export function yellow(t: string): string {
  return wrap(`${ESC}33m`, RESET, t);
}
export function blue(t: string): string {
  return wrap(`${ESC}34m`, RESET, t);
}
export function magenta(t: string): string {
  return wrap(`${ESC}35m`, RESET, t);
}
export function cyan(t: string): string {
  return wrap(`${ESC}36m`, RESET, t);
}
export function white(t: string): string {
  return wrap(`${ESC}37m`, RESET, t);
}
export function gray(t: string): string {
  return wrap(`${ESC}90m`, RESET, t);
}

/* ── bright foreground ────────────────────────────────────── */

export function brightRed(t: string): string {
  return wrap(`${ESC}91m`, RESET, t);
}
export function brightGreen(t: string): string {
  return wrap(`${ESC}92m`, RESET, t);
}
export function brightYellow(t: string): string {
  return wrap(`${ESC}93m`, RESET, t);
}
export function brightBlue(t: string): string {
  return wrap(`${ESC}94m`, RESET, t);
}
export function brightCyan(t: string): string {
  return wrap(`${ESC}96m`, RESET, t);
}
export function brightWhite(t: string): string {
  return wrap(`${ESC}97m`, RESET, t);
}

/* ── background colors ────────────────────────────────────── */

export function bgBlack(t: string): string {
  return wrap(`${ESC}40m`, RESET, t);
}
export function bgRed(t: string): string {
  return wrap(`${ESC}41m`, RESET, t);
}
export function bgGreen(t: string): string {
  return wrap(`${ESC}42m`, RESET, t);
}
export function bgBlue(t: string): string {
  return wrap(`${ESC}44m`, RESET, t);
}
export function bgCyan(t: string): string {
  return wrap(`${ESC}46m`, RESET, t);
}
export function bgWhite(t: string): string {
  return wrap(`${ESC}47m`, RESET, t);
}
export function bgGray(t: string): string {
  return wrap(`${ESC}100m`, RESET, t);
}

/* ── 256-color helpers ────────────────────────────────────── */

export function fg256(code: number, t: string): string {
  return wrap(`${ESC}38;5;${code}m`, RESET, t);
}
export function bg256(code: number, t: string): string {
  return wrap(`${ESC}48;5;${code}m`, RESET, t);
}

/* ── composite helpers ────────────────────────────────────── */

export function boldCyan(t: string): string {
  return bold(cyan(t));
}
export function boldGreen(t: string): string {
  return bold(green(t));
}
export function boldRed(t: string): string {
  return bold(red(t));
}
export function boldYellow(t: string): string {
  return bold(yellow(t));
}
export function boldBlue(t: string): string {
  return bold(blue(t));
}
export function boldWhite(t: string): string {
  return bold(white(t));
}
export function dimWhite(t: string): string {
  return dim(white(t));
}

/* ── layout helpers ───────────────────────────────────────── */

export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

export function horizontalRule(char: string = "─"): string {
  const width = getTerminalWidth();
  return gray(char.repeat(width));
}

export function indent(text: string, spaces: number = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/* ── status dots (Claude Code style) ─────────────────────── */

export function dotGreen(label: string): string {
  return `${green("●")} ${label}`;
}
export function dotYellow(label: string): string {
  return `${yellow("●")} ${label}`;
}
export function dotRed(label: string): string {
  return `${red("●")} ${label}`;
}
export function dotBlue(label: string): string {
  return `${blue("●")} ${label}`;
}
export function dotCyan(label: string): string {
  return `${cyan("●")} ${label}`;
}

/* ── tree connectors ──────────────────────────────────────── */

export const TREE = {
  pipe: gray("│"),
  tee: gray("├"),
  corner: gray("└"),
  dash: gray("─"),
} as const;

export { enabled as colorEnabled, RESET };
