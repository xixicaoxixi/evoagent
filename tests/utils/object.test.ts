import { describe, expect, it } from "vitest";
import { measureObjectDepth } from "../../src/utils/object";

describe("measureObjectDepth", () => {
  it("返回扁平对象的深度", () => {
    expect(measureObjectDepth({ a: 1, b: "x" }, 10)).toBe(0);
  });

  it("返回嵌套对象的最大深度", () => {
    expect(measureObjectDepth({ a: { b: { c: 1 } } }, 10)).toBe(2);
  });

  it("将数组中的对象计入嵌套深度", () => {
    expect(measureObjectDepth({ items: [{ meta: { ok: true } }] }, 10)).toBe(3);
  });

  it("超过最大深度时提前停止递归", () => {
    expect(measureObjectDepth({ a: { b: { c: { d: 1 } } } }, 2)).toBe(3);
  });

  it("忽略 null 和原始值", () => {
    expect(measureObjectDepth({ a: null, b: 1, c: "text" }, 10)).toBe(0);
  });
});
