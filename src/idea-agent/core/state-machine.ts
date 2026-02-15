import type { LoopStatus } from "./types";
import { KernelError } from "./error";

const ALLOWED: Record<LoopStatus, LoopStatus[]> = {
  init: ["running", "aborted"],
  running: ["waiting_approval", "waiting_user", "completed", "failed", "aborted", "running"],
  waiting_approval: ["running", "aborted", "failed"],
  waiting_user: ["running", "aborted", "failed"],
  completed: [],
  failed: [],
  aborted: [],
};

export class StateMachine {
  canTransition(from: LoopStatus, to: LoopStatus): boolean {
    return ALLOWED[from].includes(to);
  }

  transition(from: LoopStatus, to: LoopStatus): LoopStatus {
    if (!this.canTransition(from, to)) {
      throw new KernelError(`Invalid transition: ${from} -> ${to}`, "INVALID_STATE_TRANSITION");
    }
    return to;
  }
}
