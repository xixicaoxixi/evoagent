/**
 * Analytics — 进化经验聚合分析。
 *
 * 提供系统运行状态统计和报告。
 */

// ─── 分析摘要 ───

export interface AnalyticsSummary {
  readonly totalMessages: number;
  readonly totalEndorsements: number;
  readonly totalAnomalies: number;
  readonly activePeers: number;
  readonly marketplaceItems: number;
  readonly openProposals: number;
  readonly timestamp: number;
}

// ─── 趋势数据点 ───

export interface TrendDataPoint {
  readonly timestamp: number;
  readonly value: number;
  readonly label: string;
}

// ─── Analytics 接口 ───

export interface Analytics {
  recordEvent(event: string, value?: number): void;
  getSummary(): AnalyticsSummary;
  getTrend(event: string, limit?: number): readonly TrendDataPoint[];
  incrementCounter(name: string, amount?: number): void;
  getCounter(name: string): number;
  reset(): void;
}

// ─── 创建 Analytics ───

export function createAnalytics(): Analytics {
  const counters = new Map<string, number>();
  const events: Array<{ event: string; value: number; timestamp: number }> = [];
  const MAX_EVENTS = 10_000;

  function recordEvent(event: string, value?: number): void {
    events.push({
      event,
      value: value ?? 1,
      timestamp: Date.now(),
    });

    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
  }

  function getSummary(): AnalyticsSummary {
    return {
      totalMessages: getCounter("messages"),
      totalEndorsements: getCounter("endorsements"),
      totalAnomalies: getCounter("anomalies"),
      activePeers: getCounter("active_peers"),
      marketplaceItems: getCounter("marketplace_items"),
      openProposals: getCounter("open_proposals"),
      timestamp: Date.now(),
    };
  }

  function getTrend(event: string, limit?: number): readonly TrendDataPoint[] {
    const filtered = events.filter((e) => e.event === event);
    const n = limit ?? 100;
    return filtered.slice(-n).map((e) => ({
      timestamp: e.timestamp,
      value: e.value,
      label: e.event,
    }));
  }

  function incrementCounter(name: string, amount?: number): void {
    const current = counters.get(name) ?? 0;
    counters.set(name, current + (amount ?? 1));
  }

  function getCounter(name: string): number {
    return counters.get(name) ?? 0;
  }

  function reset(): void {
    counters.clear();
    events.length = 0;
  }

  return { recordEvent, getSummary, getTrend, incrementCounter, getCounter, reset };
}
