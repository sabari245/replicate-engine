import { mkdir, writeFile, rm, readdir } from "fs/promises";
import { join, resolve } from "path";

const cwd = resolve("output");
const rootDir = process.cwd();
const containerName = "pi-agent-session";

await Bun.$`docker stop ${containerName} 2>/dev/null || true`;
await Bun.$`docker rm ${containerName} 2>/dev/null || true`;

await mkdir(cwd, { recursive: true });

try {
  for (const entry of await readdir(cwd)) {
    await rm(join(cwd, entry), { recursive: true, force: true });
  }
} catch {}

await Bun.$`cd ${cwd} && bunx create-vite@latest . --template react-ts`.nothrow();
await Bun.$`cd ${cwd} && bun install`.nothrow();

await Bun.$`docker build -t pi-agent .`.nothrow();

const apiKey = process.env.FIREWORKS_API_KEY;
if (!apiKey) {
  console.error("FIREWORKS_API_KEY not set");
  process.exit(1);
}

await Bun.$`docker run -d \
  --name ${containerName} \
  -e FIREWORKS_API_KEY=${apiKey} \
  -e WORKSPACE_DIR=/workspace/output \
  -v ${cwd}:/workspace/output \
  -v ${rootDir}/prompts:/workspace/prompts \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -p 5173:5173 \
  -p 3000:3000 \
  --privileged \
  --cap-add SYS_ADMIN \
  --cap-add NET_ADMIN \
  pi-agent`.nothrow();

console.log(`Container started: ${containerName}`);
console.log(`View logs: docker logs -f ${containerName}`);
console.log(`Dev server will be available at: http://localhost:5173`);
console.log(`If using port 3000: http://localhost:3000`);
