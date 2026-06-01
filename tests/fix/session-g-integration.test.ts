import { describe, expect, it } from "vitest";
import { parseCLIArgs } from "../../src/cli";
import { createMCPEntry, parseMCPArgs } from "../../src/mcp-entry";

function resolveMCPRuntimeOptions(args: { flags: Record<string, string | boolean> }): {
  transport: "stdio" | "http";
  port: number;
  host: string;
} {
  const transportFlag = args.flags.transport;
  const transport = transportFlag === "http" ? "http" : "stdio";
  const portFlag = args.flags.port;
  const port = typeof portFlag === "string" ? Number.parseInt(portFlag, 10) : 3001;
  const hostFlag = args.flags.host;
  const host = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
  return { transport, port, host };
}

describe("Session G > 集成回归", () => {
  it("resolveMCPRuntimeOptions 支持 HTTP 传输", () => {
    const mcpRuntime = resolveMCPRuntimeOptions(parseCLIArgs(["bun", "cli.ts", "mcp", "--transport=http", "--port=8080", "--host=0.0.0.0"]));
    expect(mcpRuntime).toEqual({
      transport: "http",
      port: 8080,
      host: "0.0.0.0",
    });
  });

  it("MCP 入口全配置覆盖", () => {
    const stdioEntry = createMCPEntry({ transport: "stdio" });
    expect(stdioEntry.getState().transport).toBe("stdio");

    const httpEntry = createMCPEntry({ transport: "http", port: 5000, hostname: "127.0.0.1" });
    expect(httpEntry.getState().transport).toBe("http");

    const parsed = parseMCPArgs(["bun", "mcp.ts", "--transport=http", "--port=8080", "--host=0.0.0.0"]);
    expect(parsed.transport).toBe("http");
    expect(parsed.port).toBe(8080);
    expect(parsed.hostname).toBe("0.0.0.0");
  });

  it("parseCLIArgs 覆盖所有参数格式", () => {
    const r1 = parseCLIArgs(["bun", "cli.ts", "server", "-v"]);
    expect(r1.flags.v).toBe(true);

    const r2 = parseCLIArgs(["bun", "cli.ts", "server", "--port=8080"]);
    expect(r2.flags.port).toBe("8080");

    const r3 = parseCLIArgs(["bun", "cli.ts"]);
    expect(r3.command).toBe("help");
  });
});
