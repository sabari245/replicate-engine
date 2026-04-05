# Replicate Engine

An AI-powered web development agent system that autonomously creates, builds, and verifies websites using LLMs.

## Overview

Replicate Engine uses the `pi-coding-agent` SDK with Fireworks AI (Kimi K2.5) to create websites from natural language prompts. It manages the entire workflow:

1. Creates a fresh Vite React + TypeScript project
2. Starts the dev server so the site is live while the agent works
3. Runs an AI agent to implement the requested features
4. Verifies the dev server works with `curl`
5. Builds the production bundle
6. Streams a structured transcript of assistant output, tool calls, and file edits to the terminal

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  index.ts   │────▶│  Vite Project │────▶│  Agent.ts   │
│ (host)      │     │  (output/)    │     │ (in process)│
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                  │
                                                  ▼
                                           ┌──────────────┐
                                           │ Fireworks AI │
                                           │ (Kimi K2.5)  │
                                           └──────────────┘
```

- **index.ts** - Host orchestrator that creates project, rebuilds the image, and attaches to the container
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
# Run the full session (resets output/, starts the container, streams the transcript)
bun run index.ts
```

### Using Make

```bash
# Run the agent
make run

# View logs
make logs

# View website
make view

# Stop everything
make stop

# Clean and restart
make clean run
```

### Manual Steps

```bash
# 1. Create project and run the attached session
bun run index.ts

# 2. In another terminal, follow the same container logs if needed
make logs

# 3. View the website (once dev server starts)
curl http://localhost:5173
open http://localhost:5173  # or open in browser
```

## How It Works

1. **Project Reset**: `index.ts` clears `output/` and creates a fresh Vite React + TS project
2. **Container Rebuild**: `index.ts` rebuilds the Docker image and starts the container in attached mode
3. **Dev Server**: `agent.ts` starts `bun run dev --host 0.0.0.0` so the site is live on port 5173
4. **Agent Session**: `agent.ts` connects to Fireworks AI (Kimi K2.5) with web development tools
5. **Structured Transcript**: assistant text, tool calls, file edits, and dev server logs are streamed to the terminal
6. **Verification**: the agent verifies the site works with `curl` before completing
7. **Build Check**: the agent runs `bun run build` to ensure the production build succeeds
8. **Completion**: the container stays alive after `completed()` so the dev server remains available

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
├── index.ts           # Host orchestrator
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

Edit `index.ts` or `agent.ts` to use a different Fireworks model:

```typescript
{
  id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
  name: "Llama 3.1 405B",
  // ...
}
```

### Change the Prompt

Edit the user prompt in `agent.ts`:

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
- Check the attached terminal output or `make logs` for errors
- Verify `FIREWORKS_API_KEY` is set
- Ensure port 5173 is available

**Build fails?**
- The agent will retry automatically
- Check TypeScript errors in `output/`

**Website not loading?**
- Verify dev server is running: `curl http://localhost:5173`
- Check logs: `make logs`

## License

MIT
