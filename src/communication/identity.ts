/**
 * Identity — 实例身份系统。
 *
 * Ed25519 签名 + HMAC-SHA256 降级。
 * RULES_2-19: 挑战-响应握手基础。
 *
 * E.2 修复 C-03: HMAC 密钥从环境变量 EVOAGENT_HMAC_KEY 加载，
 * 不再硬编码默认密钥。
 */

import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import {
  SIGNATURE_KEY,
  SIG_ALGORITHM,
  SIG_SIGNER,
  SIG_SIGNATURE,
  SIG_TIMESTAMP,
} from "./constants";

// ─── 签名算法类型 ───

export type SignatureAlgorithm = "ed25519" | "hmac-sha256";

// ─── 公开身份数据 ───

export interface IdentityPublicData {
  readonly instanceId: string;
  /** SEC-04 修复：SHA-256 指纹（前 16 位），非完整密钥 */
  readonly publicKey: string;
  readonly algorithm: SignatureAlgorithm;
}

// ─── 签名结果 ───

export interface SignatureResult {
  readonly algorithm: SignatureAlgorithm;
  readonly signer: string;
  readonly signature: string;
  readonly timestamp: number;
}

// ─── 验证结果 ───

export interface VerifyResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly signer?: string;
}

// ─── Identity 接口 ───

export interface Identity {
  readonly instanceId: string;
  readonly algorithm: SignatureAlgorithm;
  sign(data: string): SignatureResult;
  verify(data: string, signatureHex: string, publicKeyHex: string, signerId?: string): VerifyResult;
  getPublicData(): IdentityPublicData;
  /** SEC-04: 获取完整签名密钥（仅内部验证使用，不对外暴露） */
  getSigningKey(): string;
}

// ─── C-03: HMAC 密钥来源 ───

const HMAC_KEY_ENV_VAR = "EVOAGENT_HMAC_KEY";

function resolveHmacKey(providedKey?: string): string {
  if (providedKey) return providedKey;
  const envKey = process.env[HMAC_KEY_ENV_VAR];
  if (envKey && envKey.length >= 16) return envKey;
  // 安全降级：仅在无环境变量时生成随机密钥（并发出警告）
  if (!envKey) {
    console.warn(
      `[Identity] ${HMAC_KEY_ENV_VAR} not set; using random HMAC key. ` +
      `Set this env var for persistent identity across restarts.`,
    );
  } else {
    console.warn(
      `[Identity] ${HMAC_KEY_ENV_VAR} too short (${envKey.length} chars, min 16); using random key.`,
    );
  }
  return randomBytes(32).toString("hex");
}

// ─── HMAC-SHA256 实现 ───

function createHMACIdentity(hmacKey?: string): Identity {
  const key = resolveHmacKey(hmacKey);
  const instanceId = createHash("sha256").update(key).digest("hex").slice(0, 16);

  return {
    instanceId,
    algorithm: "hmac-sha256",

    sign(data: string): SignatureResult {
      const sig = createHmac("sha256", key).update(data).digest("hex");
      return {
        algorithm: "hmac-sha256",
        signer: instanceId,
        signature: sig,
        timestamp: Date.now(),
      };
    },

    verify(data: string, signatureHex: string, publicKeyHex: string, signerId?: string): VerifyResult {
      const expected = createHmac("sha256", publicKeyHex).update(data).digest("hex");

      let valid: boolean;
      try {
        valid = timingSafeEqual(
          Buffer.from(signatureHex, "hex"),
          Buffer.from(expected, "hex"),
        );
      } catch {
        valid = false;
      }

      if (!valid) {
        return { valid: false, error: "Signature verification failed" };
      }

      return {
        valid: true,
        signer: signerId ?? createHash("sha256").update(publicKeyHex).digest("hex").slice(0, 16),
      };
    },

    getPublicData(): IdentityPublicData {
      // SEC-04 修复：返回密钥的 SHA-256 指纹（前 16 位），而非完整密钥
      const keyFingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
      return {
        instanceId,
        publicKey: keyFingerprint,
        algorithm: "hmac-sha256",
      };
    },

    getSigningKey(): string {
      return key;
    },
  };
}

// ─── Ed25519 占位实现（Bun 原生支持时替换） ───

function createEd25519Identity(): Identity {
  // Ed25519 需要特定的密钥生成库
  // 在 Bun 环境中可以使用 Web Crypto API
  // 暂时降级为 HMAC，后续替换
  return createHMACIdentity();
}

// ─── 工厂函数 ───

export function createIdentity(options?: {
  algorithm?: SignatureAlgorithm;
  hmacKey?: string;
}): Identity {
  const algo = options?.algorithm ?? "hmac-sha256";

  if (algo === "ed25519") {
    return createEd25519Identity();
  }

  return createHMACIdentity(options?.hmacKey);
}

// ─── MessageSigner — 消息签名/验证工具 ───

export interface MessageSigner {
  signMessage(message: Record<string, unknown>, identity: Identity): Record<string, unknown>;
  verifyMessage(
    message: Record<string, unknown>,
    signerPublicKey: string,
    signerId?: string,
  ): VerifyResult;
}

export function createMessageSigner(): MessageSigner {
  return {
    signMessage(message: Record<string, unknown>, identity: Identity): Record<string, unknown> {
      // 移除旧签名（使用常量键名）
      const payload = { ...message };
      delete payload[SIGNATURE_KEY];

      // 序列化（按 key 排序确保确定性）
      const serialized = JSON.stringify(payload, Object.keys(payload).sort());

      // 签名
      const sigResult = identity.sign(serialized);

      return {
        ...payload,
        [SIGNATURE_KEY]: {
          [SIG_ALGORITHM]: sigResult.algorithm,
          [SIG_SIGNER]: sigResult.signer,
          [SIG_SIGNATURE]: sigResult.signature,
          [SIG_TIMESTAMP]: sigResult.timestamp,
        },
      };
    },

    verifyMessage(
      message: Record<string, unknown>,
      signerPublicKey: string,
      signerId?: string,
    ): VerifyResult {
      const sig = message[SIGNATURE_KEY];
      if (sig === undefined || typeof sig !== "object" || sig === null) {
        return { valid: false, error: "No signature found" };
      }

      const sigObj = sig as Record<string, unknown>;
      const signatureHex = sigObj[SIG_SIGNATURE] as string | undefined;
      const extractedSignerId = sigObj[SIG_SIGNER] as string | undefined;

      if (typeof signatureHex !== "string" || typeof extractedSignerId !== "string") {
        return { valid: false, error: "Invalid signature format" };
      }

      // 重建待签名字符串（排除签名）
      const payload = { ...message };
      delete payload[SIGNATURE_KEY];
      const serialized = JSON.stringify(payload, Object.keys(payload).sort());

      // 使用签名者的公钥进行验证（跨实例场景的关键修复）
      // HMAC 模式下需要完整密钥来验证
      // 注意：signerPublicKey 在 HMAC 模式下应为完整密钥（通过安全通道交换）
      const verifyIdentity = createHMACIdentity(signerPublicKey);
      return verifyIdentity.verify(
        serialized,
        signatureHex,
        signerPublicKey,
        signerId ?? extractedSignerId,
      );
    },
  };
}
