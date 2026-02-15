import type { AgentDecision, LoopState } from "./types";

export interface MainAgent {
  decide(state: LoopState): Promise<AgentDecision>;
}
