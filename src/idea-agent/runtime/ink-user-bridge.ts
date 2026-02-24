import type { UserBridge } from "./user-bridge";
import type { AskUserQuestion } from "../core/types";

export type AskCallback = (question: AskUserQuestion) => Promise<string>;
export type RespondCallback = (message: string) => void;

export class InkUserBridge implements UserBridge {
  private askCb: AskCallback | undefined;
  private respondCb: RespondCallback | undefined;

  setAskCallback(cb: AskCallback) { this.askCb = cb; }
  setRespondCallback(cb: RespondCallback) { this.respondCb = cb; }

  async ask(question: AskUserQuestion): Promise<string> {
    if (!this.askCb) {
      return `${question.options[0]?.id}: ${question.options[0]?.text}`;
    }
    return this.askCb(question);
  }

  async respond(message: string): Promise<void> {
    this.respondCb?.(message);
  }
}
