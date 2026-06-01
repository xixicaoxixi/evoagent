import { describe, expect, it } from "vitest";
import {
  createExecutionState,
  updateSubTaskProgress,
  type ExecutionState,
  type SubTaskProgress,
} from "../../src/mcp-entry";

describe("Fix Step 8: chat_complex 子任务执行结果实时透出", () => {
  describe("createExecutionState", () => {
    it("创建初始执行状态（所有子任务为 pending）", () => {
      const state = createExecutionState("exec_1", ["task_001", "task_002", "task_003"]);

      expect(state.executionId).toBe("exec_1");
      expect(state.status).toBe("in_progress");
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.completedAt).toBeUndefined();
      expect(state.subTasks).toHaveLength(3);
      expect(state.subTasks[0]!.status).toBe("pending");
      expect(state.subTasks[1]!.status).toBe("pending");
      expect(state.subTasks[2]!.status).toBe("pending");
    });

    it("无子任务时创建空执行状态", () => {
      const state = createExecutionState("exec_2", []);

      expect(state.subTasks).toHaveLength(0);
      expect(state.status).toBe("in_progress");
    });
  });

  describe("updateSubTaskProgress", () => {
    it("started 事件将子任务状态更新为 in_progress", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const updated = updateSubTaskProgress(state, "task_001", "started");

      expect(updated.subTasks[0]!.status).toBe("in_progress");
      expect(updated.subTasks[0]!.startedAt).toBeGreaterThan(0);
      expect(updated.status).toBe("in_progress");
    });

    it("completed 事件将子任务状态更新为 completed", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const started = updateSubTaskProgress(state, "task_001", "started");
      const completed = updateSubTaskProgress(started, "task_001", "completed", {
        result: "file saved",
      });

      expect(completed.subTasks[0]!.status).toBe("completed");
      expect(completed.subTasks[0]!.completedAt).toBeGreaterThan(0);
      expect(completed.subTasks[0]!.result).toBe("file saved");
    });

    it("failed 事件将子任务状态更新为 failed", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const started = updateSubTaskProgress(state, "task_001", "started");
      const failed = updateSubTaskProgress(started, "task_001", "failed", {
        error: "timeout",
      });

      expect(failed.subTasks[0]!.status).toBe("failed");
      expect(failed.subTasks[0]!.completedAt).toBeGreaterThan(0);
      expect(failed.subTasks[0]!.error).toBe("timeout");
    });

    it("所有子任务完成后整体状态变为 completed", () => {
      const state = createExecutionState("exec_1", ["task_001", "task_002"]);
      const s1 = updateSubTaskProgress(state, "task_001", "started");
      const s2 = updateSubTaskProgress(s1, "task_001", "completed", { result: "ok" });
      const s3 = updateSubTaskProgress(s2, "task_002", "started");
      const s4 = updateSubTaskProgress(s3, "task_002", "completed", { result: "done" });

      expect(s4.status).toBe("completed");
      expect(s4.completedAt).toBeGreaterThan(0);
    });

    it("所有子任务失败后整体状态变为 failed", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const s1 = updateSubTaskProgress(state, "task_001", "started");
      const s2 = updateSubTaskProgress(s1, "task_001", "failed", { error: "error" });

      expect(s2.status).toBe("failed");
      expect(s2.completedAt).toBeGreaterThan(0);
    });

    it("部分完成部分失败时整体状态为 completed", () => {
      const state = createExecutionState("exec_1", ["task_001", "task_002"]);
      const s1 = updateSubTaskProgress(state, "task_001", "started");
      const s2 = updateSubTaskProgress(s1, "task_001", "completed", { result: "ok" });
      const s3 = updateSubTaskProgress(s2, "task_002", "started");
      const s4 = updateSubTaskProgress(s3, "task_002", "failed", { error: "err" });

      expect(s4.status).toBe("completed");
    });

    it("未完成的子任务不影响整体状态", () => {
      const state = createExecutionState("exec_1", ["task_001", "task_002"]);
      const s1 = updateSubTaskProgress(state, "task_001", "started");
      const s2 = updateSubTaskProgress(s1, "task_001", "completed", { result: "ok" });

      expect(s2.status).toBe("in_progress");
      expect(s2.completedAt).toBeUndefined();
    });

    it("不匹配的 taskId 不影响任何子任务", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const updated = updateSubTaskProgress(state, "task_999", "started");

      expect(updated.subTasks[0]!.status).toBe("pending");
    });

    it("直接跳到 completed 不经过 started 也可以", () => {
      const state = createExecutionState("exec_1", ["task_001"]);
      const completed = updateSubTaskProgress(state, "task_001", "completed", {
        result: "direct",
      });

      expect(completed.subTasks[0]!.status).toBe("completed");
      expect(completed.subTasks[0]!.result).toBe("direct");
      expect(completed.status).toBe("completed");
    });
  });

  describe("多子任务并发场景", () => {
    it("模拟两个子任务并发执行", () => {
      const state = createExecutionState("exec_1", ["task_001", "task_002"]);

      const s1 = updateSubTaskProgress(state, "task_001", "started");
      const s2 = updateSubTaskProgress(s1, "task_002", "started");

      expect(s2.subTasks[0]!.status).toBe("in_progress");
      expect(s2.subTasks[1]!.status).toBe("in_progress");
      expect(s2.status).toBe("in_progress");

      const s3 = updateSubTaskProgress(s2, "task_001", "completed", { result: "first" });
      expect(s3.status).toBe("in_progress");

      const s4 = updateSubTaskProgress(s3, "task_002", "completed", { result: "second" });
      expect(s4.status).toBe("completed");
    });
  });

  describe("SubTaskProgressCallback 集成", () => {
    it("onProgress 回调正确更新 ExecutionState Map", () => {
      const executionStates = new Map<string, ExecutionState>();
      const executionId = "exec_test";
      const subTaskIds = ["task_001", "task_002"];

      executionStates.set(executionId, createExecutionState(executionId, subTaskIds));

      const onProgress = (taskId: string, status: "started" | "completed" | "failed", details?: { result?: unknown; error?: string }) => {
        const current = executionStates.get(executionId);
        if (!current) return;
        executionStates.set(executionId, updateSubTaskProgress(current, taskId, status, details));
      };

      onProgress("task_001", "started");
      let current = executionStates.get(executionId)!;
      expect(current.subTasks[0]!.status).toBe("in_progress");

      onProgress("task_001", "completed", { result: "done" });
      current = executionStates.get(executionId)!;
      expect(current.subTasks[0]!.status).toBe("completed");
      expect(current.subTasks[0]!.result).toBe("done");

      onProgress("task_002", "started");
      onProgress("task_002", "failed", { error: "boom" });
      current = executionStates.get(executionId)!;
      expect(current.subTasks[1]!.status).toBe("failed");
      expect(current.subTasks[1]!.error).toBe("boom");
      expect(current.status).toBe("completed");
    });
  });

  describe("task_status 工具逻辑模拟", () => {
    it("查询存在的 executionId 返回当前状态", () => {
      const executionStates = new Map<string, ExecutionState>();
      const executionId = "exec_query";
      executionStates.set(executionId, createExecutionState(executionId, ["task_001"]));

      const state = executionStates.get(executionId);
      expect(state).toBeDefined();
      expect(state!.executionId).toBe("exec_query");
      expect(state!.status).toBe("in_progress");
    });

    it("查询不存在的 executionId 返回 undefined", () => {
      const executionStates = new Map<string, ExecutionState>();
      const state = executionStates.get("nonexistent");
      expect(state).toBeUndefined();
    });
  });
});
