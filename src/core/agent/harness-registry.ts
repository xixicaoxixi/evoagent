/**
 * HarnessRegistry — AgentHarness 全局注册表。
 *
 * RULES_2-4: 接口 + 注册表模式。
 * RULES_2-20: 观察者 + 错误隔离（批量操作中单个失败不影响其他）。
 * 参考 `代码片段_Agent运行时与编排补充.md` 片段 #2。
 */

import type {
  AgentHarness,
  AgentHarnessResetParams,
  RegisteredAgentHarness,
  AgentHarnessSupportContext,
  AgentHarnessSupport,
} from "../../interfaces/agent-harness";

// ─── 注册表状态 ───

const REGISTRY_STATE = Symbol.for("evoagent.harnessRegistry");

interface RegistryState {
  harnesses: Map<string, RegisteredAgentHarness>;
}

function getRegistryState(): RegistryState {
  const g = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  g[REGISTRY_STATE] ??= { harnesses: new Map() };
  return g[REGISTRY_STATE];
}

// ─── 注册表 API ───

/**
 * registerAgentHarness — 注册一个 AgentHarness。
 */
export function registerAgentHarness(
  harness: AgentHarness,
  options?: { ownerPluginId?: string },
): void {
  const id = harness.id.trim();
  getRegistryState().harnesses.set(id, {
    harness,
    ...(options?.ownerPluginId !== undefined ? { ownerPluginId: options.ownerPluginId } : {}),
  });
}

/**
 * getAgentHarness — 按 ID 获取已注册的 Harness。
 */
export function getAgentHarness(id: string): AgentHarness | undefined {
  return getRegisteredAgentHarness(id)?.harness;
}

/**
 * getRegisteredAgentHarness — 按 ID 获取已注册的 Harness 条目。
 */
export function getRegisteredAgentHarness(
  id: string,
): RegisteredAgentHarness | undefined {
  return getRegistryState().harnesses.get(id.trim());
}

/**
 * listAgentHarnessIds — 列出所有已注册的 Harness ID。
 */
export function listAgentHarnessIds(): string[] {
  return [...getRegistryState().harnesses.keys()];
}

/**
 * listRegisteredAgentHarnesses — 列出所有已注册的 Harness 条目。
 */
export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return Array.from(getRegistryState().harnesses.values());
}

/**
 * clearAgentHarnesses — 清空所有已注册的 Harness。
 */
export function clearAgentHarnesses(): void {
  getRegistryState().harnesses.clear();
}

/**
 * resetRegisteredAgentHarnessSessions — 批量重置所有 Harness 的会话。
 * RULES_2-20: 错误隔离。
 */
export async function resetRegisteredAgentHarnessSessions(
  params: AgentHarnessResetParams,
): Promise<void> {
  const entries = listRegisteredAgentHarnesses();
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.harness.reset === undefined) return;
      try {
        await entry.harness.reset(params);
      } catch (error) {
        // RULES_2-20: 单个失败不影响其他
        // 在生产环境中应记录日志
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[harness-registry] ${entry.harness.label} reset failed: ${msg}`,
        );
      }
    }),
  );
}

/**
 * disposeRegisteredAgentHarnesses — 批量销毁所有 Harness。
 * RULES_2-20: 错误隔离。
 */
export async function disposeRegisteredAgentHarnesses(): Promise<void> {
  const entries = listRegisteredAgentHarnesses();
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.harness.dispose === undefined) return;
      try {
        await entry.harness.dispose();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[harness-registry] ${entry.harness.label} dispose failed: ${msg}`,
        );
      }
    }),
  );
}

// ─── Harness 选择策略 ───

/**
 * selectAgentHarness — 选择最适合的 Harness。
 *
 * 选择策略：
 * 1. 遍历所有已注册的 Harness
 * 2. 调用 supports() 进行能力协商
 * 3. 按 priority 降序排列
 * 4. 返回优先级最高的支持者
 *
 * 参考 `代码片段_Agent运行时与编排补充.md` 片段 #3。
 */
export function selectAgentHarness(
  ctx: AgentHarnessSupportContext,
): AgentHarness | undefined {
  const candidates = listRegisteredAgentHarnesses()
    .map((entry) => ({
      harness: entry.harness,
      support: entry.harness.supports(ctx),
    }))
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .sort((a, b) => {
      // 按 priority 降序
      const priorityDelta = (b.support.priority ?? 0) - (a.support.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      // 同优先级按 id 字典序
      return a.harness.id.localeCompare(b.harness.id);
    });

  return candidates[0]?.harness;
}
