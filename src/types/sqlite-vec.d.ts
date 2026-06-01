/**
 * sqlite-vec 类型声明 — 动态加载的可选依赖。
 *
 * 此声明文件仅覆盖本项目使用的 sqlite-vec API 子集。
 * 实际模块可能提供更多功能，但本项目只需要 load() 和 getLoadablePath()。
 */

import type { DatabaseSync } from "node:sqlite";

export function getLoadablePath(): string;
export function load(db: DatabaseSync): void;
