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

describe("Phase G > G.0 > CLI 参数解析", () => {
  it("parseCLIArgs 解析基础命令", () => {
    const args = parseCLIArgs(["bun", "cli.ts", "server"]);
    expect(args.command).toBe("server");
    expect(args.flags).toEqual({});
  });

  it("parseCLIArgs 解析布尔 flag", () => {
    const args = parseCLIArgs(["bun", "cli.ts", "server", "-v"]);
    expect(args.flags.v).toBe(true);
  });

  it("parseCLIArgs 解析 key=value flag", () => {
    const args = parseCLIArgs(["bun", "cli.ts", "server", "--port=8080"]);
    expect(args.flags.port).toBe("8080");
  });

  it("parseCLIArgs 默认 help", () => {
    const args = parseCLIArgs(["bun", "cli.ts"]);
    expect(args.command).toBe("help");
  });

  it("resolveMCPRuntimeOptions 默认值", () => {
    const result = resolveMCPRuntimeOptions(parseCLIArgs(["bun", "cli.ts", "mcp"]));
    expect(result).toEqual({
      transport: "stdio",
      port: 3001,
      host: "127.0.0.1",
    });
  });

  it("resolveMCPRuntimeOptions 支持 Streamable HTTP", () => {
    const result = resolveMCPRuntimeOptions(parseCLIArgs(["bun", "cli.ts", "mcp", "--transport=http", "--port=4010", "--host=127.0.0.1"]));
    expect(result).toEqual({
      transport: "http",
      port: 4010,
      host: "127.0.0.1",
    });
  });
});

describe("Phase G > G.4 > MCP 入口", () => {
  it("createMCPEntry 创建 MCP 入口实例", () => {
    const entry = createMCPEntry({ transport: "stdio" });
    expect(entry).toBeDefined();
    expect(entry.getState().transport).toBe("stdio");
    expect(entry.getState().running).toBe(false);
  });

  it("createMCPEntry 默认 stdio 传输", () => {
    const entry = createMCPEntry();
    expect(entry.getState().transport).toBe("stdio");
  });

  it("createMCPEntry 默认端口与 parseMCPArgs 一致", () => {
    const entry = createMCPEntry({ transport: "http" });
    expect(entry.getState().transport).toBe("http");
    const parsed = parseMCPArgs(["bun", "mcp-entry.ts"]);
    expect(parsed.port).toBe(3001);
  });

  it("createMCPEntry 支持 Streamable HTTP 传输", () => {
    const entry = createMCPEntry({ transport: "http", port: 4000 });
    expect(entry.getState().transport).toBe("http");
  });

  it("parseMCPArgs 解析传输参数", () => {
    const result = parseMCPArgs(["bun", "mcp-entry.ts", "--transport=http", "--port=4000"]);
    expect(result.transport).toBe("http");
    expect(result.port).toBe(4000);
  });

  it("parseMCPArgs 默认值", () => {
    const result = parseMCPArgs(["bun", "mcp-entry.ts"]);
    expect(result.transport).toBe("stdio");
    expect(result.port).toBe(3001);
    expect(result.hostname).toBe("127.0.0.1");
  });

  it("parseMCPArgs 解析 host 参数", () => {
    const result = parseMCPArgs(["bun", "mcp-entry.ts", "--host=192.168.1.1"]);
    expect(result.hostname).toBe("192.168.1.1");
  });

  it("getState 初始状态正确", () => {
    const entry = createMCPEntry();
    const state = entry.getState();
    expect(state.running).toBe(false);
    expect(state.startTime).toBeUndefined();
    expect(state.connections).toBe(0);
    expect(state.providerConfig.source.effective).toBe("unconfigured");
    expect(state.tools.all).toEqual(["bash", "file_edit", "file_read", "file_write", "glob"]);
    expect(state.endpoints.health).toBe("http://127.0.0.1:3001/health");
  });
});
