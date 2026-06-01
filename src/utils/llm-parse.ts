/**
 * LLM 输出解析工具集 — 统一处理 LLM 返回的文本/JSON。
 *
 * 解决的问题：
 * - C5/A5/C18: 贪婪正则 `match(/\{[\s\S]*\}/)` 匹配到最远括号，含尾部噪声
 * - A6: `parseFloat("Score: 0.85")` 返回 NaN
 * - A12: `JSON.parse` 无原型污染防护
 */

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ─── extractJSONObject ───

export function extractJSONObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

// ─── extractJSONArray ───

export function extractJSONArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

// ─── safeJSONParse ───

function stripDangerousKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(stripDangerousKeys);
  }

  const cleaned: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    cleaned[key] = stripDangerousKeys((value as Record<string, unknown>)[key]);
  }
  return cleaned;
}

export function safeJSONParse(text: string): unknown {
  const parsed = JSON.parse(text);
  return stripDangerousKeys(parsed);
}

// ─── parseLLMScore ───

export function parseLLMScore(text: string): number {
  const trimmed = text.trim();

  const bare = parseFloat(trimmed);
  if (!Number.isNaN(bare) && bare >= 0 && bare <= 1) return bare;

  const colonMatch = trimmed.match(/[:：]\s*([01]?\.\d+)/);
  if (colonMatch) {
    const v = parseFloat(colonMatch[1]!);
    if (!Number.isNaN(v)) return v;
  }

  const percentMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    const v = parseFloat(percentMatch[1]!);
    if (!Number.isNaN(v)) return v / 100;
  }

  const slashMatch = trimmed.match(/([01]?\.\d+)\s*\/\s*1(?:\.0)?/);
  if (slashMatch) {
    const v = parseFloat(slashMatch[1]!);
    if (!Number.isNaN(v)) return v;
  }

  const anyNum = trimmed.match(/([01]?\.\d+)/);
  if (anyNum) {
    const v = parseFloat(anyNum[1]!);
    if (!Number.isNaN(v) && v >= 0 && v <= 1) return v;
  }

  return NaN;
}
