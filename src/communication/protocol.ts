/**
 * Protocol — P2P 消息协议定义。
 *
 * PeerMessage 数据模型 + 消息类型枚举 + TTL 检查。
 */

import { z } from "zod";

// ─── 消息类型枚举 ───

export const PEER_MESSAGE_TYPES = [
  "knowledge_offer",
  "knowledge_request",
  "rule_sync",
  "challenge",
  "meta_proposal",
  "heartbeat",
  "endorsement",
  "task_delegation",
  "feedback",
  "evolution_sync",
  "code_proposal",
  "architecture_proposal",
  "meta_evaluation",
  "strategy_exploration",
  "anomaly_report",
] as const;

export type PeerMessageType = (typeof PEER_MESSAGE_TYPES)[number];

export const PeerMessageTypeSchema = z.enum(PEER_MESSAGE_TYPES);

export const PeerMessageSchema = z.object({
  message_id: z.string().min(1),
  sender_id: z.string().min(1),
  receiver_id: z.string().min(1),
  message_type: PeerMessageTypeSchema,
  payload: z.record(z.unknown()).default({}),
  signature: z.string().default(""),
  timestamp: z.number().int().positive().default(() => Date.now()),
  ttl: z.number().int().positive().default(300),
});

export type PeerMessage = z.infer<typeof PeerMessageSchema>;
export type PeerMessageInput = z.input<typeof PeerMessageSchema>;

// ─── 消息验证结果 ───

export interface MessageValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ─── 消息验证 ───

export function validatePeerMessage(input: unknown): MessageValidationResult {
  const result = PeerMessageSchema.safeParse(input);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

// ─── TTL 检查 ───

export function isMessageExpired(message: PeerMessage): boolean {
  const now = Date.now();
  const expiresAt = message.timestamp + message.ttl * 1000;
  return now > expiresAt;
}

// ─── 消息创建工厂 ───

export function createPeerMessage(
  input: Omit<PeerMessageInput, "timestamp" | "ttl" | "signature">,
): PeerMessage {
  return PeerMessageSchema.parse({
    ...input,
    timestamp: Date.now(),
    ttl: 300,
    signature: "",
  });
}

// ─── PeerInfo 数据模型 ───

export interface PeerInfo {
  readonly instanceId: string;
  readonly instanceName: string;
  readonly host: string;
  readonly port: number;
  readonly publicKey: string;
  readonly capabilities: readonly string[];
  readonly trustScore: number;
  readonly registeredAt: number;
  readonly lastHeartbeat: number;
  readonly messageCount: number;
  readonly rejectedCount: number;
}

export function createPeerInfo(
  overrides: Partial<Omit<PeerInfo, "instanceId" | "instanceName" | "host" | "port">> &
    Pick<PeerInfo, "instanceId" | "instanceName" | "host" | "port">,
): PeerInfo {
  const now = Date.now();
  return {
    instanceId: overrides.instanceId,
    instanceName: overrides.instanceName,
    host: overrides.host,
    port: overrides.port,
    publicKey: overrides.publicKey ?? "",
    capabilities: overrides.capabilities ?? [],
    trustScore: overrides.trustScore ?? 0.5,
    registeredAt: overrides.registeredAt ?? now,
    lastHeartbeat: overrides.lastHeartbeat ?? now,
    messageCount: overrides.messageCount ?? 0,
    rejectedCount: overrides.rejectedCount ?? 0,
  };
}

/** 心跳不超过 120 秒视为在线 */
export function isPeerAlive(peer: PeerInfo): boolean {
  return Date.now() - peer.lastHeartbeat < 120_000;
}

/** 获取 PeerInfo 的 base URL */
export function getPeerBaseUrl(peer: PeerInfo): string {
  return `http://${peer.host}:${peer.port}`;
}
