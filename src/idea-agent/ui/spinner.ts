/**
 * Terminal spinner — animated thinking indicator.
 *
 * Similar to Claude Code's "Billowing…" / "Thinking…" animation.
 */

import * as S from "./styles";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private text: string;
  private startTime = 0;

  constructor(text: string = "思考中") {
    this.text = text;
  }

  start(text?: string): void {
    if (text) this.text = text;
    if (this.timer) return;

    this.startTime = Date.now();
    this.frameIndex = 0;
    this.render();

    this.timer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  update(text: string): void {
    this.text = text;
  }

  stop(finalText?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearLine();
    if (finalText) {
      process.stdout.write(`${finalText}\n`);
    }
  }

  private render(): void {
    this.clearLine();
    const frame = S.yellow(SPINNER_FRAMES[this.frameIndex]);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const label = S.boldYellow(this.text);
    const time = S.dim(`(${elapsed}s)`);
    process.stdout.write(`${frame} ${label} ${time}`);
  }

  private clearLine(): void {
    process.stdout.write("\r\x1b[K");
  }
}
