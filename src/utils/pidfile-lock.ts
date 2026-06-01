import { atomicWriteText } from "../persistence/atomic-write";

const DEFAULT_LOCK_PATH = ".evoagent.lock";

export interface PidfileLock {
  readonly acquire: () => void;
  readonly release: () => void;
  readonly isHeld: () => boolean;
}

export interface PidfileLockConfig {
  readonly lockPath?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createPidfileLock(config?: PidfileLockConfig): PidfileLock {
  const lockPath = config?.lockPath ?? DEFAULT_LOCK_PATH;
  let held = false;

  function acquire(): void {
    if (held) {
      throw new Error(`EvoAgent instance is already running in this process (PID ${process.pid}).`);
    }

    const fs = require("fs") as typeof import("fs");
    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, "utf-8").trim();
      const existingPid = Number.parseInt(content, 10);
      if (Number.isFinite(existingPid) && existingPid > 0) {
        if (isProcessAlive(existingPid)) {
          throw new Error(
            `Another EvoAgent instance is already running (PID ${existingPid}). ` +
            `If the previous instance crashed, delete ${lockPath} and try again.`,
          );
        }
        console.warn(`[PIDFILE] Stale lock file found (PID ${existingPid} is no longer alive). Removing.`);
      }
    }

    const tmpPath = `${lockPath}.tmp.${process.pid}`;
    const fsModule = require("fs") as typeof import("fs");
    fsModule.writeFileSync(tmpPath, String(process.pid), "utf-8");
    fsModule.renameSync(tmpPath, lockPath);
    held = true;
  }

  function release(): void {
    if (!held) return;

    try {
      const fs = require("fs") as typeof import("fs");
      if (fs.existsSync(lockPath)) {
        const content = fs.readFileSync(lockPath, "utf-8").trim();
        const storedPid = Number.parseInt(content, 10);
        if (storedPid === process.pid) {
          fs.unlinkSync(lockPath);
        } else {
          console.warn(`[PIDFILE] Lock file contains PID ${storedPid}, expected ${process.pid}. Not removing.`);
        }
      }
    } catch (err) {
      console.warn(`[PIDFILE] Failed to release lock: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      held = false;
    }
  }

  function isHeld(): boolean {
    return held;
  }

  return { acquire, release, isHeld };
}
