export function measureObjectDepth(obj: unknown, maxDepth: number): number {
  function measure(value: unknown, current: number): number {
    if (current > maxDepth) return current;
    if (value === null || typeof value !== "object") return current;
    let maxChild = current;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child !== null && typeof child === "object") {
        const childDepth = measure(child, current + 1);
        if (childDepth > maxChild) maxChild = childDepth;
      }
    }
    return maxChild;
  }

  return measure(obj, 0);
}
