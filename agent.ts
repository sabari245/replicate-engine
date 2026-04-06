import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const workspaceDir = process.env.WORKSPACE_DIR || "/workspace/output";
const devServerUrl = "http://127.0.0.1:5173";
const completionMarkerPath = join(workspaceDir, ".agent-completed.json");

const colors = {
  assistant: "\x1b[36m",
  dev: "\x1b[34m",
  bash: "\x1b[33m",
  file: "\x1b[35m",
  status: "\x1b[32m",
  error: "\x1b[31m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const toolCalls = new Map<string, { toolName: string; input: unknown }>();
let isCompleted = false;
let assistantLineOpen = false;

function ensureAssistantBreak() {
  if (!assistantLineOpen) {
    return;
  }

  process.stdout.write("\n");
  assistantLineOpen = false;
}

function printLine(color: string, label: string, message: string) {
  ensureAssistantBreak();
  process.stdout.write(`${color}${label}${colors.reset} ${message}\n`);
}

function printBlock(color: string, label: string, message: string) {
  const lines = message.split("\n");
  for (const line of lines) {
    printLine(color, label, line);
  }
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolCall(toolName: string, input: unknown) {
  const data = (input ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "bash":
      return {
        label: "bash",
        color: colors.bash,
        message: String(data.command ?? "").trim() || "(empty command)",
      };
    case "read":
      return {
        label: "read",
        color: colors.file,
        message: String(data.path ?? "(unknown path)"),
      };
    case "write":
      return {
        label: "write",
        color: colors.file,
        message: String(data.path ?? "(unknown path)"),
      };
    case "edit":
      return {
        label: "edit",
        color: colors.file,
        message: String(data.path ?? "(unknown path)"),
      };
    case "grep":
      return {
        label: "grep",
        color: colors.file,
        message: `${String(data.pattern ?? "")} ${colors.dim}${String(data.path ?? "").trim()}${colors.reset}`.trim(),
      };
    case "find":
      return {
        label: "find",
        color: colors.file,
        message: `${String(data.pattern ?? "")} ${colors.dim}${String(data.path ?? "").trim()}${colors.reset}`.trim(),
      };
    case "ls":
      return {
        label: "ls",
        color: colors.file,
        message: String(data.path ?? workspaceDir),
      };
    default:
      return {
        label: toolName,
        color: colors.bold,
        message: formatJson(input),
      };
  }
}

function summarizeToolResult(toolName: string, input: unknown, details: unknown, isError: boolean) {
  const data = (input ?? {}) as Record<string, unknown>;
  const detailText = details ? formatJson(details) : "";

  if (isError) {
    return detailText || "tool execution failed";
  }

  switch (toolName) {
    case "write":
    case "edit":
      return `updated ${String(data.path ?? "(unknown path)")}`;
    case "read":
      return `read ${String(data.path ?? "(unknown path)")}`;
    case "bash":
      return detailText || "command finished";
    default:
      return detailText || "completed";
  }
}

async function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  color: string,
  label: string,
) {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      printLine(color, label, line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    printLine(color, label, buffer);
  }
}

async function waitForDevServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await Bun.sleep(500);
  }

  throw new Error(`Dev server did not become ready at ${url} within ${timeoutMs}ms`);
}

await mkdir(workspaceDir, { recursive: true });
await rm(completionMarkerPath, { force: true });

printLine(colors.dev, "setup", `workspace: ${workspaceDir}`);
printLine(colors.dev, "setup", "starting dev server");

const serverProc = Bun.spawn({
  cmd: ["bun", "run", "dev", "--host", "0.0.0.0"],
  cwd: workspaceDir,
  stdout: "pipe",
  stderr: "pipe",
});

void pipeStream(serverProc.stdout, colors.dev, "dev");
void pipeStream(serverProc.stderr, colors.error, "dev!");

try {
  await waitForDevServer(devServerUrl);
  printLine(colors.status, "ready", `dev server is live at ${devServerUrl}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printLine(colors.error, "error", message);
  serverProc.kill();
  process.exit(1);
}

const agentDir = join(homedir(), ".pi", "agent");
await mkdir(agentDir, { recursive: true });

const systemPrompt = await readFile("/workspace/prompts/system.md", "utf-8").catch(() => {
  return "You are a web development agent. Create websites and call completed() when done.";
});

const completedTool = defineTool({
  name: "completed",
  label: "Completed",
  description:
    "Call this function ONLY when the web project is fully complete, verified with curl, and ready to hand over. This signals successful completion of the task.",
  parameters: Type.Object({}),
  async execute() {
    await writeFile(
      completionMarkerPath,
      `${JSON.stringify({ completedAt: new Date().toISOString(), devServerUrl }, null, 2)}\n`,
    );
    isCompleted = true;
    printLine(colors.status, "done", "completed() called");
    return {
      content: [{ type: "text", text: "Project marked as completed" }],
      details: { status: "success" },
    };
  },
});

const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => systemPrompt,
  appendSystemPromptOverride: () => [],
  extensionFactories: [
    (pi: ExtensionAPI) => {
      pi.registerTool(completedTool);

      pi.on("tool_call", async (event) => {
        toolCalls.set(event.toolCallId, { toolName: event.toolName, input: event.input });
        const summary = summarizeToolCall(event.toolName, event.input);
        printBlock(summary.color, summary.label, summary.message);
        return undefined;
      });

      pi.on("tool_result", async (event) => {
        const call = toolCalls.get(event.toolCallId) ?? {
          toolName: event.toolName,
          input: event.input,
        };

        const message = summarizeToolResult(call.toolName, call.input, event.details, event.isError);
        const color = event.isError ? colors.error : colors.status;
        const label = event.isError ? "fail" : "ok";

        printBlock(color, label, message);
        toolCalls.delete(event.toolCallId);
        return undefined;
      });
    },
  ],
});
await resourceLoader.reload();

const fireworksConfig = {
  providers: {
    fireworks: {
      baseUrl: "https://api.fireworks.ai/inference/v1",
      api: "openai-completions",
      apiKey: process.env.FIREWORKS_API_KEY || "",
      models: [
        {
          id: "accounts/fireworks/models/kimi-k2p5",
          name: "Kimi K2.5 (Fireworks)",
          reasoning: true,
          input: ["text"],
          contextWindow: 256000,
          maxTokens: 32768,
        },
      ],
    },
  },
};

const modelsPath = join(agentDir, "models.json");
await writeFile(modelsPath, JSON.stringify(fireworksConfig, null, 2));

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
const model = modelRegistry.find("fireworks", "accounts/fireworks/models/kimi-k2p5");

if (!model) {
  printLine(colors.error, "error", "Fireworks model not found. Make sure FIREWORKS_API_KEY is set.");
  process.exit(1);
}

printLine(colors.status, "model", model.name);

const { session } = await createAgentSession({
  cwd: workspaceDir,
  model,
  tools: createCodingTools(workspaceDir),
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  resourceLoader,
});

session.subscribe((event) => {
  if (event.type !== "message_update") {
    return;
  }

  const assistantEvent = event.assistantMessageEvent;

  if (assistantEvent.type === "text_delta") {
    if (!assistantLineOpen) {
      process.stdout.write(`${colors.assistant}agent${colors.reset} `);
      assistantLineOpen = true;
    }

    process.stdout.write(`${colors.assistant}${assistantEvent.delta}${colors.reset}`);
  }

  if (assistantEvent.type === "text_end") {
    ensureAssistantBreak();
  }
});

const userPrompt = `The Vite React + TypeScript project is already set up and the dev server is ALREADY RUNNING at http://localhost:5173.

DO NOT run 'bun run dev', 'npm run dev', or start any server process. The dev server is already running and its logs are already being streamed.

Your task:
1. Modify the existing App.tsx to create a simple blog website with a blog detailing the hello world text website
2. Verify the site is working by running: curl -s http://localhost:5173/ | head -20
3. Run 'bun run build' inside ${workspaceDir} to verify the production build succeeds
4. Call completed()`;

printLine(colors.status, "start", "starting agent session");

await session.prompt(userPrompt);

while (!isCompleted) {
  printLine(colors.dim, "wait", "agent has not called completed(); asking it to continue");
  await session.prompt(
    "Continue the task. If the project is complete, call completed(). Otherwise, keep working until it is complete."
  );
}

printLine(colors.status, "live", "agent finished; dev server is still running on http://localhost:5173");
printLine(colors.dim, "hint", "press Ctrl+C in the host terminal to stop the container");

const serverExitCode = await serverProc.exited;

if (serverExitCode !== 0) {
  printLine(colors.error, "error", `dev server exited with code ${serverExitCode}`);
  process.exit(serverExitCode);
}
