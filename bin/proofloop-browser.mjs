#!/usr/bin/env node
// proofloop browser capture - turns a web UI into a proofloop evidence surface.
//
// Prints the page's TEXT truth to stdout (title, url, full body innerText) so
// the runner's contains/absent checks and settle-polling work on UI content
// exactly like any shell evidence source - and saves a SCREENSHOT (pixel truth)
// for a vision-capable judge to inspect.
//
// Usage:
//   node proofloop-browser.mjs <url> [--screenshot <path>] [--wait-for <css selector>] [--timeout <seconds>]
//
// Needs playwright-core (npm i playwright-core) plus a system Chrome/Edge, or
// the full playwright package with its downloaded browsers.

const args = process.argv.slice(2);
const url = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

if (!url || url.startsWith("--")) {
  console.error("usage: proofloop-browser.mjs <url> [--screenshot <path>] [--wait-for <selector>] [--timeout <seconds>]");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("proofloop-browser: neither playwright-core nor playwright is installed.\n" +
      "Fix: npm i playwright-core   (uses your system Chrome/Edge)\n" +
      "  or: npm i playwright && npx playwright install chromium");
    process.exit(2);
  }
}

const timeoutMs = Number(opt("timeout") ?? 15) * 1000;

async function launch() {
  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch { /* try next */ }
  }
  throw new Error("no launchable browser found (tried chrome, msedge, bundled chromium)");
}

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const waitFor = opt("wait-for");
  if (waitFor) await page.waitForSelector(waitFor, { timeout: timeoutMs });

  const title = await page.title();
  const body = await page.innerText("body");
  const shot = opt("screenshot");
  if (shot) await page.screenshot({ path: shot, fullPage: true });

  console.log(`[title] ${title}`);
  console.log(`[url] ${page.url()}`);
  if (shot) console.log(`[screenshot] ${shot}`);
  console.log("[body]");
  console.log(body);
} finally {
  await browser.close();
}
