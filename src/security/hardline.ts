/**
 * Hardline 无条件阻止层 — 灾难性命令绝对拒绝。
 *
 * 定义即使 YOLO/Override 模式也不能绕过的硬性安全底线。
 * 仅包含真正灾难性的操作：根文件系统删除、fork bomb、
 * 块设备写入、文件系统格式化、系统关机。
 *
 * 规则 2-2: Fail-Closed 默认值。
 * 规则 2-5: 策略模式 > 条件分支（注册表 + 优先级）。
 */

// ─── Hardline 模式定义 ───

export interface HardlinePattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

export const HARDLINE_PATTERNS: readonly HardlinePattern[] = [
  {
    id: "rm_root_recursive",
    pattern: /\brm\s+(?:-[rfRF]+\s+)*-[rfRF]+\s+\/\s*(?:$|[|;&])/,
    reason: "Recursive force delete of root filesystem",
  },
  {
    id: "rm_root_glob",
    pattern: /\brm\s+(?:-[rfRF]+\s+)*-[rfRF]+\s+\/\*/,
    reason: "Recursive force delete of root filesystem contents",
  },
  {
    id: "fork_bomb_classic",
    pattern: /:\(\)\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    reason: "Classic fork bomb pattern",
  },
  {
    id: "fork_bomb_named",
    pattern: /\b\w+\s*\(\)\s*\{\s*\w+\s*\|\s*\w+\s*&\s*\}/,
    reason: "Named function fork bomb pattern",
  },
  {
    id: "mkfs",
    pattern: /\bmkfs\.(?:ext[234]|xfs|btrfs|ntfs|fat|vfat|minix|jfs|reiserfs)\b/,
    reason: "Filesystem format operation",
  },
  {
    id: "dd_block_device_sd",
    pattern: /\bdd\s+.*\bof\s*=\s*\/dev\/sd[a-z]/,
    reason: "Direct write to SCSI/SATA block device",
  },
  {
    id: "dd_block_device_nvme",
    pattern: /\bdd\s+.*\bof\s*=\s*\/dev\/nvme\d/,
    reason: "Direct write to NVMe block device",
  },
  {
    id: "dd_block_device_vd",
    pattern: /\bdd\s+.*\bof\s*=\s*\/dev\/vd[a-z]/,
    reason: "Direct write to virtual block device",
  },
  {
    id: "dd_block_device_disk",
    pattern: /\bdd\s+.*\bof\s*=\s*\/dev\/disk\d/,
    reason: "Direct write to disk device",
  },
  {
    id: "systemctl_shutdown",
    pattern: /\bsystemctl\s+(?:reboot|poweroff|halt|shutdown)\b/,
    reason: "Systemd shutdown/reboot command",
  },
  {
    id: "shutdown",
    pattern: /\bshutdown\b(?:\s|$)/,
    reason: "System shutdown command",
  },
  {
    id: "reboot",
    pattern: /\breboot\b(?:\s|$)/,
    reason: "System reboot command",
  },
  {
    id: "halt",
    pattern: /\bhalt\b(?:\s|$)/,
    reason: "System halt command",
  },
  {
    id: "poweroff",
    pattern: /\bpoweroff\b(?:\s|$)/,
    reason: "System poweroff command",
  },
  {
    id: "init_runlevel_0_6",
    pattern: /\binit\s+[06]\b/,
    reason: "Init runlevel change to shutdown/reboot",
  },
] as const;

// ─── 检查结果 ───

export interface HardlineBlockResult {
  readonly blocked: true;
  readonly reason: string;
  readonly patternId: string;
  readonly matchedValue: string;
}

export interface HardlinePassResult {
  readonly blocked: false;
}

export type HardlineCheckResult = HardlineBlockResult | HardlinePassResult;

// ─── 辅助函数 ───

function extractStringValues(input: unknown, depth: number = 0): readonly string[] {
  if (depth > 10) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) {
    const results: string[] = [];
    for (const item of input) {
      const extracted = extractStringValues(item, depth + 1);
      for (const s of extracted) {
        results.push(s);
      }
    }
    return results;
  }
  if (typeof input === "object" && input !== null) {
    const results: string[] = [];
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const extracted = extractStringValues(val, depth + 1);
      for (const s of extracted) {
        results.push(s);
      }
    }
    return results;
  }
  return [];
}

// ─── 主检查函数 ───

export function checkHardline(
  toolName: string,
  input: Record<string, unknown>,
  additionalPatterns?: readonly HardlinePattern[],
): HardlineCheckResult {
  const allPatterns = additionalPatterns
    ? [...HARDLINE_PATTERNS, ...additionalPatterns]
    : HARDLINE_PATTERNS;

  const stringValues = extractStringValues(input);
  for (const value of stringValues) {
    for (const hp of allPatterns) {
      if (hp.pattern.test(value)) {
        return {
          blocked: true,
          reason: hp.reason,
          patternId: hp.id,
          matchedValue: value,
        };
      }
    }
  }

  return { blocked: false };
}

export function isHardlineBlocked(result: HardlineCheckResult): result is HardlineBlockResult {
  return result.blocked === true;
}
