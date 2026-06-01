import { describe, it, expect } from "vitest";
import {
  createCircuitBreaker,
  type CircuitState,
  type CircuitBreakerObserver,
} from "../../src/mcp/circuit-breaker";

describe("CircuitBreaker — 初始状态", () => {
  it("初始状态为 CLOSED", () => {
    const cb = createCircuitBreaker();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.openedAt).toBe(0);
  });

  it("CLOSED 状态下 canExecute 返回 true", () => {
    const cb = createCircuitBreaker();
    expect(cb.canExecute()).toBe(true);
  });
});

describe("CircuitBreaker — CLOSED → OPEN 转换", () => {
  it("连续失败达到阈值时转为 OPEN（默认阈值 3）", () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState; reason: string }> = [];
    const observer: CircuitBreakerObserver = {
      onStateChange: (from, to, reason) => {
        transitions.push({ from, to, reason });
      },
    };

    const cb = createCircuitBreaker(undefined, observer);

    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(1);

    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(2);

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.consecutiveFailures).toBe(3);
    expect(cb.openedAt).toBeGreaterThan(0);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toEqual({
      from: "CLOSED",
      to: "OPEN",
      reason: "failure_threshold_reached",
    });
  });

  it("自定义阈值生效", () => {
    const cb = createCircuitBreaker({ failureThreshold: 5 });

    for (let i = 0; i < 4; i++) {
      cb.recordFailure();
      expect(cb.state).toBe("CLOSED");
    }

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.consecutiveFailures).toBe(5);
  });

  it("OPEN 状态下 canExecute 返回 false", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
  });
});

describe("CircuitBreaker — OPEN → HALF_OPEN 转换", () => {
  it("冷却期未过时 canExecute 返回 false", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
    expect(cb.state).toBe("OPEN");
  });

  it("冷却期过后 canExecute 返回 true 并转为 HALF_OPEN", async () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
    const observer: CircuitBreakerObserver = {
      onStateChange: (from, to) => {
        transitions.push({ from, to });
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 1, cooldownMs: 100 },
      observer,
    );

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));

    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");

    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toEqual({ from: "OPEN", to: "HALF_OPEN" });
  });
});

describe("CircuitBreaker — HALF_OPEN → CLOSED 转换", () => {
  it("探测成功时转为 CLOSED", async () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState; reason: string }> = [];
    const observer: CircuitBreakerObserver = {
      onStateChange: (from, to, reason) => {
        transitions.push({ from, to, reason });
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 1, cooldownMs: 100 },
      observer,
    );

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(0);

    expect(transitions).toHaveLength(3);
    expect(transitions[2]).toEqual({
      from: "HALF_OPEN",
      to: "CLOSED",
      reason: "probe_succeeded",
    });
  });
});

describe("CircuitBreaker — HALF_OPEN → OPEN 转换", () => {
  it("探测失败时回到 OPEN", async () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState; reason: string }> = [];
    const observer: CircuitBreakerObserver = {
      onStateChange: (from, to, reason) => {
        transitions.push({ from, to, reason });
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 1, cooldownMs: 100 },
      observer,
    );

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");

    cb.recordFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.consecutiveFailures).toBe(2);

    expect(transitions).toHaveLength(3);
    expect(transitions[2]).toEqual({
      from: "HALF_OPEN",
      to: "OPEN",
      reason: "probe_failed",
    });
  });
});

describe("CircuitBreaker — 完整生命周期", () => {
  it("CLOSED → OPEN → HALF_OPEN → CLOSED 完整循环", async () => {
    const transitions: Array<CircuitState> = [];
    const observer: CircuitBreakerObserver = {
      onStateChange: (_from, to) => {
        transitions.push(to);
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 3, cooldownMs: 100 },
      observer,
    );

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));

    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(0);

    expect(transitions).toEqual(["OPEN", "HALF_OPEN", "CLOSED"]);
  });

  it("CLOSED → OPEN → HALF_OPEN → OPEN → HALF_OPEN → CLOSED 反复探测", async () => {
    const cb = createCircuitBreaker(
      { failureThreshold: 2, cooldownMs: 100 },
    );

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));
    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");
    cb.recordSuccess();
    expect(cb.state).toBe("CLOSED");
  });
});

describe("CircuitBreaker — 成功重置失败计数", () => {
  it("CLOSED 状态下成功调用重置连续失败计数", () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.consecutiveFailures).toBe(2);

    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("CLOSED");
  });
});

describe("CircuitBreaker — 手动重置", () => {
  it("reset 将状态恢复为 CLOSED", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe("OPEN");

    cb.reset();
    expect(cb.state).toBe("CLOSED");
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.openedAt).toBe(0);
  });

  it("reset 后 canExecute 返回 true", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);

    cb.reset();
    expect(cb.canExecute()).toBe(true);
  });
});

describe("CircuitBreaker — 观测回调上下文", () => {
  it("failure_threshold_reached 包含阈值和失败次数", () => {
    let lastContext: Readonly<Record<string, unknown>> | undefined;
    const observer: CircuitBreakerObserver = {
      onStateChange: (_from, _to, _reason, context) => {
        lastContext = context;
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 3 },
      observer,
    );

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    expect(lastContext).toBeDefined();
    expect(lastContext!.consecutiveFailures).toBe(3);
    expect(lastContext!.threshold).toBe(3);
  });

  it("cooldown_expired 包含冷却时间和已过时间", async () => {
    let lastContext: Readonly<Record<string, unknown>> | undefined;
    const observer: CircuitBreakerObserver = {
      onStateChange: (_from, _to, _reason, context) => {
        lastContext = context;
      },
    };

    const cb = createCircuitBreaker(
      { failureThreshold: 1, cooldownMs: 100 },
      observer,
    );

    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 150));
    cb.canExecute();

    expect(lastContext).toBeDefined();
    expect(lastContext!.cooldownMs).toBe(100);
    expect(typeof lastContext!.elapsedMs).toBe("number");
    expect(lastContext!.elapsedMs as number).toBeGreaterThanOrEqual(100);
  });
});

describe("CircuitBreaker — 同状态不触发回调", () => {
  it("CLOSED → CLOSED 不触发 onStateChange", () => {
    let callCount = 0;
    const observer: CircuitBreakerObserver = {
      onStateChange: () => {
        callCount++;
      },
    };

    const cb = createCircuitBreaker(undefined, observer);
    cb.recordSuccess();
    cb.recordSuccess();

    expect(callCount).toBe(0);
  });
});
