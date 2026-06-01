/**
 * Gateway — 通信网关（星型拓扑）。
 *
 * 统一管理 P2P 连接、消息路由、组件协调。
 *
 * E.2 修复 DC-01: 签名验证集成到消息接收流程。
 */

import type { PeerInfo } from "./protocol";
import type { PeerMessage } from "./protocol";
import type { AnomalyDetector } from "./anomaly";
import type { Identity } from "./identity";
import { createBoundedUUIDSet, type BoundedUUIDSet } from "./dedup";
import { markExternalContent, normalizeUnicodeForSafety, detectPromptInjection } from "../security/external-content";
import { measureObjectDepth } from "../utils/object";
import {
  SIGNATURE_KEY,
  SIG_SIGNER,
  SIG_SIGNATURE,
  SIG_PUBLIC_KEY,
} from "./constants";

// ─── 网关配置 ───

export interface GatewayConfig {
  readonly maxPeers?: number;
  readonly dedupCapacity?: number;
  readonly promptInjectionThreshold?: number;
}

// ─── 网关接口 ───

export interface Gateway {
  /** 注册对等节点 */
  addPeer(peer: PeerInfo): boolean;
  /** 移除对等节点 */
  removePeer(instanceId: string): boolean;
  /** 获取对等节点 */
  getPeer(instanceId: string): PeerInfo | null;
  /** 列出所有对等节点 */
  listPeers(): readonly PeerInfo[];
  /** 处理接收到的消息 */
  handleMessage(message: PeerMessage): MessageHandleResult;
  /** 检查是否为重复消息 */
  isDuplicate(messageId: string): boolean;
  /** 获取活跃节点数 */
  getActivePeerCount(): number;
  /** 获取统计信息 */
  getStats(): GatewayStats;
}

// ─── 消息处理结果 ───

export interface MessageHandleResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

// ─── 网关统计 ───

export interface GatewayStats {
  readonly totalPeers: number;
  readonly activePeers: number;
  readonly messagesReceived: number;
  readonly messagesRejected: number;
  readonly duplicateMessages: number;
}

// ─── 默认值 ───

const DEFAULT_MAX_PEERS = 100;
const DEFAULT_DEDUP_CAPACITY = 10_000;
const DEFAULT_PROMPT_INJECTION_THRESHOLD = 3;
const MAX_PAYLOAD_SIZE = 100_000;
const MAX_PAYLOAD_DEPTH = 20;

// ─── 创建网关 ───

export function createGateway(
  config?: GatewayConfig,
  dependencies?: {
    anomalyDetector?: AnomalyDetector;
    identity?: Identity;
  },
): Gateway {
  const maxPeers = config?.maxPeers ?? DEFAULT_MAX_PEERS;
  const promptInjectionThreshold = config?.promptInjectionThreshold ?? DEFAULT_PROMPT_INJECTION_THRESHOLD;
  const dedup: BoundedUUIDSet = createBoundedUUIDSet(
    config?.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY,
  );

  const peers = new Map<string, PeerInfo>();
  let messagesReceived = 0;
  let messagesRejected = 0;
  let duplicateMessages = 0;

  function addPeer(peer: PeerInfo): boolean {
    if (peers.has(peer.instanceId)) return false;
    if (peers.size >= maxPeers) return false;

    peers.set(peer.instanceId, peer);
    return true;
  }

  function removePeer(instanceId: string): boolean {
    return peers.delete(instanceId);
  }

  function getPeer(instanceId: string): PeerInfo | null {
    return peers.get(instanceId) ?? null;
  }

  function listPeers(): readonly PeerInfo[] {
    return [...peers.values()];
  }

  function handleMessage(message: PeerMessage): MessageHandleResult {
    messagesReceived++;

    // 去重检查
    if (dedup.has(message.message_id)) {
      duplicateMessages++;
      return { accepted: false, reason: "Duplicate message" };
    }
    dedup.add(message.message_id);

    // TTL 检查
    const now = Date.now();
    if (now > message.timestamp + message.ttl * 1000) {
      messagesRejected++;
      return { accepted: false, reason: "Message expired" };
    }

    // C.3: payload 大小限制
    const payloadStr = JSON.stringify(message.payload);
    if (payloadStr.length > MAX_PAYLOAD_SIZE) {
      messagesRejected++;
      return { accepted: false, reason: `Payload exceeds ${MAX_PAYLOAD_SIZE} bytes` };
    }

    const payloadDepth = measureObjectDepth(message.payload, MAX_PAYLOAD_DEPTH);
    if (payloadDepth > MAX_PAYLOAD_DEPTH) {
      messagesRejected++;
      return { accepted: false, reason: `Payload nesting depth exceeds ${MAX_PAYLOAD_DEPTH}` };
    }

    if (dependencies?.identity !== undefined) {
      const sig = (message.payload as Record<string, unknown>)?.[SIGNATURE_KEY];
      if (sig !== undefined && typeof sig === "object" && sig !== null) {
        const sigObj = sig as Record<string, unknown>;
        const signerId = sigObj[SIG_SIGNER] as string | undefined;
        const signatureHex = sigObj[SIG_SIGNATURE] as string | undefined;
        const publicKey = sigObj[SIG_PUBLIC_KEY] as string | undefined;

        if (typeof signerId === "string" && typeof signatureHex === "string") {
          const peer = peers.get(message.sender_id);
          const peerPublicKey = peer?.publicKey ?? publicKey;

          if (typeof peerPublicKey === "string") {
            const payloadForVerify = { ...message.payload };
            delete (payloadForVerify as Record<string, unknown>)[SIGNATURE_KEY];
            const serializedPayload = JSON.stringify(
              payloadForVerify,
              Object.keys(payloadForVerify).sort(),
            );

            const verifyResult = dependencies.identity.verify(
              serializedPayload,
              signatureHex,
              peerPublicKey,
              signerId,
            );
            if (!verifyResult.valid) {
              messagesRejected++;
              return {
                accepted: false,
                reason: verifyResult.error ?? "Signature verification failed",
              };
            }
          }
        }
      }
    }

    if (dependencies?.anomalyDetector !== undefined) {
      const anomalyResult = dependencies.anomalyDetector.checkMessage(
        message.sender_id,
        payloadStr,
      );
      if (!anomalyResult.allowed) {
        messagesRejected++;
        return {
          accepted: false,
          reason: anomalyResult.reason ?? "Anomaly detected",
        };
      }
    }

    // A.4: 外部内容安全检测

    // Unicode 净化检测
    const sanitizedPayloadStr = normalizeUnicodeForSafety(payloadStr);
    if (sanitizedPayloadStr.length < payloadStr.length * 0.5) {
      messagesRejected++;
      return { accepted: false, reason: "Payload contains excessive Unicode anomalies" };
    }

    // 提示注入检测
    const injectionPatterns = detectPromptInjection(payloadStr);
    if (injectionPatterns.length >= promptInjectionThreshold) {
      messagesRejected++;
      return { accepted: false, reason: "Payload contains potential prompt injection patterns" };
    }

    // A.4: 外部内容安全标记
    // 对 P2P 来源的文本内容添加安全边界标记，防止 LLM 将外部内容视为可信指令
    const safePayload = { ...(message.payload as Record<string, unknown>) };
    if (typeof safePayload === "object" && safePayload !== null) {
      for (const [key, value] of Object.entries(safePayload)) {
        if (typeof value === "string" && value.length > 0) {
          safePayload[key] = markExternalContent(value, {
            source: "p2p",
            sender: message.sender_id,
            subject: key,
          });
        }
      }
    }

    return { accepted: true };
  }

  function isDuplicate(messageId: string): boolean {
    return dedup.has(messageId);
  }

  function getActivePeerCount(): number {
    let count = 0;
    for (const peer of peers.values()) {
      if (Date.now() - peer.lastHeartbeat < 120_000) {
        count++;
      }
    }
    return count;
  }

  function getStats(): GatewayStats {
    return {
      totalPeers: peers.size,
      activePeers: getActivePeerCount(),
      messagesReceived,
      messagesRejected,
      duplicateMessages,
    };
  }

  return {
    addPeer,
    removePeer,
    getPeer,
    listPeers,
    handleMessage,
    isDuplicate,
    getActivePeerCount,
    getStats,
  };
}
