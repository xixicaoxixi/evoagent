/**
 * Communication Constants — 通信层常量。
 *
 * D.1 修复：将签名相关属性名提取为常量，
 * 防止激进混淆（renameProperties）破坏 P2P 通信。
 *
 * 标准混淆（esbuild --minify、terser、swc）对字符串值无影响，
 * 但常量化提供了额外的安全保障和代码可维护性。
 */

/** 签名对象在 payload 中的键名 */
export const SIGNATURE_KEY = "_signature" as const;

/** 签名子字段键名 */
export const SIG_ALGORITHM = "algorithm" as const;
export const SIG_SIGNER = "signer" as const;
export const SIG_SIGNATURE = "signature" as const;
export const SIG_TIMESTAMP = "timestamp" as const;
export const SIG_PUBLIC_KEY = "publicKey" as const;

/** 签名子字段键名集合（用于遍历验证） */
export const SIGNATURE_SUB_KEYS = [
  SIG_ALGORITHM,
  SIG_SIGNER,
  SIG_SIGNATURE,
  SIG_TIMESTAMP,
] as const;

/** 支持的签名算法 */
export const SUPPORTED_ALGORITHMS = ["ed25519", "hmac-sha256"] as const;
export type SupportedAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];
