# IdeaAgent

## Project Overview

IdeaAgent is a TypeScript-based research idea generation agent. It automatically orchestrates web searches, academic paper retrieval, paper parsing, domain analysis, and peer review-style self-critique to generate research ideas. The agent is fully LLM-driven (no hardcoded workflows), with an extensible plugin architecture and dynamic workflow orchestration.

## Tech Stack

- **Language:** TypeScript 5.7.3
- **Runtime:** Node.js >= 20
- **Key Dependencies:** `fast-xml-parser` (XML parsing), `pdf-parse` (PDF extraction), `zod` (schema validation)
- **External Services:** OpenAI-compatible LLM API, ArXiv API, OpenAlex API, MinerU (optional PDF parsing)

## Commands

```bash
npm install                # Install dependencies
npm run build              # Compile TypeScript to dist/
npm run typecheck          # Type check without emitting

# Run
npm run start -- --goal "your research goal"
npm run start:interactive -- --goal "your goal"   # Interactive mode with user Q&A
npm run demo:core          # Run demo script
```

### CLI Parameters

- `--goal <text>` — Task objective (required)
- `--config <path>` — Config file path (default: `./idea-agent.config.json`)
- `--interactive` — Enable interactive mode
- `--auto-approve-sensitive-tools` — Skip approval for sensitive operations
- `--max-turns <n>` — Override max loop iterations

## Project Structure

```
src/idea-agent/
├── cli.ts                      # CLI entry point
├── index.ts                    # Main API exports
├── core/                       # Agent kernel & state management
│   ├── kernel.ts               # Main execution loop
│   ├── llm-main-agent.ts       # LLM-based decision maker
│   ├── state-machine.ts        # State transitions
│   ├── event-bus.ts            # Event publishing
│   ├── context-compactor.ts    # Context compression
│   ├── decision.ts             # Decision structures
│   ├── types.ts                # Core type definitions
│   └── error.ts                # Error handling
├── runtime/                    # Session & execution management
│   ├── session-runner.ts       # Session lifecycle
│   ├── user-bridge.ts          # User interaction
│   └── approval-gate.ts        # Sensitive action approval
├── memory/                     # Memory management (session/working/durable)
│   ├── manager.ts              # Memory orchestration
│   ├── store.ts                # File-based persistence
│   ├── retriever.ts            # Memory recall
│   ├── writer.ts               # Memory writing
│   └── types.ts                # Memory type definitions
├── capabilities/               # Framework abstractions
│   ├── tools/                  # Tool system
│   │   ├── registry.ts         # Tool registration
│   │   ├── invoker.ts          # Tool execution with timeout/retry
│   │   ├── configurable-tool.ts
│   │   ├── types.ts            # Tool protocol
│   │   ├── approval.ts         # Approval logic
│   │   ├── policy.ts           # Tool policies
│   │   └── adapters/           # MCP + local adapters
│   └── subagents/              # SubAgent system
│       ├── registry.ts         # SubAgent registration
│       ├── invoker.ts          # SubAgent execution
│       ├── configurable-subagent.ts
│       └── types.ts            # SubAgent protocol
├── plugins/builtin/            # Built-in plugin implementations
│   ├── plugin.ts               # Plugin registration entry
│   ├── clients/                # External API clients (arxiv, openalex, mineru)
│   ├── tools/                  # 10 built-in tools
│   └── subagents/              # 3 built-in subagents
├── config/                     # Configuration loaders
│   ├── settings.ts
│   ├── tool-config.ts
│   └── subagent-config.ts
├── observability/              # Logging, tracing, metrics, audit
└── data/venues/registry.json   # Conference/journal registry
```

## Architecture

### Core Loop

```
User Goal → Kernel → LLM Main Agent (decides action) → dispatch action
                ↓
    ┌───────────┼───────────┬──────────────┬──────────┐
  call_tool  call_subagent  ask_user    respond     finish
    ↓           ↓             ↓           ↓           ↓
 Tool Invoker  SubAgent    User Bridge  Direct     Complete
               Invoker                  Response
```

The kernel runs a loop: the LLM Main Agent inspects current state and decides the next action. No workflow is hardcoded — the LLM dynamically orchestrates tools and subagents.

### State Machine

States: `init` → `running` → `waiting_approval` / `waiting_user` → `completed` / `failed` / `aborted`

### Plugin System

Plugins register tools and subagents via `plugins/builtin/plugin.ts`. The framework layer (`capabilities/`) defines protocols and registries; the plugin layer provides concrete implementations.

**Built-in Tools:** `web-search`, `web-fetch`, `arxiv-search`, `openalex-search`, `venue-search`, `mineru-parse`, `pdf-parse-basic`, `scientific-calculator`, `python-exec`, `local-cli`

**Built-in SubAgents:** `deep-search-agent`, `paper-summary-agent`, `reviewer-agent`

### Memory System

Three tiers: session memory (current context), working memory (intermediate results), durable memory (long-term knowledge). All file-based persistence under `.idea-agent-data/`.

## Configuration

Three config files at project root:

| File | Purpose |
|------|---------|
| `idea-agent.config.json` | Main config: LLM settings, memory, runtime, context compaction |
| `tools.config.json` | Per-tool descriptions, input hints, extra config (API keys, URLs) |
| `subagents.config.json` | Per-subagent model, maxTurns, systemPrompt, allowedTools |

Example templates are provided as `*.config.example.json`.

### Key Environment Variables

- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` — LLM configuration
- `IDEA_AGENT_DATA_DIR` — Data directory override
- `IDEA_AGENT_INTERACTIVE` — Enable interactive mode
- `IDEA_AGENT_AUTO_APPROVE_SENSITIVE_TOOLS` — Auto-approve sensitive tools
- `IDEA_AGENT_TOOLS_CONFIG_PATH`, `IDEA_AGENT_SUBAGENTS_CONFIG_PATH` — Config path overrides

## Runtime Data

Output is stored under `.idea-agent-data/`:
- `logs/` — Execution logs
- `parsed-markdown/` — Parsed paper markdown
- `papers/` — Downloaded papers

## Code Conventions

- All source code is in `src/idea-agent/`, compiled output in `dist/`
- Core framework (`core/`, `capabilities/`, `runtime/`, `memory/`) is business-logic-free
- All business logic lives in `plugins/builtin/`
- Tools implement the `Tool` protocol from `capabilities/tools/types.ts`
- SubAgents implement the `SubAgent` protocol from `capabilities/subagents/types.ts`
- Schema validation uses `zod` throughout
- Structured events are published via `EventBus` for observability
- Sensitive tools require user approval unless `--auto-approve-sensitive-tools` is set

## Adding New Capabilities

### New Tool

1. Create a file in `plugins/builtin/tools/`
2. Implement the `Tool` interface (name, description, inputSchema, execute)
3. Register in `plugins/builtin/plugin.ts`
4. Add configuration in `tools.config.json`

### New SubAgent

1. Create a file in `plugins/builtin/subagents/`
2. Implement the `SubAgent` interface (name, description, run)
3. Register in `plugins/builtin/plugin.ts`
4. Add configuration in `subagents.config.json`
