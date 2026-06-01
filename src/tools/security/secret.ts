/**
 * 恒定时间密钥比较 — 防止时序侧信道攻击。
 *
 * 基于安全最佳实践的恒定时间密钥比较设计。
 * 使用 SHA-256 哈希 + timingSafeEqual 确保比较时间不因输入差异而泄露信息。
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * safeEqualSecret — 恒定时间密钥比较。
 *
 * 先对两个输入分别计算 SHA-256 摘要，
 * 再用 Node.js 的 crypto.timingSafeEqual 比较摘要。
 *
 * @param provided - 用户提供的值（可能不是字符串）
 * @param expected - 期望的值（可能不是字符串）
 * @returns true 表示匹配，false 表示不匹配或输入无效
 */
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }

  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(provided), hash(expected));
}
