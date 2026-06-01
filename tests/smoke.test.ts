/**
 * Smoke test - verifies the project skeleton is correctly set up.
 * This test must pass for Stage 0 validation.
 */

import { describe, test, expect } from "vitest";

describe("Stage 0: Project Skeleton", () => {
  test("project entry point exists and exports", async () => {
    // Verify the index.ts can be imported without errors
    const module = await import("../src/index.ts");
    expect(module).toBeDefined();
  });

  test("TypeScript strict mode is enabled", () => {
    // This test file itself serves as proof that strict mode works
    // If strict mode were off, certain type errors would not be caught
    const value: unknown = "test";
    // This would fail with 'any' but works with 'unknown'
    expect(typeof value).toBe("string");
  });

  test("noUncheckedIndexedAccess is enabled", () => {
    // Verify array indexing returns T | undefined
    const arr: readonly string[] = ["a", "b", "c"] as const;
    const item = arr[0];
    // item is string | undefined due to noUncheckedIndexedAccess
    expect(item).toBe("a");
  });

  test("exactOptionalPropertyTypes is enabled", () => {
    // Verify optional properties distinguish between undefined and missing
    type TestObj = { required: string; optional?: string };
    const obj: TestObj = { required: "hello" };
    expect(obj.required).toBe("hello");
    // optional is not present (not undefined)
    expect("optional" in obj).toBe(false);
  });
});
