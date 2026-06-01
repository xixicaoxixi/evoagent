/**
 * MCP InProcessTransport — 进程内传输通道。
 *
 * 用于同一进程中运行 MCP 服务器和客户端，无需生成子进程。
 * 使用 queueMicrotask 异步投递，避免同步请求/响应循环的栈深度问题。
 */

// ─── JSON-RPC 消息类型 ───

export interface JSONRPCMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: JSONRPCError;
}

export interface JSONRPCError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

// ─── Transport 接口 ───

export interface Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
}

// ─── InProcessTransport 实现 ───

export class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined;
  private closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    // 进程内传输无需启动
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error("Transport is closed");
    }

    // 使用 queueMicrotask 异步投递，避免栈深度问题
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) {
        this.peer.onmessage?.(message);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();

    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.onclose?.();
    }
  }

  /** 内部方法：设置对端（由 createLinkedTransportPair 调用） */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer;
  }

  /** 检查是否已关闭 */
  isClosed(): boolean {
    return this.closed;
  }
}

// ─── 创建链接的传输对 ───

export function createLinkedTransportPair(): [Transport, Transport] {
  const client = new InProcessTransport();
  const server = new InProcessTransport();
  client._setPeer(server);
  server._setPeer(client);
  return [client, server]; // [clientTransport, serverTransport]
}

export class StdioTransport implements Transport {
  private closed = false;
  private buffer = "";

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed) as JSONRPCMessage;
          if (message.jsonrpc === "2.0") {
            this.onmessage?.(message);
          }
        } catch {
          this.onerror?.(new Error(`Invalid JSON-RPC message: ${trimmed.slice(0, 200)}`));
        }
      }
    });

    process.stdin.on("end", () => {
      if (!this.closed) {
        this.close();
      }
    });

    process.stdin.on("error", (err: Error) => {
      this.onerror?.(err);
    });

    process.stdin.resume();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error("Transport is closed");
    }
    const json = JSON.stringify(message);
    process.stdout.write(`${json}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    process.stdin.pause();
    this.onclose?.();
  }

  isClosed(): boolean {
    return this.closed;
  }
}
