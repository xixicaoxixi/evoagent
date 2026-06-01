#!/usr/bin/env bun
import { createServerApp } from "./server/app";
import { createMCPEntry, parseMCPArgs } from "./mcp-entry";
import { createPidfileLock, type PidfileLock } from "./utils/pidfile-lock";

interface CLIArgs {
  readonly command: string;
  readonly flags: Record<string, string | boolean>;
}

export function parseCLIArgs(argv: string[]): CLIArgs {
  const [, , command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (const token of rest) {
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eqIndex = body.indexOf("=");
      if (eqIndex === -1) {
        flags[body] = true;
      } else {
        const key = body.slice(0, eqIndex);
        const value = body.slice(eqIndex + 1);
        flags[key] = value;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      flags[key] = true;
    }
  }

  return { command, flags };
}

function printHelp(): void {
  console.log(`EvoAgent TS CLI

Usage:
  bun run src/cli.ts all [--port=8900] [--host=127.0.0.1] [--provider=...]
  bun run src/cli.ts server [--port=3000] [--host=127.0.0.1] [--prefix=/api/v1]
  bun run src/cli.ts mcp [--transport=stdio|http] [--port=3001] [--host=127.0.0.1] [--provider=...]
`);
}

async function runServerCommand(args: CLIArgs): Promise<void> {
  const lock = createPidfileLock();
  lock.acquire();

  const portFlag = args.flags.port;
  const parsedPort = typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : Number.NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : 3000;
  const hostFlag = args.flags.host;
  const hostname = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
  const prefixFlag = args.flags.prefix;
  const prefix = typeof prefixFlag === "string" ? prefixFlag : "/api/v1";
  const providerFlag = args.flags.provider;
  const providerType = typeof providerFlag === "string" ? providerFlag : undefined;
  const app = createServerApp({
    port,
    hostname,
    prefix,
    ...(providerType !== undefined ? { providerType } : {}),
  });

  let shuttingDown = false;
  async function handleSignal(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.stop();
    } catch {
    }
    lock.release();
    process.exit(0);
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await app.start();
}

async function runMCPCommand(argv: readonly string[]): Promise<void> {
  const lock = createPidfileLock();
  lock.acquire();

  const parsed = parseMCPArgs(argv);
  const entry = createMCPEntry({
    transport: parsed.transport,
    port: parsed.port,
    hostname: parsed.hostname,
    ...(parsed.provider !== undefined ? { providerType: parsed.provider } : {}),
  });
  await entry.start();

  let shuttingDown = false;
  async function handleSignal(): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await entry.gracefulShutdown(30_000);
    } catch {
    }
    lock.release();
    process.exit(0);
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await new Promise<void>(() => {});
}

async function runAllCommand(args: CLIArgs): Promise<void> {
  const lock = createPidfileLock();
  lock.acquire();

  const portFlag = args.flags.port;
  const parsedPort = typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : Number.NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : 8900;
  const hostFlag = args.flags.host;
  const hostname = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
  const providerFlag = args.flags.provider;
  const providerType = typeof providerFlag === "string" ? providerFlag : undefined;

  const mcpEntry = createMCPEntry({
    transport: "http",
    port,
    hostname,
    externalHttp: true,
    ...(providerType !== undefined ? { providerType } : {}),
  });
  await mcpEntry.start();

  const app = createServerApp({
    port,
    hostname,
    prefix: "/api/v1",
    ...(providerType !== undefined ? { providerType } : {}),
  });

  for (const route of mcpEntry.getRoutes()) {
    app.registerRoute(route);
  }

  let shuttingDown = false;
  async function handleSignal(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await mcpEntry.gracefulShutdown(30_000);
    } catch {
    }
    try {
      await app.stop();
    } catch {
    }
    lock.release();
    process.exit(0);
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  await app.start();

  console.log(`[EvoAgent] All-in-one server running on http://${hostname}:${port}`);
  console.log(`  Web UI:      http://localhost:${port}`);
  console.log(`  MCP Health:  http://localhost:${port}/health`);
  console.log(`  MCP Endpoint:http://localhost:${port}/mcp`);
  console.log(`  REST API:    http://localhost:${port}/api/v1`);
}

async function main(): Promise<void> {
  const args = parseCLIArgs(process.argv);

  switch (args.command) {
    case "all":
      await runAllCommand(args);
      return;
    case "server":
      await runServerCommand(args);
      return;
    case "mcp":
      await runMCPCommand(process.argv);
      return;
    case "help":
    default:
      printHelp();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
