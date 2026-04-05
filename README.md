# Replicate Engine

An AI-powered web development agent system that autonomously creates, builds, and verifies websites using LLMs.

## Overview

Replicate Engine uses the `pi-coding-agent` SDK with Fireworks AI (Kimi K2.5) to create websites from natural language prompts. It manages the entire workflow:

1. Creates a fresh Vite React + TypeScript project
2. Runs an AI agent to implement the requested features
3. Verifies the dev server works with `curl`
4. Builds the production bundle
5. Signals completion when everything is verified

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   run.ts    │────▶│  Vite Project │────▶│  Agent.ts   │
│ (host)      │     │  (output/)    │     │ (in process)│
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                  │
                                                  ▼
                                           ┌──────────────┐
                                           │ Fireworks AI │
                                           │ (Kimi K2.5)  │
                                           └──────────────┘
```

- **run.ts** - Host orchestrator that creates project and starts agent
- **agent.ts** - Agent session that runs inside the process
- **prompts/system.md** - System instructions for the web dev agent
- **output/** - The generated Vite project (gitignored)

## Prerequisites

- [Bun](https://bun.sh/) 1.2+
- Fireworks AI API key

## Installation

```bash
git clone https://github.com/sabari245/replicate-engine.git
cd replicate-engine
bun install
```

## Configuration

Set your Fireworks AI API key:

```bash
export FIREWORKS_API_KEY=fw_xxxxxxxxxxxxxxxx
```

## Usage

### Quick Start

```bash
# Run the agent (creates project, starts dev server, modifies files)
bun run run.ts
```

### Using Make

```bash
# Run the agent
make run

# View logs
make logs

# View website
make open

# Stop everything
make stop

# Clean and restart
make clean run
```

### Manual Steps

```bash
# 1. Create project and run agent
bun run run.ts

# 2. In another terminal, view logs
tail -f agent.log

# 3. View the website (once dev server starts)
curl http://localhost:5173
open http://localhost:5173  # or open in browser
```

## How It Works

1. **Project Creation**: `run.ts` clears `output/` and creates a fresh Vite React + TS project
2. **Dev Server**: Starts `bun run dev` in the background on port 5173
3. **Agent Session**: Connects to Fireworks AI (Kimi K2.5) with web development tools
4. **File Operations**: Agent can read/write/edit files, run commands, fetch URLs
5. **Verification**: Agent verifies the site works with `curl` before completing
6. **Build Check**: Agent runs `bun run build` to ensure production build succeeds
7. **Completion**: Agent calls `completed()` tool when everything is verified

## Agent Capabilities

The web development agent has access to:

- **File Operations**: Read, write, edit files in the project
- **Command Execution**: Run any shell command (bun install, build, etc.)
- **HTTP Requests**: Fetch URLs, verify endpoints with curl
- **System Prompt**: Detailed instructions in `prompts/system.md`

## Project Structure

```
.
├── agent.ts           # Agent session (runs inside process)
├── run.ts             # Host orchestrator
├── index.ts           # Docker container version (alternative)
├── prompts/
│   └── system.md      # Agent system instructions
├── output/            # Generated Vite project (gitignored)
├── Dockerfile         # Container setup
├── docker-compose.yml # Container orchestration
├── Makefile           # Useful commands
└── package.json
```

## Customization

### Change the Model

Edit `run.ts` or `agent.ts` to use a different Fireworks model:

```typescript
{
  id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
  name: "Llama 3.1 405B",
  // ...
}
```

### Change the Prompt

Edit the user prompt in `run.ts`:

```typescript
const userPrompt = "Create a portfolio website with dark theme";
```

### Use Docker

```bash
docker-compose up --build
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FIREWORKS_API_KEY` | Fireworks AI API key | Required |
| `WORKSPACE_DIR` | Working directory for agent | `output/` |

## Troubleshooting

**Agent not making changes?**
- Check `agent.log` for errors
- Verify `FIREWORKS_API_KEY` is set
- Ensure port 5173 is available

**Build fails?**
- The agent will retry automatically
- Check TypeScript errors in `output/`

**Website not loading?**
- Verify dev server is running: `curl http://localhost:5173`
- Check logs: `tail -f agent.log`

## License

MIT
