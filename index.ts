import { mkdir, rm } from "fs/promises";
import { resolve } from "path";

const workspaceDir = resolve("output");
const promptsDir = resolve("prompts");
const containerName = "pi-agent-session";
const imageName = "pi-agent";
let attachedContainerProc: Bun.Subprocess | null = null;
let isShuttingDown = false;

const colors = {
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function logStep(title: string, detail?: string) {
  const suffix = detail ? ` ${colors.gray}${detail}${colors.reset}` : "";
  console.log(`${colors.bold}${colors.blue}==>${colors.reset} ${title}${suffix}`);
}

function logInfo(message: string) {
  console.log(`${colors.cyan}${message}${colors.reset}`);
}

function logError(message: string) {
  console.error(`${colors.red}${message}${colors.reset}`);
}

async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    quiet?: boolean;
  } = {},
) {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: options.quiet ? "ignore" : "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}`);
  }

  return exitCode;
}

async function cleanupRunningContainer(signal?: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  if (signal) {
    logInfo(`Received ${signal}. Stopping container without deleting output/.`);
  }

  if (attachedContainerProc) {
    attachedContainerProc.kill();
  }

  await stopAndRemoveContainer();
}

function installSignalHandlers() {
  const handleSignal = async (signal: NodeJS.Signals) => {
    await cleanupRunningContainer(signal);
    process.exit(130);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

installSignalHandlers();

async function stopAndRemoveContainer() {
  await runCommand(["docker", "stop", containerName], { allowFailure: true, quiet: true });
  await runCommand(["docker", "rm", "-f", containerName], { allowFailure: true, quiet: true });
}

async function resetWorkspace() {
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(resolve("home"), { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
}

async function configureGeneratedProject() {
  const packageJsonPath = `${workspaceDir}/package.json`;
  const packageJson = await Bun.file(packageJsonPath).json() as {
    scripts?: Record<string, string>;
  };

  packageJson.scripts = {
    ...packageJson.scripts,
    dev: "bunx --bun vite --host 0.0.0.0",
    build: "bunx --bun vite build",
    preview: "bunx --bun vite preview",
  };

  await Bun.write(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

const apiKey = process.env.FIREWORKS_API_KEY;

if (!apiKey) {
  logError("FIREWORKS_API_KEY is not set.");
  process.exit(1);
}

try {
  logStep("Stopping any previous agent container", containerName);
  await stopAndRemoveContainer();

  logStep("Resetting generated project", workspaceDir);
  await resetWorkspace();

  logStep("Scaffolding Vite app", "non-interactive react-ts template");
  await runCommand([
    "bun",
    "create",
    "vite",
    ".",
    "--template",
    "react-ts",
    "--no-interactive",
  ], { cwd: workspaceDir });

  logStep("Configuring generated scripts", "force Vite to run on Bun");
  await configureGeneratedProject();

  logStep("Installing project dependencies", workspaceDir);
  await runCommand(["bun", "install"], { cwd: workspaceDir });

  logStep("Building container image", imageName);
  await runCommand(["docker", "build", "-t", imageName, "."]);

  logStep("Starting attached container session", containerName);
  logInfo("The dev server will be exposed on http://localhost:5173 once it comes up.");
  logInfo("The transcript below includes assistant output, tool calls, file edits, and dev server logs.");

  attachedContainerProc = Bun.spawn({
    cmd: [
      "docker",
      "run",
      "--rm",
      "--name",
      containerName,
      "-e",
      `FIREWORKS_API_KEY=${apiKey}`,
      "-e",
      "WORKSPACE_DIR=/workspace/output",
      "-v",
      `${workspaceDir}:/workspace/output`,
      "-v",
      `${promptsDir}:/workspace/prompts:ro`,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-p",
      "5173:5173",
      "-p",
      "3000:3000",
      "--privileged",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "NET_ADMIN",
      imageName,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await attachedContainerProc.exited;
  attachedContainerProc = null;

  if (isShuttingDown) {
    process.exit(130);
  }

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): docker run --rm --name ${containerName} ... ${imageName}`
    );
  }

  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logError(message);
  await cleanupRunningContainer();
  process.exit(1);
}
