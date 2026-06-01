/**
 * Prompt 分层组装 — 6 层 System Prompt 架构。
 *
 * 基于通用 Agent 设计模式的分层 Prompt 架构：
 * Layer 1: 核心系统提示（角色 + 行为指令）
 * Layer 2: 记忆机制提示（条件性）
 * Layer 3: 追加提示（用户自定义）
 * Layer 4: 系统上下文（运行时 git 状态等）
 * Layer 5: 用户上下文（CLAUDE.md 等，注入为 user 消息）
 * Layer 6: 系统初始化消息（工具列表等，作为第一条 user 消息）
 */

import type { Tool } from "../../interfaces/tool";
import type { LLMMessageParam } from "../../interfaces/llm-provider";
import { filterArchitectureKeywords } from "../../security/llm-sanitize";
import type { AgentModeContext } from "../../types/mode";
import { isPlanMode, isRestrictedMode } from "../../types/mode";

// ─── Prompt 组装配置 ───

export interface PromptConfig {
  /** Layer 1: 核心系统提示 */
  readonly baseSystemPrompt: string;

  /** Layer 2: 记忆机制提示（条件性） */
  readonly memoryPrompt?: string;

  /** Layer 3: 追加提示 */
  readonly appendSystemPrompt?: string;

  /** Layer 4: 系统上下文（运行时） */
  readonly systemContext?: string;

  readonly planOutput?: string;

  /** Layer 5: 用户上下文（CLAUDE.md 等） */
  readonly userContext?: string;

  /** Layer 6: 工具列表描述 */
  readonly tools?: ReadonlyArray<Tool>;

  /** 实例信息 */
  readonly instanceInfo?: {
    readonly instanceName?: string;
    readonly model?: string;
    readonly currentDate?: string;
  };

  /** B.4: Agent 模式上下文（用于注入模式相关提示） */
  readonly modeContext?: AgentModeContext;
}

// ─── Prompt 组装结果 ───

export interface AssembledPrompt {
  /** System Prompt（Layer 1-4 合并） */
  readonly systemPrompt: string;

  /** User 上下文消息（Layer 5，作为 user 消息） */
  readonly userContextMessage: LLMMessageParam | undefined;

  /** 系统初始化消息（Layer 6，作为第一条 user 消息） */
  readonly systemInitMessage: LLMMessageParam | undefined;
}

// ─── 组装函数 ───

/**
 * 分层组装 System Prompt。
 *
 * Layer 1-4 合并为 systemPrompt 参数。
 * Layer 5 作为 user 消息注入。
 * Layer 6 作为第一条 user 消息。
 */
export function assemblePrompt(config: PromptConfig): AssembledPrompt {
  // Layer 1: 核心系统提示
  const layers: string[] = [config.baseSystemPrompt];

  // Layer 2: 记忆机制提示（条件性）— 过滤架构关键词
  if (config.memoryPrompt) {
    layers.push(filterArchitectureKeywords(config.memoryPrompt));
  }

  // Layer 3: 追加提示 — 过滤架构关键词
  if (config.appendSystemPrompt) {
    layers.push(filterArchitectureKeywords(config.appendSystemPrompt));
  }

  // Layer 4: 系统上下文 — 过滤架构关键词
  if (config.systemContext) {
    layers.push(filterArchitectureKeywords(config.systemContext));
  }

  if (config.planOutput) {
    layers.push(config.planOutput);
  }

  // B.4: 模式提示注入
  if (config.modeContext) {
    const modePrompt = buildModePrompt(config.modeContext);
    if (modePrompt) {
      layers.push(modePrompt);
    }
  }

  // Step 9: Windows 平台指导
  if (process.platform === "win32") {
    layers.push(
      "Use Windows-compatible commands. For file operations, PREFER using file_write/file_read tools over echo/redirect.\n" +
      "If you must use bash on Windows: use 'type' not 'cat', use 'copy' not 'cp', avoid echo with redirect (use file_write instead).",
    );
  }

  const systemPrompt = layers.join("\n\n");

  // Layer 5: 用户上下文
  const userContextMessage = config.userContext
    ? { role: "user" as const, content: config.userContext }
    : undefined;

  // Layer 6: 系统初始化消息
  const systemInitMessage = buildSystemInitMessage(config);

  return { systemPrompt, userContextMessage, systemInitMessage };
}

// ─── Layer 6: 系统初始化消息 ───

function buildSystemInitMessage(config: PromptConfig): LLMMessageParam | undefined {
  const sections: string[] = [];

  // 当前日期
  if (config.instanceInfo?.currentDate) {
    sections.push(`Today's date is ${config.instanceInfo.currentDate}.`);
  }

  // 工具列表
  if (config.tools && config.tools.length > 0) {
    const toolDescriptions = config.tools
      .map((t) => `- **${t.name}**: ${t.description}`)
      .join("\n");
    sections.push(`## Available Tools\n${toolDescriptions}`);

    const xmlExamples = config.tools.map((tool) => {
      switch (tool.name) {
        case "file_write":
          return `<file_write file_path="FULL_PATH" content="FILE_CONTENT" />`;
        case "file_read":
          return `<file_read file_path="FULL_PATH" />`;
        case "file_edit":
          return `<file_edit file_path="FULL_PATH" old_str="OLD" new_str="NEW" />`;
        case "bash":
          return `<bash>COMMAND</bash>`;
        case "glob":
          return `<glob pattern="PATTERN" path="DIR_PATH" />`;
        default:
          return `<${tool.name}>...</${tool.name}>`;
      }
    }).join("\n");

    sections.push(`## Tool Calling Format

When you need to call a tool, output it in this EXACT XML format (one per line). Do NOT describe or explain — JUST output the XML tag:

${xmlExamples}

Rules:
- Output ONLY the XML tag when calling a tool. No prose before or after.
- Use the exact attribute names shown above.
- For file_write with multi-line content, use the body form:
<file_write file_path="FULL_PATH">
CONTENT_HERE
</file_write>
- If the tool calling mechanism provided by your interface is available (native function calling), prefer that over XML format.
- You MUST call tools to complete tasks. Do NOT just describe what you would do.`);
  }

  // 模型信息
  if (config.instanceInfo?.model) {
    sections.push(`Model: ${config.instanceInfo.model}`);
  }

  if (sections.length === 0) return undefined;

  return { role: "user", content: sections.join("\n\n") };
}

// ─── 工具描述生成 ───

/**
 * 为工具生成 Prompt 描述（用于 Layer 1 工具使用指南）。
 */
export function generateToolPromptSection(
  tools: ReadonlyArray<Tool>,
): string {
  if (tools.length === 0) return "";

  const sections = tools.map((tool) => {
    let desc = `### ${tool.name}\n${tool.description}`;
    return desc;
  });

  return `## Tool Usage Guide\n\n${sections.join("\n\n")}`;
}

// ─── B.4: 模式提示生成 ───

/**
 * 根据当前 Agent 模式生成提示注入。
 *
 * - Plan 模式：注入只读限制提示，告知模型只能使用只读工具
 * - Sandbox 模式：注入沙箱限制提示
 * - Default/Auto：不注入额外提示
 */
function buildModePrompt(modeContext: AgentModeContext): string {
  if (isPlanMode(modeContext)) {
    const restrictions = modeContext.restrictedAbilities;
    const restrictedTools = restrictions.map((r) => `- ${r.toolId}: ${r.restriction}`).join("\n");

    const sections: string[] = [
      "## ⚠️ Plan Mode — 只读模式",
      "",
      "你当前处于 Plan 模式，只能使用只读工具（file_read, glob）分析代码库。",
      "禁止使用任何写入类工具（file_write, file_edit, bash, execute_command 等）。",
      "",
    ];

    if (restrictedTools) {
      sections.push("### 限制详情");
      sections.push(restrictedTools);
      sections.push("");
    }

    sections.push(
      "请完成分析并制定执行计划，等待用户确认后方可进入执行阶段。",
    );

    return sections.join("\n");
  }

  if (modeContext.mode === "sandbox") {
    return [
      "## 🔒 Sandbox Mode — 沙箱模式",
      "",
      "你当前处于沙箱模式，操作受到安全限制。",
      "文件系统写入和网络访问可能被限制。",
    ].join("\n");
  }

  return "";
}
