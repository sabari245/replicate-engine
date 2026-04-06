import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { captureScreenshots } from "./capture.ts";

const workspaceRoot = "/workspace";
const workspaceDir = process.env.WORKSPACE_DIR || "/workspace/output";
const devServerUrl = "http://127.0.0.1:5173";
const referenceImagesDir = join(workspaceRoot, "images");
const outputImagesDir = join(workspaceRoot, "output_images");
const workspaceReferenceLink = join(workspaceDir, "images");
const workspaceOutputLink = join(workspaceDir, "output_images");
const resultMarkerPath = join(workspaceDir, ".agent-result.json");
const lastVerifierReportPath = join(workspaceDir, ".verifier-last-report.md");
const artifactsDir = join(workspaceDir, ".artifacts");
const maxVerifierFailures = 5;

const colors = {
  builder: "\x1b[36m",
  verifier: "\x1b[35m",
  dev: "\x1b[34m",
  bash: "\x1b[33m",
  file: "\x1b[35m",
  status: "\x1b[32m",
  error: "\x1b[31m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

type RoleName = "builder" | "verifier";

type RunStatus = "passed" | "max_fail_returned_last_attempt";

type VerifierDecision =
  | { status: "pending" }
  | { status: "passed" }
  | { status: "failed"; report: string };

let activeAssistantRole: RoleName | null = null;

function ensureAssistantBreak() {
  if (activeAssistantRole === null) {
    return;
  }

  process.stdout.write("\n");
  activeAssistantRole = null;
}

function printLine(color: string, label: string, message: string) {
  ensureAssistantBreak();
  process.stdout.write(`${color}${label}${colors.reset} ${message}\n`);
}

function printBlock(color: string, label: string, message: string) {
  for (const line of message.split("\n")) {
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
    case "submit_for_verification":
      return {
        label: "submit",
        color: colors.status,
        message: "builder submitted the current implementation for review",
      };
    case "pass":
      return {
        label: "pass",
        color: colors.status,
        message: "verifier accepted the implementation",
      };
    case "fail":
      return {
        label: "fail",
        color: colors.error,
        message: "verifier reported replication issues",
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
    case "submit_for_verification":
      return "waiting for screenshot capture and verification";
    case "pass":
      return "verification passed";
    case "fail":
      return "verification failed with a report";
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

async function ensureWorkspaceLinks() {
  await rm(workspaceReferenceLink, { recursive: true, force: true });
  await rm(workspaceOutputLink, { recursive: true, force: true });
  await symlink(referenceImagesDir, workspaceReferenceLink);
  await symlink(outputImagesDir, workspaceOutputLink);
}

async function archiveRoundArtifacts(round: number, report: string | null) {
  const roundDir = join(artifactsDir, `round-${round}`);
  const roundImagesDir = join(roundDir, "output_images");

  await mkdir(roundImagesDir, { recursive: true });

  const imageNames = await readdir(outputImagesDir).catch(() => []);
  for (const imageName of imageNames) {
    await copyFile(join(outputImagesDir, imageName), join(roundImagesDir, imageName));
  }

  if (report !== null) {
    await writeFile(join(roundDir, "verifier-report.md"), `${report.trim()}\n`);
  }
}

async function writeFinalResult(status: RunStatus, rounds: number, verifierFailures: number, finalReportPath: string | null) {
  await writeFile(
    resultMarkerPath,
    `${JSON.stringify({
      status,
      rounds,
      verifierFailures,
      referenceDir: referenceImagesDir,
      outputDir: outputImagesDir,
      finalReportPath,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

function roleColor(role: RoleName) {
  return role === "builder" ? colors.builder : colors.verifier;
}

async function loadPrompt(path: string, fallback: string) {
  return await readFile(path, "utf-8").catch(() => fallback);
}

async function createRoleSession(options: {
  role: RoleName;
  systemPromptPath: string;
  systemPromptFallback: string;
  tools: ReturnType<typeof createCodingTools> | ReturnType<typeof createReadOnlyTools>;
  customTools: ReturnType<typeof defineTool>[];
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}) {
  const systemPrompt = await loadPrompt(options.systemPromptPath, options.systemPromptFallback);
  const toolCalls = new Map<string, { toolName: string; input: unknown }>();

  const resourceLoader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      (pi: ExtensionAPI) => {
        for (const tool of options.customTools) {
          pi.registerTool(tool);
        }

        pi.on("tool_call", async (event) => {
          toolCalls.set(event.toolCallId, { toolName: event.toolName, input: event.input });
          const summary = summarizeToolCall(event.toolName, event.input);
          printBlock(summary.color, `${options.role}:${summary.label}`, summary.message);
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
          printBlock(color, `${options.role}:${label}`, message);
          toolCalls.delete(event.toolCallId);
          return undefined;
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    model: options.model,
    tools: options.tools,
    sessionManager: SessionManager.inMemory(),
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader,
  });

  session.subscribe((event) => {
    if (event.type !== "message_update") {
      return;
    }

    const assistantEvent = event.assistantMessageEvent;

    if (assistantEvent.type === "text_delta") {
      if (activeAssistantRole !== options.role) {
        ensureAssistantBreak();
        process.stdout.write(`${roleColor(options.role)}${options.role}${colors.reset} `);
        activeAssistantRole = options.role;
      }

      process.stdout.write(`${roleColor(options.role)}${assistantEvent.delta}${colors.reset}`);
    }

    if (assistantEvent.type === "text_end" && activeAssistantRole === options.role) {
      ensureAssistantBreak();
    }
  });

  return session;
}

function createInitialBuilderPrompt() {
  return `The Vite React + TypeScript project is already set up and the dev server is ALREADY RUNNING at http://localhost:5173.

Your job is to replicate the website shown in the reference screenshots exactly.

Important paths:
- ./images/ contains the original reference screenshots for the website you must reproduce
- ./output_images/ will contain captured screenshots of your current implementation after you submit

Requirements:
1. Inspect every image in ./images/ before editing files
2. Recreate that website in the existing project as accurately as possible
3. Do not search online for matching photos or illustrations. Use placeholder image URLs such as https://placehold.co/600x400 with the correct width and height for each image slot
4. Match image placement, dimensions, aspect ratios, and framing even when using placeholders
5. Do not start any dev server process
6. Verify the app responds with: curl -s http://localhost:5173/ | head -20
7. Run: bun run build
8. Call submit_for_verification() only when the implementation is ready for review`;
}

function createRetryBuilderPrompt(round: number, report: string) {
  return `Round ${round} verification failed.

Use these paths while fixing the project:
- ./images/ is the original reference set
- ./output_images/ is the latest captured implementation

You must fix every issue listed below before calling submit_for_verification() again.

Verifier report:

${report}`;
}

function createVerifierPrompt(round: number) {
  return `You are verifying round ${round} of a website replication task.

Paths:
- ./images/ contains the original reference screenshots
- ./output_images/ contains screenshots captured from the current implementation

Instructions:
1. Inspect the full set of images in both folders
2. Compare them holistically and in detail
3. Fail if screenshot counts differ, if any sections are missing, or if there are any meaningful visual mismatches
4. Critique even small layout, spacing, typography, color, content, and styling errors
5. Ignore the semantic content of photos/illustrations. Placeholder images are acceptable, but image blocks must still match in presence, size, aspect ratio, framing, and layout placement
6. Call exactly one tool: pass() or fail(report)

If you fail the output, the report string must be detailed and structured in markdown with sections for:
- Overall verdict
- Reference images reviewed
- Output images reviewed
- Critical mismatches
- Layout and spacing issues
- Typography issues
- Color and styling issues
- Content and asset issues
- Image block sizing and placement issues
- Exact fixes required before resubmission`;
}

async function promptUntilBuilderSubmits(session: AgentSession, prompt: string) {
  await session.prompt(prompt);

  while (!(globalThis as { __builderSubmitted?: boolean }).__builderSubmitted) {
    printLine(colors.dim, "builder:wait", "builder has not submitted yet; asking it to continue");
    await session.prompt(
      "Continue working. Inspect ./images/ closely, fix the site, rerun curl and bun run build if needed, and call submit_for_verification() when the implementation is ready."
    );
  }
}

async function promptUntilVerifierDecides(session: AgentSession) {
  await session.prompt(createVerifierPrompt((globalThis as { __verifierRound?: number }).__verifierRound ?? 1));

  while ((globalThis as { __verifierDecision?: VerifierDecision }).__verifierDecision?.status === "pending") {
    printLine(colors.dim, "verifier:wait", "verifier has not decided yet; asking it to continue");
    await session.prompt(
      "Continue the review. Inspect the images in ./images/ and ./output_images/ and then call exactly one tool: pass() or fail(report)."
    );
  }
}

async function main() {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outputImagesDir, { recursive: true });
  await rm(resultMarkerPath, { force: true });
  await rm(lastVerifierReportPath, { force: true });
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });
  await ensureWorkspaceLinks();

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

  let builderSession: AgentSession | null = null;

  try {
    await waitForDevServer(devServerUrl);
    printLine(colors.status, "ready", `dev server is live at ${devServerUrl}`);

    const agentDir = join(homedir(), ".pi", "agent");
    await mkdir(agentDir, { recursive: true });

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
              input: ["text", "image"],
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
      throw new Error("Fireworks model not found. Make sure FIREWORKS_API_KEY is set.");
    }

    printLine(colors.status, "model", model.name);

    (globalThis as { __builderSubmitted?: boolean }).__builderSubmitted = false;
    const submitForVerificationTool = defineTool({
      name: "submit_for_verification",
      label: "Submit For Verification",
      description:
        "Call this only when the website is ready for screenshot capture and verification. Run curl and bun run build first.",
      parameters: Type.Object({}),
      async execute() {
        (globalThis as { __builderSubmitted?: boolean }).__builderSubmitted = true;
        printLine(colors.status, "builder:done", "builder submitted the implementation for review");
        return {
          content: [{ type: "text", text: "Submission accepted for verification." }],
          details: { status: "submitted" },
        };
      },
    });

    builderSession = await createRoleSession({
      role: "builder",
      systemPromptPath: "/workspace/prompts/builder-system.md",
      systemPromptFallback:
        "You are a web development agent. Replicate the reference images exactly and call submit_for_verification() when ready.",
      tools: createCodingTools(workspaceDir),
      customTools: [submitForVerificationTool],
      model,
      authStorage,
      modelRegistry,
    });

    let round = 1;
    let verifierFailures = 0;
    let nextBuilderPrompt = createInitialBuilderPrompt();

    while (true) {
      (globalThis as { __builderSubmitted?: boolean }).__builderSubmitted = false;
      printLine(colors.status, "round", `starting builder round ${round}`);
      await promptUntilBuilderSubmits(builderSession, nextBuilderPrompt);

      printLine(colors.status, "capture", `capturing screenshots for round ${round}`);
      const captureResult = await captureScreenshots(devServerUrl, {
        outputDir: outputImagesDir,
      });
      printLine(
        colors.status,
        "capture",
        `captured ${captureResult.count} screenshots at ${captureResult.viewport.width}x${captureResult.viewport.height}`,
      );

      (globalThis as { __verifierDecision?: VerifierDecision }).__verifierDecision = { status: "pending" };
      (globalThis as { __verifierRound?: number }).__verifierRound = round;

      const passTool = defineTool({
        name: "pass",
        label: "Pass",
        description: "Call this only if the implementation matches the reference screenshots closely enough to accept.",
        parameters: Type.Object({}),
        async execute() {
          (globalThis as { __verifierDecision?: VerifierDecision }).__verifierDecision = { status: "passed" };
          printLine(colors.status, "verifier:done", "verifier passed the implementation");
          return {
            content: [{ type: "text", text: "Verification passed." }],
            details: { status: "passed" },
          };
        },
      });

      const failTool = defineTool({
        name: "fail",
        label: "Fail",
        description: "Call this if the replication is not exact. The report must be detailed and actionable.",
        parameters: Type.Object({
          report: Type.String(),
        }),
        async execute(_toolCallId: string, input: { report: string }) {
          const report = input.report.trim() || "Verification failed, but no detailed report was provided.";
          (globalThis as { __verifierDecision?: VerifierDecision }).__verifierDecision = {
            status: "failed",
            report,
          };
          printLine(colors.error, "verifier:done", "verifier rejected the implementation");
          return {
            content: [{ type: "text", text: "Verification failed." }],
            details: { status: "failed" },
          };
        },
      });

      const verifierSession = await createRoleSession({
        role: "verifier",
        systemPromptPath: "/workspace/prompts/verifier-system.md",
        systemPromptFallback:
          "You are a strict visual QA agent. Compare ./images/ and ./output_images/ and call pass() or fail(report).",
        tools: createReadOnlyTools(workspaceDir),
        customTools: [passTool, failTool],
        model,
        authStorage,
        modelRegistry,
      });

      try {
        printLine(colors.status, "round", `starting verifier round ${round}`);
        await promptUntilVerifierDecides(verifierSession);
      } finally {
        verifierSession.dispose();
      }

      const verifierDecision = (globalThis as { __verifierDecision?: VerifierDecision }).__verifierDecision;
      if (!verifierDecision || verifierDecision.status === "pending") {
        throw new Error(`Verifier round ${round} ended without a pass/fail decision.`);
      }

      if (verifierDecision.status === "passed") {
        await archiveRoundArtifacts(round, null);
        await writeFinalResult("passed", round, verifierFailures, null);
        printLine(colors.status, "result", `verification passed on round ${round}`);
        break;
      }

      verifierFailures += 1;
      const report = verifierDecision.report;
      await writeFile(lastVerifierReportPath, `${report.trim()}\n`);
      await archiveRoundArtifacts(round, report);

      if (verifierFailures >= maxVerifierFailures) {
        await writeFinalResult(
          "max_fail_returned_last_attempt",
          round,
          verifierFailures,
          lastVerifierReportPath,
        );
        printLine(colors.error, "result", `verification failed ${verifierFailures} times; returning last attempt`);
        break;
      }

      printLine(colors.status, "compact", `compacting builder context after failed round ${round}`);
      await builderSession.compact(
        "Summarize the builder session so the next round can continue. Preserve the files changed, implementation strategy, current visual state, and unresolved mismatches from the verifier."
      );

      round += 1;
      nextBuilderPrompt = createRetryBuilderPrompt(round, report);
    }
  } finally {
    builderSession?.dispose();
    serverProc.kill();
    const serverExitCode = await serverProc.exited.catch(() => 0);
    if (typeof serverExitCode === "number" && serverExitCode !== 0 && serverExitCode !== 143) {
      printLine(colors.error, "error", `dev server exited with code ${serverExitCode}`);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printLine(colors.error, "error", message);
  process.exit(1);
}
