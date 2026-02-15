import * as S from "../ui/styles";

export class Logger {
  info(message: string, payload?: unknown): void {
    const tag = S.boldCyan("[INFO]");
    process.stdout.write(`${tag} ${message}${payload ? ` ${S.dim(JSON.stringify(payload))}` : ""}\n`);
  }

  warn(message: string, payload?: unknown): void {
    const tag = S.boldYellow("[WARN]");
    process.stdout.write(`${tag} ${S.yellow(message)}${payload ? ` ${S.dim(JSON.stringify(payload))}` : ""}\n`);
  }

  error(message: string, payload?: unknown): void {
    const tag = S.boldRed("[ERROR]");
    process.stderr.write(`${tag} ${S.red(message)}${payload ? ` ${S.dim(JSON.stringify(payload))}` : ""}\n`);
  }
}
