const BUILTIN_TOOL_TAGS_RE = /<(?:file_write|file_read|file_edit|bash|glob)\b/i;

const DSML_TOOL_CALLS_RE = /<\uff5c\uff5cDSML\uff5c\uff5ctool_calls>/;

const GENERIC_XML_TOOL_RE = /<([a-z][a-z0-9_-]{1,63})(?:\s[^>]*)?\s*\//i;

const NON_TOOL_XML_TAGS = new Set([
  "br", "hr", "img", "p", "div", "span", "a", "b", "i", "em",
  "strong", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "tr", "td", "th", "thead", "tbody", "note", "example",
  "code", "pre", "blockquote", "details", "summary", "section",
  "article", "header", "footer", "nav", "aside", "main",
]);

const TEXT_TOOL_CALL_PATTERNS = [
  /```tool\b/i,
  /\btool_call\s*[\(:]/i,
  /\bfunction_call\s*[\(:]/i,
  /<tool_use>/i,
  /\bexecute_tool\s*\(/i,
] as const;

export interface ToolCallDetectionConfig {
  readonly registeredToolNames?: ReadonlySet<string>;
  readonly minResponseLength?: number;
}

export function detectToolCallText(
  response: string,
  config?: ToolCallDetectionConfig,
): boolean {
  if (DSML_TOOL_CALLS_RE.test(response)) return true;

  const minLength = config?.minResponseLength ?? 50;
  if (response.length < minLength) return false;

  if (BUILTIN_TOOL_TAGS_RE.test(response)) return true;

  if (config?.registeredToolNames) {
    for (const name of config.registeredToolNames) {
      if (new RegExp(`<${escapeRegExp(name)}[\\s/]`, "i").test(response)) {
        return true;
      }
    }
  }

  const xmlMatch = GENERIC_XML_TOOL_RE.exec(response);
  if (xmlMatch) {
    const tagName = xmlMatch[1]!.toLowerCase();
    if (!NON_TOOL_XML_TAGS.has(tagName)) return true;
  }

  return TEXT_TOOL_CALL_PATTERNS.some((p) => p.test(response));
}

export function containsUnexecutedToolCalls(
  messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>,
  config?: ToolCallDetectionConfig,
): boolean {
  let hasToolCallText = false;
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      if (detectToolCallText(msg.content, config)) {
        hasToolCallText = true;
      }
    }
    if (msg.role === "tool_result") {
      const msgAny = msg as Record<string, unknown>;
      if (typeof msgAny.toolUseId === "string") {
        toolResultIds.add(msgAny.toolUseId);
      }
    }
    if (msg.role === "tool_use") {
      const msgAny = msg as Record<string, unknown>;
      if (typeof msgAny.toolUseId === "string") {
        toolResultIds.add(msgAny.toolUseId);
      }
    }
  }

  return hasToolCallText && toolResultIds.size === 0;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
