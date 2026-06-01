/**
 * D.1 结构化日志测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createLogger, type LogEntry, type Logger } from "../../src/observability/logger";

describe("D.1 > Logger", () => {
  it("默认级别 info 过滤 debug", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      handler: (e) => entries.push(e),
      minLevel: "info",
    });

    logger.debug("should be filtered");
    logger.info("should appear");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("should appear");
    expect(entries[0]!.level).toBe("info");
  });

  it("级别门控：debug < info < warn < error", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      handler: (e) => entries.push(e),
      minLevel: "warn",
    });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("结构化字段传递", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ handler: (e) => entries.push(e) });

    logger.info("test", { key: "value", num: 42 });
    expect(entries[0]!.fields).toEqual({ key: "value", num: 42 });
  });

  it("时间戳包含在默认配置中", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({ handler: (e) => entries.push(e) });

    logger.info("test");
    expect(entries[0]!.timestamp).toBeTruthy();
    // ISO 格式验证
    expect(entries[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includeTimestamp=false 不包含时间戳", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      handler: (e) => entries.push(e),
      includeTimestamp: false,
    });

    logger.info("test");
    expect(entries[0]!.timestamp).toBe("");
  });

  it("source 标识", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      handler: (e) => entries.push(e),
      source: "my-module",
    });

    logger.info("test");
    expect(entries[0]!.source).toBe("my-module");
  });

  it("child logger 继承级别并拼接 source", () => {
    const entries: LogEntry[] = [];
    const parent = createLogger({
      handler: (e) => entries.push(e),
      source: "parent",
      minLevel: "debug",
    });

    const child = parent.child("child");
    child.debug("test");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source).toBe("parent:child");
  });

  it("setLevel 动态调整级别", () => {
    const entries: LogEntry[] = [];
    const logger = createLogger({
      handler: (e) => entries.push(e),
      minLevel: "error",
    });

    logger.info("filtered");
    logger.setLevel("debug");
    logger.info("visible");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("visible");
  });

  it("getLevel 返回当前级别", () => {
    const logger = createLogger({ minLevel: "warn" });
    expect(logger.getLevel()).toBe("warn");
    logger.setLevel("debug");
    expect(logger.getLevel()).toBe("debug");
  });
});
