import { access, mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { chromium } from "playwright-core";

const DEFAULT_VIEWPORT = {
  width: 1920,
  height: 1080,
};

const DEFAULT_SCROLL_RATIO = 0.9;
const DEFAULT_SETTLE_MS = 500;
const DEFAULT_INITIAL_SETTLE_MS = 750;

type CaptureOptions = {
  chromeExecutablePath?: string;
  outputDir?: string;
  scrollRatio?: number;
  settleMs?: number;
  initialSettleMs?: number;
};

async function firstExistingPath(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveChromeExecutablePath(explicitPath?: string) {
  const candidates = [
    explicitPath,
    process.env.CHROME_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));

  const executablePath = await firstExistingPath(candidates);

  if (!executablePath) {
    throw new Error(
      "No Chrome/Chromium executable found. Set CHROME_EXECUTABLE_PATH to a valid browser binary."
    );
  }

  return executablePath;
}

async function prepareOutputDirectory(outputDir: string) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
}

export async function captureScreenshots(url: string, options: CaptureOptions = {}) {
  const outputDir = resolve(options.outputDir ?? "output_images");
  const scrollRatio = options.scrollRatio ?? DEFAULT_SCROLL_RATIO;
  const scrollStep = Math.round(DEFAULT_VIEWPORT.height * scrollRatio);
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const initialSettleMs = options.initialSettleMs ?? DEFAULT_INITIAL_SETTLE_MS;
  const executablePath = await resolveChromeExecutablePath(options.chromeExecutablePath);

  await prepareOutputDirectory(outputDir);

  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: DEFAULT_VIEWPORT,
      screen: DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
    });

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(initialSettleMs);

    const capturedPositions = new Set<number>();
    let imageIndex = 1;

    while (true) {
      const currentScrollY = await page.evaluate(() => Math.round(window.scrollY));

      if (capturedPositions.has(currentScrollY)) {
        break;
      }

      capturedPositions.add(currentScrollY);

      await page.screenshot({
        path: join(outputDir, `image${imageIndex}.png`),
      });

      imageIndex += 1;

      const nextScrollY = await page.evaluate((step) => {
        const viewportHeight = window.innerHeight;
        const maxScrollY = Math.max(
          0,
          document.documentElement.scrollHeight - viewportHeight,
        );
        const currentScrollY = Math.round(window.scrollY);
        const nextScrollY = Math.min(maxScrollY, currentScrollY + step);

        window.scrollTo({
          top: nextScrollY,
          behavior: "instant",
        });

        return nextScrollY;
      }, scrollStep);

      await page.waitForTimeout(settleMs);

      if (nextScrollY <= currentScrollY) {
        break;
      }
    }

    return {
      count: imageIndex - 1,
      outputDir,
      viewport: DEFAULT_VIEWPORT,
      scrollStep,
      executablePath,
    };
  } finally {
    await browser.close();
  }
}
