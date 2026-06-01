import { describe, expect, test } from "vitest";
import { createMCPEntry } from "../../src/mcp-entry";

describe("SSE Protocol Fix", () => {
  test("MCP Entry 状态包含 provider 快照", async () => {
    const entry = createMCPEntry({ transport: "stdio" });
    const state = entry.getState();
    expect(state).toBeDefined();
    expect(state.providerConfig).toBeDefined();
    expect(typeof state.providerConfig.configured).toBe("boolean");
    expect(typeof state.running).toBe("boolean");
  });
});
