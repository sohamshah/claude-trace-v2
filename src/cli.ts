#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { URL } from "url";
import { TrafficLogger } from "./logger";
import { createProxyServer } from "./proxy";
import { HTMLGenerator } from "./html-generator";

const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  blue: "\x1b[0;34m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
} as const;
type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
  console.log(`
${colors.blue}claude-trace-v2${colors.reset}
Record interactions with Claude Code v2 (native binary) by proxying ANTHROPIC_BASE_URL.

${colors.yellow}USAGE:${colors.reset}
  claude-trace-v2 [OPTIONS] [--run-with CLAUDE_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html <file.jsonl> [out.html]   Generate HTML report from a JSONL log
  --include-all-requests                    Log every request, not just /v1/messages
  --no-open                                 Do not open the HTML report in browser on exit
  --log <name>                              Custom log base name (no extension)
  --claude <path>                           Override path to the claude binary
  --upstream <url>                          Override upstream API base (default: https://api.anthropic.com)
  --run-with <args...>                      Pass remaining args directly to claude
  --help, -h                                Show this help

${colors.yellow}EXAMPLES:${colors.reset}
  claude-trace-v2
  claude-trace-v2 --include-all-requests
  claude-trace-v2 --log my-session --run-with --model sonnet
  claude-trace-v2 --generate-html .claude-trace/log-2026-05-05-12-00-00.jsonl

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to .claude-trace/<basename>.{jsonl,html} in the current directory.
`);
}

function findClaudeBinary(custom?: string): string {
  if (custom) {
    if (!fs.existsSync(custom)) {
      log(`Claude binary not found at: ${custom}`, "red");
      process.exit(1);
    }
    return fs.realpathSync(custom);
  }

  try {
    const which = require("child_process").execSync("which claude", {
      encoding: "utf-8",
    }) as string;
    let p = which.trim();
    const aliasMatch = p.match(/:\s*aliased to\s+(.+)$/);
    if (aliasMatch) p = aliasMatch[1];
    return fs.realpathSync(p);
  } catch {
    const local = path.join(os.homedir(), ".claude", "local", "claude");
    if (fs.existsSync(local)) return fs.realpathSync(local);
    log("claude binary not found. Install @anthropic-ai/claude-code first.", "red");
    process.exit(1);
  }
}

interface RunOpts {
  claudeArgs: string[];
  includeAllRequests: boolean;
  openInBrowser: boolean;
  customClaudePath?: string;
  logBaseName?: string;
  upstreamUrl: string;
}

async function runClaudeWithProxy(opts: RunOpts): Promise<void> {
  log("claude-trace-v2", "blue");
  log("Starting Claude with traffic logging via local proxy", "yellow");

  const upstream = new URL(opts.upstreamUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    log(`Unsupported upstream protocol: ${upstream.protocol}`, "red");
    process.exit(1);
  }
  const upstreamPort = upstream.port
    ? parseInt(upstream.port, 10)
    : upstream.protocol === "https:"
      ? 443
      : 80;

  const logger = new TrafficLogger({
    logBaseName: opts.logBaseName,
    enableRealTimeHTML: true,
    includeAllRequests: opts.includeAllRequests,
  });

  console.log("");
  console.log("Logs will be written to:");
  console.log(`  JSONL: ${path.resolve(logger.logFile)}`);
  console.log(`  HTML:  ${path.resolve(logger.htmlFile)}`);
  console.log("");

  const { port, close } = await createProxyServer({
    upstreamHost: upstream.hostname,
    upstreamPort,
    upstreamProtocol: upstream.protocol as "http:" | "https:",
    logger,
    includeAllRequests: opts.includeAllRequests,
  });

  const proxyUrl = `http://127.0.0.1:${port}`;
  log(`Proxy listening at ${proxyUrl} → ${opts.upstreamUrl}`, "dim");

  const claudePath = findClaudeBinary(opts.customClaudePath);
  log(`Using Claude binary: ${claudePath}`, "blue");
  console.log("");

  const child: ChildProcess = spawn(claudePath, opts.claudeArgs, {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
    },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  let exitCode = 0;

  const cleanup = async () => {
    try {
      logger.finalize();
    } catch {
      // ignore
    }
    try {
      await close();
    } catch {
      // ignore
    }
    log(`\nLogged ${logger.count} request/response pair(s)`, "green");
    if (opts.openInBrowser && fs.existsSync(logger.htmlFile)) {
      try {
        spawn("open", [logger.htmlFile], { detached: true, stdio: "ignore" }).unref();
        log(`Opened ${logger.htmlFile}`, "green");
      } catch {
        // ignore
      }
    }
  };

  child.on("error", async (err) => {
    log(`Error starting Claude: ${err.message}`, "red");
    await cleanup();
    process.exit(1);
  });

  const handleSignal = (signal: NodeJS.Signals) => {
    if (child.pid) child.kill(signal);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        log(`\nClaude terminated by signal: ${signal}`, "yellow");
        exitCode = 1;
      } else if (code !== 0 && code !== null) {
        log(`\nClaude exited with code: ${code}`, "yellow");
        exitCode = code;
      } else {
        log("\nClaude session completed", "green");
      }
      resolve();
    });
  });

  await cleanup();
  process.exit(exitCode);
}

async function generateHTMLFromCLI(
  inputFile: string,
  outputFile: string | undefined,
  includeAllRequests: boolean,
  openInBrowser: boolean,
): Promise<void> {
  try {
    const generator = new HTMLGenerator();
    const finalOut = await generator.generateHTMLFromJSONL(
      inputFile,
      outputFile,
      includeAllRequests,
    );
    log(`Generated ${finalOut}`, "green");
    if (openInBrowser) {
      spawn("open", [finalOut], { detached: true, stdio: "ignore" }).unref();
    }
    process.exit(0);
  } catch (err) {
    log(`Error: ${(err as Error).message}`, "red");
    process.exit(1);
  }
}

function takeFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const runWithIdx = argv.indexOf("--run-with");
  const traceArgs = runWithIdx === -1 ? argv : argv.slice(0, runWithIdx);
  const claudeArgs = runWithIdx === -1 ? [] : argv.slice(runWithIdx + 1);

  if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  const includeAllRequests = traceArgs.includes("--include-all-requests");
  const openInBrowser = !traceArgs.includes("--no-open");
  const customClaudePath = takeFlagValue(traceArgs, "--claude");
  const logBaseName = takeFlagValue(traceArgs, "--log");
  const upstreamUrl =
    takeFlagValue(traceArgs, "--upstream") ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.anthropic.com";

  if (traceArgs.includes("--generate-html")) {
    const flagIdx = traceArgs.indexOf("--generate-html");
    const inputFile = traceArgs[flagIdx + 1];
    let outputFile: string | undefined;
    for (let i = flagIdx + 2; i < traceArgs.length; i++) {
      const a = traceArgs[i];
      if (!a.startsWith("--")) {
        outputFile = a;
        break;
      }
    }
    if (!inputFile) {
      log("Missing input file for --generate-html", "red");
      process.exit(1);
    }
    await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser);
    return;
  }

  await runClaudeWithProxy({
    claudeArgs,
    includeAllRequests,
    openInBrowser,
    customClaudePath,
    logBaseName,
    upstreamUrl,
  });
}

main().catch((err) => {
  log(`Unexpected error: ${(err as Error).message}`, "red");
  process.exit(1);
});
