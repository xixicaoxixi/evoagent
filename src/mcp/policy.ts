/**
 * MCP 策略控制 — 服务器访问策略。
 *
 * 参考 `代码片段_上下文记忆与通信协议` #34 isMcpServerAllowedByPolicy()。
 *
 * 设计原则：
 * - 黑名单优先于白名单
 * - 空白名单 = 阻断所有（Fail-Closed）
 * - 三层匹配：名称 / 命令 / URL
 */

// ─── 策略条目类型 ───

export type PolicyEntryType = "name" | "command" | "url";

// ─── 策略条目 ───

export interface PolicyEntry {
  readonly type: PolicyEntryType;
  readonly pattern: string;
  readonly reason?: string;
}

// ─── 策略检查结果 ───

export interface PolicyCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly matchedEntry?: PolicyEntry;
}

// ─── 策略配置 ───

export interface MCPServerPolicy {
  /** 黑名单（优先级最高） */
  readonly denylist?: ReadonlyArray<PolicyEntry>;
  /** 白名单（空白名单 = 阻断所有） */
  readonly allowlist?: ReadonlyArray<PolicyEntry>;
}

// ─── 服务器配置 ───

export interface MCPServerConfigForPolicy {
  readonly name?: string;
  readonly command?: string;
  readonly url?: string;
}

// ─── 策略检查器 ───

export interface MCPServerPolicyChecker {
  /** 检查服务器是否被允许 */
  check(serverName: string, config?: MCPServerConfigForPolicy): PolicyCheckResult;
  /** 添加黑名单条目 */
  addDenyEntry(entry: PolicyEntry): void;
  /** 添加白名单条目 */
  addAllowEntry(entry: PolicyEntry): void;
  /** 获取策略统计 */
  getStats(): { denylistSize: number; allowlistSize: number };
}

// ─── 创建策略检查器 ───

export function createMCPServerPolicyChecker(
  policy?: MCPServerPolicy,
): MCPServerPolicyChecker {
  const denylist: PolicyEntry[] = [...(policy?.denylist ?? [])];
  const allowlist: PolicyEntry[] = [...(policy?.allowlist ?? [])];
  // 区分"未设置白名单"和"设置了空白名单"
  const hasAllowlist = policy?.allowlist !== undefined;

  function matchesPattern(entry: PolicyEntry, value: string): boolean {
    if (!value) return false;
    // 支持精确匹配和通配符（*）
    if (entry.pattern === "*") return true;
    if (entry.pattern.includes("*")) {
      const regex = new RegExp(
        "^" + entry.pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
        "i",
      );
      return regex.test(value);
    }
    return entry.pattern.toLowerCase() === value.toLowerCase();
  }

  function checkDenyList(serverName: string, config?: MCPServerConfigForPolicy): PolicyEntry | undefined {
    for (const entry of denylist) {
      switch (entry.type) {
        case "name":
          if (matchesPattern(entry, serverName)) return entry;
          break;
        case "command":
          if (config?.command && matchesPattern(entry, config.command)) return entry;
          break;
        case "url":
          if (config?.url && matchesPattern(entry, config.url)) return entry;
          break;
      }
    }
    return undefined;
  }

  function checkAllowList(serverName: string, config?: MCPServerConfigForPolicy): PolicyEntry | undefined {
    // 空白名单 = 阻断所有
    if (allowlist.length === 0) return undefined;

    for (const entry of allowlist) {
      switch (entry.type) {
        case "name":
          if (matchesPattern(entry, serverName)) return entry;
          break;
        case "command":
          if (config?.command && matchesPattern(entry, config.command)) return entry;
          break;
        case "url":
          if (config?.url && matchesPattern(entry, config.url)) return entry;
          break;
      }
    }
    return undefined;
  }

  function check(serverName: string, config?: MCPServerConfigForPolicy): PolicyCheckResult {
    // 黑名单优先
    const denied = checkDenyList(serverName, config);
    if (denied) {
      return {
        allowed: false,
        reason: denied.reason ?? `Denied by policy: ${denied.type}:${denied.pattern}`,
        matchedEntry: denied,
      };
    }

    // 无白名单限制（未设置 allowlist）
    if (!hasAllowlist) {
      return { allowed: true };
    }

    // 空白名单 = 阻断所有（Fail-Closed）
    if (allowlist.length === 0) {
      return {
        allowed: false,
        reason: `Empty allowlist blocks all servers`,
      };
    }

    // 白名单检查
    const allowed = checkAllowList(serverName, config);
    if (allowed) {
      return { allowed: true, matchedEntry: allowed };
    }

    return {
      allowed: false,
      reason: `Server "${serverName}" not in allowlist`,
    };
  }

  function addDenyEntry(entry: PolicyEntry): void {
    denylist.push(entry);
  }

  function addAllowEntry(entry: PolicyEntry): void {
    allowlist.push(entry);
  }

  function getStats(): { denylistSize: number; allowlistSize: number } {
    return { denylistSize: denylist.length, allowlistSize: allowlist.length };
  }

  return { check, addDenyEntry, addAllowEntry, getStats };
}
