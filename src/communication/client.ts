/**
 * P2P Client — 对等节点客户端。
 *
 * 异步 HTTP 通信 + 消息签名 + 连接管理。
 */

import type { Identity } from "./identity";
import type { MessageSigner } from "./identity";
import type { PeerInfo, PeerMessage } from "./protocol";
import { getPeerBaseUrl } from "./protocol";

// ─── P2P 客户端接口 ───

export interface P2PClient {
  /** 发送消息 */
  sendMessage(peer: PeerInfo, message: PeerMessage, identity?: Identity): Promise<P2PResponse>;
  /** 心跳检测 */
  ping(peer: PeerInfo): Promise<boolean>;
  /** 注册对等节点 */
  register(peer: PeerInfo, myInfo: Record<string, unknown>): Promise<P2PResponse>;
  /** 同步规则 */
  syncRules(peer: PeerInfo, rulesData: Record<string, unknown>): Promise<P2PResponse>;
  /** 发送背书 */
  sendEndorsement(peer: PeerInfo, endorsement: Record<string, unknown>): Promise<P2PResponse>;
  /** 获取对等节点信息 */
  getPeerInfo(peer: PeerInfo): Promise<P2PResponse>;
  /** 报告异常 */
  reportAnomaly(peer: PeerInfo, report: Record<string, unknown>): Promise<P2PResponse>;
}

// ─── P2P 响应 ───

export interface P2PResponse {
  readonly success: boolean;
  readonly status: number;
  readonly data: unknown;
  readonly error?: string;
}

// ─── P2P 客户端配置 ───

export interface P2PClientConfig {
  readonly timeoutMs?: number;
  readonly messageSigner?: MessageSigner;
}

// ─── 默认值 ───

const DEFAULT_TIMEOUT_MS = 10_000;

// ─── 创建 P2P 客户端 ───

export function createP2PClient(
  config?: P2PClientConfig,
): P2PClient {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const messageSigner = config?.messageSigner;

  /** 发送 HTTP 请求 */
  async function httpRequest(
    baseUrl: string,
    path: string,
    options: {
      method: string;
      body?: unknown;
    },
  ): Promise<P2PResponse> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          "Content-Type": "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      return {
        success: response.ok,
        status: response.status,
        data,
      };
    } catch (err) {
      return {
        success: false,
        status: 0,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function sendMessage(
    peer: PeerInfo,
    message: PeerMessage,
    identity?: Identity,
  ): Promise<P2PResponse> {
    let finalMessage = message as Record<string, unknown>;

    // 签名
    if (identity !== undefined && messageSigner !== undefined) {
      finalMessage = messageSigner.signMessage(message, identity);
    }

    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/message", {
      method: "POST",
      body: finalMessage,
    });
  }

  async function ping(peer: PeerInfo): Promise<boolean> {
    const result = await httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/ping", {
      method: "GET",
    });
    return result.success;
  }

  async function register(
    peer: PeerInfo,
    myInfo: Record<string, unknown>,
  ): Promise<P2PResponse> {
    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/register", {
      method: "POST",
      body: myInfo,
    });
  }

  async function syncRules(
    peer: PeerInfo,
    rulesData: Record<string, unknown>,
  ): Promise<P2PResponse> {
    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/sync-rules", {
      method: "POST",
      body: rulesData,
    });
  }

  async function sendEndorsement(
    peer: PeerInfo,
    endorsement: Record<string, unknown>,
  ): Promise<P2PResponse> {
    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/endorsement", {
      method: "POST",
      body: endorsement,
    });
  }

  async function getPeerInfo(peer: PeerInfo): Promise<P2PResponse> {
    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/info", {
      method: "GET",
    });
  }

  async function reportAnomaly(
    peer: PeerInfo,
    report: Record<string, unknown>,
  ): Promise<P2PResponse> {
    return httpRequest(getPeerBaseUrl(peer), "/api/v1/peer/anomaly-report", {
      method: "POST",
      body: report,
    });
  }

  return {
    sendMessage,
    ping,
    register,
    syncRules,
    sendEndorsement,
    getPeerInfo,
    reportAnomaly,
  };
}
