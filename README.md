# Replicate Engine

An AI-powered website replication system that uses a builder agent and a verifier agent to iteratively match reference screenshots.

## Overview

Replicate Engine uses the `pi-coding-agent` SDK with Fireworks AI (Kimi K2.5) to replicate websites from reference screenshots. It manages the entire workflow:

1. Creates a fresh Vite React + TypeScript project
2. Starts the dev server so the site is live while the agent works
3. Runs a persistent builder agent against the images in `images/`
4. Captures screenshots of the current implementation into `output_images/`
5. Runs a fresh verifier agent that compares `images/` and `output_images/`
6. Loops until the verifier passes or fails the builder 5 times
7. Streams a structured transcript of builder/verifier output, tool calls, and file edits to the terminal

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────────┐
│  index.ts   │────▶│  Vite Project │────▶│  agent.ts orchestrator │
│ (host)      │     │  (output/)    │     │                        │
└─────────────┘     └──────────────┘     ├────────────────────────┤
                                          │ builder session        │
                                          │ screenshot capture     │
                                          │ verifier session       │
                                          └──────────┬─────────────┘
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │ Fireworks AI │
                                              │ (Kimi K2.5)  │
                                              └──────────────┘
```

- **index.ts** - Host orchestrator that creates project, rebuilds the image, and attaches to the container
- **agent.ts** - In-container orchestrator for the builder/verifier loop
- **prompts/builder-system.md** - System instructions for the builder agent
- **prompts/verifier-system.md** - System instructions for the verifier agent
- **output/** - The generated Vite project (gitignored)
- **images/** - Reference screenshots
- **output_images/** - Captured implementation screenshots

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
4. **Builder Session**: a persistent builder agent edits the project to match `./images/`
5. **Screenshot Capture**: `capture.ts` captures the current implementation into `output_images/`
6. **Verifier Session**: a fresh verifier agent compares `./images/` against `./output_images/`
7. **Compaction + Retry**: failed verifier feedback is fed back to the builder after compaction
8. **Completion**: the run ends with either `passed` or `max_fail_returned_last_attempt`

## Agent Capabilities

The builder agent has access to coding tools and the verifier agent has read-only tools plus `pass()` / `fail(report)`.

## Project Structure

```
.
├── agent.ts           # Builder/verifier orchestration loop
├── index.ts           # Host orchestrator
├── prompts/
│   ├── builder-system.md
│   └── verifier-system.md
├── images/            # Reference screenshots
├── output_images/     # Captured implementation screenshots
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

Edit the builder/verifier prompts in `agent.ts` and `prompts/*.md`:

```typescript
const nextBuilderPrompt = createInitialBuilderPrompt();
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
- The builder will be forced to keep working until it can submit a buildable project
- Check TypeScript errors in `output/`

**Website not loading?**
- Verify dev server is running: `curl http://localhost:5173`
- Check logs: `make logs`

## License

MIT
