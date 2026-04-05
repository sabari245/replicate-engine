import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, createCodingTools, defineTool, DefaultResourceLoader, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const cwd = process.env.WORKSPACE_DIR || "/workspace/output";

await mkdir(cwd, { recursive: true });

const agentDir = join(homedir(), ".pi", "agent");
await mkdir(agentDir, { recursive: true });

const systemPrompt = await readFile("/workspace/prompts/system.md", "utf-8").catch(() => {
  return "You are a web development agent. Create websites and call completed() when done.";
});

let isCompleted = false;

const completedTool = defineTool({
  name: "completed",
  label: "Completed",
  description: "Call this function ONLY when the web project is fully complete, verified with curl, and ready to hand over. This signals successful completion of the task.",
  parameters: Type.Object({}),
  async execute() {
    isCompleted = true;
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
  console.error("Fireworks model not found. Make sure FIREWORKS_API_KEY is set.");
  process.exit(1);
}

console.log(`Using model: ${model.name}`);

const { session } = await createAgentSession({
  cwd,
  model,
  tools: createCodingTools(cwd),
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  resourceLoader,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const userPrompt = "Create a simple hello world website.";

let response = await session.prompt(userPrompt);

while (!isCompleted) {
  console.log("\n\n[AGENT] Project not yet marked complete. Asking agent...\n");
  response = await session.prompt("Is the project considered complete or do you have something else to do? If the project is completed, call the completed() function to ensure that.");
}

console.log("\n\n[✓] Project completed successfully!");
