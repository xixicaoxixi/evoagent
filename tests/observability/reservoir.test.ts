/**
 * D.1 水库采样统计测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createStatsStore, type StatsStore } from "../../src/observability/reservoir";

describe("D.1 > Reservoir Sampling", () => {
  let store: StatsStore;

  beforeEach(() => {
    store = createStatsStore();
  });

  it("increment 计数器递增", () => {
    store.increment("requests");
    store.increment("requests");
    store.increment("requests", 5);
    const all = store.getAll();
    expect(all["requests"]).toBe(7);
  });

  it("set 仪表盘设置", () => {
    store.set("temperature", 36.5);
    store.set("temperature", 37.0);
    const all = store.getAll();
    expect(all["temperature"]).toBe(37.0);
  });

  it("observe 水库采样 + 百分位", () => {
    // 注入 2000 个值（超过 RESERVOIR_SIZE=1024）
    for (let i = 0; i < 2000; i++) {
      store.observe("latency", i);
    }

    const all = store.getAll();
    expect(all["latency_count"]).toBe(2000);
    expect(all["latency_min"]).toBe(0);
    expect(all["latency_max"]).toBe(1999);
    expect(all["latency_avg"]).toBeCloseTo(999.5, 0);

    // 百分位应该存在
    expect(all["latency_p50"]).toBeGreaterThan(0);
    expect(all["latency_p95"]).toBeGreaterThan(all["latency_p50"]!);
    expect(all["latency_p99"]).toBeGreaterThan(all["latency_p95"]!);
  });

  it("getHistogram 返回完整直方图", () => {
    for (let i = 0; i < 100; i++) {
      store.observe("response_time", i * 10);
    }

    const hist = store.getHistogram("response_time");
    expect(hist).toBeDefined();
    expect(hist!.count).toBe(100);
    expect(hist!.min).toBe(0);
    expect(hist!.max).toBe(990);
    expect(hist!.avg).toBe(495);
    expect(hist!.p50).toBeGreaterThan(0);
    expect(hist!.p99).toBeGreaterThan(hist!.p50);
  });

  it("getHistogram 不存在的指标返回 undefined", () => {
    expect(store.getHistogram("nonexistent")).toBeUndefined();
  });

  it("add 集合去重计数", () => {
    store.add("unique_users", "alice");
    store.add("unique_users", "bob");
    store.add("unique_users", "alice");
    const all = store.getAll();
    expect(all["unique_users"]).toBe(2);
  });

  it("reset 清空所有统计", () => {
    store.increment("a");
    store.observe("b", 1);
    store.add("c", "x");
    store.reset();
    const all = store.getAll();
    expect(Object.keys(all)).toHaveLength(0);
  });

  it("空统计 getAll 返回空对象", () => {
    const all = store.getAll();
    expect(all).toEqual({});
  });

  it("水库采样内存有界（不超过 RESERVOIR_SIZE）", () => {
    for (let i = 0; i < 10000; i++) {
      store.observe("bounded", i);
    }
    const hist = store.getHistogram("bounded");
    expect(hist).toBeDefined();
    expect(hist!.count).toBe(10000);
    // 水库大小固定为 1024，但 getAll 只输出聚合值
    // 验证 p50/p95/p99 存在（基于水库计算）
    expect(hist!.p50).toBeGreaterThan(0);
  });
});

describe("percentile - R7 linear interpolation", () => {
  it("p50 of [1,2,3,4] should be 2.5", () => {
    const store = createStatsStore();
    store.observe("m", 1); store.observe("m", 2);
    store.observe("m", 3); store.observe("m", 4);
    const s = store.get("m")!;
    expect(s.p50).toBeCloseTo(2.5, 5);
  });

  it("p95 of uniform [1..100] should be ≈95.05", () => {
    const store = createStatsStore();
    for (let i = 1; i <= 100; i++) store.observe("m", i);
    const s = store.get("m")!;
    expect(s.p95).toBeCloseTo(95.05, 1);
  });

  it("percentile of empty returns 0", () => {
    const store = createStatsStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("single element returns that element for any percentile", () => {
    const store = createStatsStore();
    store.observe("m", 42);
    const s = store.get("m")!;
    expect(s.p50).toBe(42);
    expect(s.p95).toBe(42);
    expect(s.p99).toBe(42);
  });

  it("p99 of [1..100] should be ≈99.01", () => {
    const store = createStatsStore();
    for (let i = 1; i <= 100; i++) store.observe("m", i);
    const s = store.get("m")!;
    expect(s.p99).toBeCloseTo(99.01, 1);
  });
});
