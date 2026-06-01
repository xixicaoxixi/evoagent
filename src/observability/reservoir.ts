/**
 * Reservoir Sampler — 水库采样统计。
 *
 * RULES_2-14: 水库采样（固定内存流式统计）。
 * R1 修复：添加 dirty flag 缓存排序结果，避免每次 getAll/getHistogram 全量排序。
 */

// ─── StatsStore 接口 ───

export interface StatsStore {
  observe(metric: string, value: number): void;
  increment(metric: string, count?: number): void;
  set(metric: string, value: number): void;
  add(metric: string, value: string): void;
  getAll(): Record<string, number>;
  get(metric: string): MetricSummary | undefined;
  getHistogram(metric: string, buckets?: number): HistogramResult | undefined;
  reset(): void;
}

// ─── MetricSummary ───

export interface MetricSummary {
  readonly count: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly sum: number;
}

// ─── HistogramResult ───

export interface HistogramResult {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p99: number;
}

export type Histogram = ReadonlyMap<string, MetricSummary>;

// ─── 常量 ───

const RESERVOIR_SIZE = 1024;

// ─── 水库采样器 ───

class ReservoirSampler {
  private readonly samples: number[] = [];
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;
  private sortedCache: number[] | null = null;

  add(value: number): void {
    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;

    if (this.samples.length < RESERVOIR_SIZE) {
      this.samples.push(value);
    } else {
      const idx = Math.floor(Math.random() * this.count);
      if (idx < RESERVOIR_SIZE) {
        this.samples[idx] = value;
      }
    }

    this.sortedCache = null;
  }

  getSorted(): readonly number[] {
    if (this.sortedCache === null) {
      this.sortedCache = [...this.samples].sort((a, b) => a - b);
    }
    return this.sortedCache;
  }

  getCount(): number {
    return this.count;
  }

  getSum(): number {
    return this.sum;
  }

  getMin(): number {
    return this.min;
  }

  getMax(): number {
    return this.max;
  }

  reset(): void {
    this.samples.length = 0;
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.sortedCache = null;
  }
}

// ─── 百分位数计算 ───

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const h = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = h - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// ─── 创建 StatsStore ───

export function createStatsStore(): StatsStore {
  const samplers = new Map<string, ReservoirSampler>();
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const sets = new Map<string, Set<string>>();

  function observe(metric: string, value: number): void {
    let sampler = samplers.get(metric);
    if (sampler === undefined) {
      sampler = new ReservoirSampler();
      samplers.set(metric, sampler);
    }
    sampler.add(value);
  }

  function increment(metric: string, count: number = 1): void {
    counters.set(metric, (counters.get(metric) ?? 0) + count);
  }

  function set(metric: string, value: number): void {
    gauges.set(metric, value);
  }

  function add(metric: string, value: string): void {
    let set = sets.get(metric);
    if (set === undefined) {
      set = new Set<string>();
      sets.set(metric, set);
    }
    set.add(value);
  }

  function getAll(): Record<string, number> {
    const result: Record<string, number> = {};

    for (const [metric, count] of counters) {
      result[metric] = count;
    }

    for (const [metric, value] of gauges) {
      result[metric] = value;
    }

    for (const [metric, set] of sets) {
      result[metric] = set.size;
    }

    for (const [metric, sampler] of samplers) {
      const sorted = sampler.getSorted();
      const count = sampler.getCount();
      result[`${metric}_count`] = count;
      result[`${metric}_min`] = sampler.getMin() === Infinity ? 0 : sampler.getMin();
      result[`${metric}_max`] = sampler.getMax() === -Infinity ? 0 : sampler.getMax();
      result[`${metric}_avg`] = count > 0 ? sampler.getSum() / count : 0;
      result[`${metric}_p50`] = percentile(sorted, 50);
      result[`${metric}_p95`] = percentile(sorted, 95);
      result[`${metric}_p99`] = percentile(sorted, 99);
    }

    return result;
  }

  function get(metric: string): MetricSummary | undefined {
    const sampler = samplers.get(metric);
    if (sampler === undefined) return undefined;
    const sorted = sampler.getSorted();
    const count = sampler.getCount();
    return {
      count,
      mean: count > 0 ? sampler.getSum() / count : 0,
      min: sampler.getMin() === Infinity ? 0 : sampler.getMin(),
      max: sampler.getMax() === -Infinity ? 0 : sampler.getMax(),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      sum: sampler.getSum(),
    };
  }

  function getHistogram(metric: string): HistogramResult | undefined {
    const sampler = samplers.get(metric);
    if (sampler === undefined) return undefined;

    const sorted = sampler.getSorted();
    const count = sampler.getCount();

    return {
      count,
      min: sampler.getMin() === Infinity ? 0 : sampler.getMin(),
      max: sampler.getMax() === -Infinity ? 0 : sampler.getMax(),
      avg: count > 0 ? sampler.getSum() / count : 0,
      p50: percentile(sorted, 50),
      p99: percentile(sorted, 99),
    };
  }

  function reset(): void {
    samplers.clear();
    counters.clear();
    gauges.clear();
    sets.clear();
  }

  return {
    observe,
    increment,
    set,
    add,
    getAll,
    get,
    getHistogram,
    reset,
  };
}
