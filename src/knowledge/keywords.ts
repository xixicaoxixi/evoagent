/**
 * 关键词提取 — 7 语言停用词 + CJK 分词支持。
 *
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #59。
 * 用于 FTS 搜索的查询扩展。
 */

// ─── 停用词集（7 语言） ───

const STOP_WORDS_EN = new Set([
  "a", "an", "the", "this", "that", "is", "are", "was", "were",
  "have", "has", "do", "does", "will", "would", "could", "should",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "yesterday", "today", "tomorrow", "thing", "things", "something",
  "please", "help", "find", "show", "get", "tell", "give",
  "and", "or", "but", "not", "no", "if", "then", "than",
  "it", "its", "my", "your", "our", "their", "we", "you", "i", "me",
  "what", "which", "who", "where", "when", "how", "why",
]);

const STOP_WORDS_ZH = new Set([
  "的", "了", "着", "过", "是", "有", "在", "把", "和", "与",
  "之前", "以后", "昨天", "今天", "东西", "什么", "怎么", "为什么",
  "这个", "那个", "这些", "那些", "一个", "可以", "需要", "应该",
  "请", "帮", "找", "看", "用", "做", "让", "给", "到", "从",
]);

const STOP_WORDS_JA = new Set([
  "これ", "それ", "する", "です", "ます", "だ", "な", "に", "を",
  "は", "が", "の", "で", "と", "も", "から", "まで", "へ", "や",
]);

const STOP_WORDS_KO = new Set([
  "은", "는", "이", "가", "을", "를", "것", "의", "에", "에서",
  "하고", "하지만", "그리고", "그래서", "왜냐하면", "무엇", "어떻게",
]);

const STOP_WORDS_ES = new Set([
  "el", "la", "los", "las", "un", "una", "que", "de", "en", "por",
  "para", "con", "sin", "sobre", "entre", "como", "pero", "más", "menos",
]);

const STOP_WORDS_PT = new Set([
  "o", "a", "os", "as", "um", "uma", "que", "de", "em", "por",
  "para", "com", "sem", "sobre", "entre", "como", "mas", "menos",
]);

const STOP_WORDS_AR = new Set([
  "ال", "و", "كيف", "ماذا", "متى", "أين", "لماذا", "هل", "من", "في",
  "على", "إلى", "عن", "مع", "هذا", "ذلك", "هذه", "تلك",
]);

function isStopWord(token: string): boolean {
  return (
    STOP_WORDS_EN.has(token) ||
    STOP_WORDS_ZH.has(token) ||
    STOP_WORDS_JA.has(token) ||
    STOP_WORDS_KO.has(token) ||
    STOP_WORDS_ES.has(token) ||
    STOP_WORDS_PT.has(token) ||
    STOP_WORDS_AR.has(token)
  );
}

// ─── 分词 ───

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    // CJK 字符处理：单字 + 双字组合
    if (/[\u4e00-\u9fff]/.test(segment)) {
      const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
      tokens.push(...chars);
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i]! + chars[i + 1]!);
      }
    } else if (/[\u3040-\u30ff]/.test(segment)) {
      // 日文假名处理
      const parts = segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+/g) ?? [];
      tokens.push(...parts);
    } else if (/[\uac00-\ud7af]/.test(segment)) {
      // 韩文处理
      tokens.push(segment);
    } else {
      tokens.push(segment);
    }
  }

  return tokens;
}

// ─── 关键词提取 ───

/**
 * extractKeywords — 从查询文本中提取有意义的关键词。
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #59。
 *
 * 示例：
 * - "that thing we discussed about the API" → ["discussed", "api"]
 * - "之前讨论的那个方案" → ["讨论", "方案", "那个"]
 */
export function extractKeywords(query: string): string[] {
  const tokens = tokenize(query);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (isStopWord(token)) continue;
    if (token.length === 0) continue;
    if (/^[a-zA-Z]+$/.test(token) && token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^[\p{P}\p{S}]+$/u.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}
