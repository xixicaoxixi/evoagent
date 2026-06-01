/**
 * coerceToolArgs — 参数类型强制（coercion）。
 *
 * 在 Zod safeParse 之前插入，处理开源模型常见的类型漂移：
 * - 字符串→数字：`"5"` → `5`
 * - 字符串→布尔：`"true"` → `true`、`"false"` → `false`
 * - 数组包裹：`"url"` → `["url"]`（schema 期望数组但收到标量）
 * - 路径规范化：字段名含 path/file 时统一分隔符
 *
 * 设计原则：
 * - 保守强制：仅在类型不匹配且转换无歧义时执行
 * - 不改语义：有歧义的转换跳过（如 `"123abc"` 不转数字）
 * - coercion 后仍走 Zod 验证，双重保障
 * - 所有转换记录日志，可观测
 */

import type { z } from "zod";
import { defaultLogger } from "../observability/logger";

const logger = defaultLogger.child("coerce");

// ─── Zod Schema 类型名 ───

type ZodTypeName =
  | "ZodString"
  | "ZodNumber"
  | "ZodBoolean"
  | "ZodArray"
  | "ZodObject"
  | "ZodOptional"
  | "ZodDefault"
  | "ZodNullable"
  | "ZodEnum"
  | "ZodUnion"
  | "ZodLiteral"
  | "ZodRecord"
  | "ZodUnknown";

// ─── Coercion 结果 ───

export interface CoerceResult {
  readonly coerced: Record<string, unknown>;
  readonly applied: ReadonlyArray<CoerceRecord>;
}

export interface CoerceRecord {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly originalValue: unknown;
  readonly coercedValue: unknown;
}

// ─── 从 Zod schema 提取期望类型 ───

function unwrapSchema(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  const typeName = (schema._def as { typeName: string }).typeName as ZodTypeName;
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") {
    const inner = (schema._def as { innerType?: z.ZodType<unknown> }).innerType;
    if (inner) return unwrapSchema(inner);
  }
  return schema;
}

function getSchemaTypeName(schema: z.ZodType<unknown>): ZodTypeName {
  return (unwrapSchema(schema)._def as { typeName: string }).typeName as ZodTypeName;
}

function getObjectShape(schema: z.ZodType<unknown>): Readonly<Record<string, z.ZodType<unknown>>> | null {
  const unwrapped = unwrapSchema(schema);
  const typeName = (unwrapped._def as { typeName: string }).typeName as ZodTypeName;
  if (typeName !== "ZodObject") return null;
  const shape = (unwrapped._def as { shape?: () => Record<string, z.ZodType<unknown>> }).shape;
  return shape ? shape() : null;
}

function getArrayElementSchema(schema: z.ZodType<unknown>): z.ZodType<unknown> | null {
  const unwrapped = unwrapSchema(schema);
  const typeName = (unwrapped._def as { typeName: string }).typeName as ZodTypeName;
  if (typeName !== "ZodArray") return null;
  return (unwrapped._def as { type?: z.ZodType<unknown> }).type ?? null;
}

// ─── 单值 coercion ───

function coerceStringValue(
  value: string,
  expectedType: ZodTypeName,
  arrayElementType?: ZodTypeName,
): unknown {
  switch (expectedType) {
    case "ZodNumber": {
      const trimmed = value.trim();
      if (trimmed === "") return value;
      const num = Number(trimmed);
      if (Number.isFinite(num) && String(num) === trimmed) return num;
      return value;
    }
    case "ZodBoolean": {
      const lower = value.toLowerCase().trim();
      if (lower === "true") return true;
      if (lower === "false") return false;
      return value;
    }
    case "ZodArray": {
      if (arrayElementType === "ZodNumber") {
        const num = Number(value.trim());
        if (Number.isFinite(num) && String(num) === value.trim()) return [num];
      }
      return [value];
    }
    default:
      return value;
  }
}

function coerceNonArrayToArray(value: unknown, arrayElementType?: ZodTypeName): unknown {
  if (typeof value === "string") {
    if (arrayElementType === "ZodNumber") {
      const num = Number(value.trim());
      if (Number.isFinite(num) && String(num) === value.trim()) return [num];
    }
    return [value];
  }
  if (typeof value === "number" && arrayElementType === "ZodNumber") {
    return [value];
  }
  return [value];
}

// ─── 路径规范化 ───

const PATH_FIELD_RE = /(^|_)(path|file|dir|folder|cwd|root)($|_)/i;

function isPathField(fieldName: string): boolean {
  return PATH_FIELD_RE.test(fieldName);
}

function normalizePathValue(value: string): string {
  if (process.platform !== "win32") return value;
  return value.replace(/\//g, "\\");
}

// ─── 主函数 ───

export function coerceToolArgs(
  input: Record<string, unknown>,
  schema: z.ZodType<unknown>,
): CoerceResult {
  const shape = getObjectShape(schema);
  if (shape === null) return { coerced: input, applied: [] };

  const coerced: Record<string, unknown> = { ...input };
  const applied: CoerceRecord[] = [];

  for (const [field, fieldSchema] of Object.entries(shape)) {
    if (!(field in coerced)) continue;

    const rawValue = coerced[field];
    if (rawValue === undefined || rawValue === null) continue;

    const expectedType = getSchemaTypeName(fieldSchema);
    let coercedValue = rawValue;
    let fromType = typeof rawValue;

    // 字符串 → 期望类型
    if (typeof rawValue === "string" && expectedType !== "ZodString") {
      const arrayElemType = expectedType === "ZodArray"
        ? getArrayElementSchema(fieldSchema)?._def
        : undefined;
      const arrayElemTypeName = arrayElemType
        ? (arrayElemType as { typeName: string }).typeName as ZodTypeName
        : undefined;

      coercedValue = coerceStringValue(rawValue, expectedType, arrayElemTypeName) as typeof coercedValue;
    }

    // 非数组 → 数组包裹
    if (expectedType === "ZodArray" && !Array.isArray(rawValue) && typeof rawValue !== "string") {
      const arrayElemType = getArrayElementSchema(fieldSchema)?._def;
      const arrayElemTypeName = arrayElemType
        ? (arrayElemType as { typeName: string }).typeName as ZodTypeName
        : undefined;

      coercedValue = coerceNonArrayToArray(rawValue, arrayElemTypeName) as typeof coercedValue;
    }

    // 路径规范化
    if (isPathField(field) && typeof coercedValue === "string") {
      const normalized = normalizePathValue(coercedValue);
      if (normalized !== coercedValue) {
        coercedValue = normalized;
      }
    }

    // 记录 coercion
    if (coercedValue !== rawValue) {
      applied.push({
        field,
        from: fromType,
        to: typeof coercedValue,
        originalValue: rawValue,
        coercedValue,
      });

      coerced[field] = coercedValue;
    }
  }

  if (applied.length > 0) {
    logger.debug("Tool args coerced", {
      fields: applied.map((a) => a.field),
      details: applied.map((a) => ({
        field: a.field,
        from: a.from,
        to: a.to,
      })),
    });
  }

  return { coerced, applied };
}
