/**
 * 工具生成器（P4-06）— 自动生成新工具。
 *
 * 参考 SYSTEM_DESIGN.md 3.6.4。
 * 两种模式：
 * 1. LLM 模式：构造 prompt 要求返回 JSON 格式工具定义
 * 2. 简单模式（模板匹配）：根据错误模式匹配预定义模板
 *
 * 触发条件：启用 + 最小任务数(15) + 间隔(30) + 未达最大工具数(20)。
 */

import {
  TOOL_GEN_MIN_TASKS,
  TOOL_GEN_INTERVAL,
  TOOL_GEN_MAX_TOOLS,
  MAX_AUTO_REGISTERED_TOOLS,
} from "./constants";
import { validateCode, executeInSandbox } from "./code-sandbox";
import { sanitizePath } from "../security/llm-sanitize";
import { extractJSONObject, safeJSONParse } from "../utils/llm-parse";
import { isImmutableScope } from "./constitutional-guard";
import type { Tool, ToolUseContext, CanUseToolFn, ToolCallProgress } from "../interfaces/tool";
import type { PermissionResult, ValidationResult } from "../types/permission";
import type { ToolResult } from "../types/tool";
import { z } from "zod";

// ─── 类型定义 ───

export interface GeneratedTool {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly code: string;
  readonly testCode: string;
  readonly validated: boolean;
  readonly createdAt: string;
}

export interface ToolGeneratorConfig {
  readonly enabled?: boolean;
  readonly minTasks?: number;
  readonly interval?: number;
  readonly maxTools?: number;
}

// ─── 模板匹配规则 ───

const TEMPLATE_RULES: ReadonlyArray<{
  readonly errorPattern: RegExp;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly code: string;
  readonly testCode: string;
}> = [
  {
    errorPattern: /timeout|timed?\s*out/i,
    toolName: "retry_with_backoff",
    toolDescription: "Retry operation with exponential backoff",
    code: `async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
}`,
    testCode: `async function test_tool() {
  let attempts = 0;
  const fn = async () => { attempts++; if (attempts < 3) throw new Error('retry'); return 'ok'; };
  const result = await retryWithBackoff(fn, 3, 10);
  if (result !== 'ok' || attempts !== 3) throw new Error('Test failed');
}`,
  },
  {
    errorPattern: /invalid\s*(output|response|format|json)/i,
    toolName: "validate_structure",
    toolDescription: "Validate response structure against expected schema",
    code: `function validateStructure(data, schema) {
  if (typeof data !== schema.type) return { valid: false, error: 'Type mismatch' };
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in data)) return { valid: false, error: 'Missing field: ' + key };
    }
  }
  return { valid: true };
}`,
    testCode: `function test_tool() {
  const r1 = validateStructure({ a: 1 }, { type: 'object', required: ['a'] });
  if (!r1.valid) throw new Error('Test 1 failed');
  const r2 = validateStructure({ a: 1 }, { type: 'object', required: ['b'] });
  if (r2.valid) throw new Error('Test 2 failed');
}`,
  },
];

// ─── 工具生成器 ───

/**
 * createToolGenerator — 创建工具生成器。
 */
export function createToolGenerator(config?: ToolGeneratorConfig) {
  const enabled = config?.enabled ?? true;
  const minTasks = config?.minTasks ?? TOOL_GEN_MIN_TASKS;
  const interval = config?.interval ?? TOOL_GEN_INTERVAL;
  const maxTools = config?.maxTools ?? TOOL_GEN_MAX_TOOLS;

  let lastGenerateTask = 0;
  const generatedTools: GeneratedTool[] = [];

  return {
    /**
     * shouldGenerate — 检查是否应该生成新工具。
     */
    shouldGenerate(totalTasks: number, currentToolCount: number): boolean {
      if (!enabled) return false;
      if (totalTasks < minTasks) return false;
      if (totalTasks - lastGenerateTask < interval) return false;
      if (currentToolCount >= maxTools) return false;
      return true;
    },

    /**
     * generateTool — 根据错误模式生成工具。
     *
     * 优先使用模板匹配，无匹配时返回 null（需 LLM 模式）。
     */
    generateTool(errorMessage: string): GeneratedTool | null {
      // 模板匹配
      for (const rule of TEMPLATE_RULES) {
        if (rule.errorPattern.test(errorMessage)) {
          const tool: GeneratedTool = {
            toolId: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: rule.toolName,
            description: rule.toolDescription,
            code: rule.code,
            testCode: rule.testCode,
            validated: false,
            createdAt: new Date().toISOString(),
          };
          generatedTools.push(tool);
          lastGenerateTask = 0;
          return tool;
        }
      }

      return null;
    },

    /**
     * generateToolWithLLM — 使用 LLM 生成工具。
     */
    async generateToolWithLLM(
      errorMessage: string,
      existingTools: readonly string[],
      llmClient?: { invoke: (messages: Array<{ role: string; content: string }>) => Promise<string> },
    ): Promise<GeneratedTool | null> {
      if (llmClient === undefined) {
        return this.generateTool(errorMessage);
      }

      try {
        // 路径脱敏：防止文件路径泄露到外部 LLM
        const safeErrorMessage = sanitizePath(errorMessage);

        // 隐藏内部工具名：仅传递工具数量，不暴露具体名称
        const toolCountDescription = `${existingTools.length} existing tool(s)`;

        const prompt = `Generate a new tool to handle this error: "${safeErrorMessage}"

${toolCountDescription}

Respond in JSON format:
{
  "name": "<tool_name>",
  "description": "<description>",
  "code": "<JavaScript function code>",
  "test_code": "<test function named test_tool>"
}

Use English field names in JSON output. Output ONLY the JSON object, no additional text.`;

        const response = await llmClient.invoke([
          { role: "user", content: prompt },
        ]);

        const jsonStr = extractJSONObject(response);
        if (jsonStr === null) return null;

        const rawParsed = safeJSONParse(jsonStr);

        const LLMToolDefinitionSchema = z.object({
          name: z.string().optional(),
          description: z.string().optional(),
          code: z.string().optional(),
          test_code: z.string().optional(),
        });

        const validated = LLMToolDefinitionSchema.safeParse(rawParsed);
        if (!validated.success) return null;
        const parsed = validated.data;

        const tool: GeneratedTool = {
          toolId: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: parsed.name ?? "unnamed_tool",
          description: parsed.description ?? "",
          code: parsed.code ?? "",
          testCode: parsed.test_code ?? "",
          validated: false,
          createdAt: new Date().toISOString(),
        };

        generatedTools.push(tool);
        lastGenerateTask = 0;
        return tool;
      } catch {
        return this.generateTool(errorMessage);
      }
    },

    /**
     * validateTool — 在沙箱中验证生成的工具。
     */
    async validateTool(tool: GeneratedTool): Promise<boolean> {
      const combinedCode = `${tool.code}\n${tool.testCode}`;
      const result = await executeInSandbox(combinedCode);
      return result.success;
    },

    /**
     * getGeneratedTools — 获取所有已生成的工具。
     */
    getGeneratedTools(): readonly GeneratedTool[] {
      return [...generatedTools];
    },

    /** 获取生成计数 */
    getGeneratedCount(): number {
      return generatedTools.length;
    },
  };
}

export type ToolGenerator = ReturnType<typeof createToolGenerator>;

// ─── 从 GeneratedTool 创建 Tool ───

function extractFunctionName(code: string): string | null {
  const match = code.match(/(?:async\s+)?function\s+(\w+)/);
  return match?.[1] ?? null;
}

const GENERATED_TOOL_INPUT_SCHEMA = z.record(z.unknown());

export function createToolFromGenerated(generated: GeneratedTool): Tool<typeof GENERATED_TOOL_INPUT_SCHEMA> {
  const fnName = extractFunctionName(generated.code);

  return {
    name: generated.name,
    description: generated.description,
    inputSchema: GENERATED_TOOL_INPUT_SCHEMA,
    maxResultSizeChars: 10000,

    async call(
      args: Record<string, unknown>,
      _context: ToolUseContext,
      _canUseTool: CanUseToolFn,
      _progress?: ToolCallProgress,
    ): Promise<ToolResult> {
      const codeValidation = validateCode(generated.code);
      if (!codeValidation.valid) {
        return {
          content: `Generated tool code validation failed: ${codeValidation.errors.join("; ")}`,
          isError: true,
        };
      }

      if (fnName === null) {
        return {
          content: `Cannot extract function name from generated tool "${generated.name}"`,
          isError: true,
        };
      }

      try {
        const wrappedCode = `${generated.code}\nreturn ${fnName}(input);`;
        const sandboxConsole = {
          log: (..._args: unknown[]) => {},
          error: (..._args: unknown[]) => {},
          warn: (..._args: unknown[]) => {},
          info: (..._args: unknown[]) => {},
        };
        const fn = new Function("console", "input", wrappedCode);
        const result = await fn(sandboxConsole, args);

        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        return {
          content: resultStr ?? "Tool executed successfully (no return value)",
          isError: false,
        };
      } catch (e) {
        return {
          content: `Generated tool execution error: ${(e as Error).message}`,
          isError: true,
        };
      }
    },

    async checkPermissions(
      _input: Record<string, unknown>,
      _context: ToolUseContext,
    ): Promise<PermissionResult> {
      return { behavior: "allow" };
    },

    isEnabled(): boolean {
      return true;
    },

    isConcurrencySafe(_input: Record<string, unknown>): boolean {
      return false;
    },

    isReadOnly(_input: Record<string, unknown>): boolean {
      return false;
    },
  };
}

export function canRegisterTool(
  generated: GeneratedTool,
  currentAutoRegisteredCount: number,
): { allowed: boolean; reason: string } {
  if (currentAutoRegisteredCount >= MAX_AUTO_REGISTERED_TOOLS) {
    return {
      allowed: false,
      reason: `Auto-registered tool limit reached (${MAX_AUTO_REGISTERED_TOOLS})`,
    };
  }

  if (isImmutableScope(generated.name)) {
    return {
      allowed: false,
      reason: `Tool name "${generated.name}" conflicts with immutable scope`,
    };
  }

  if (!generated.code || generated.code.trim().length === 0) {
    return {
      allowed: false,
      reason: `Generated tool has empty code`,
    };
  }

  return { allowed: true, reason: "OK" };
}
