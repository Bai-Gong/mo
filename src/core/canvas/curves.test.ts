/**
 * 曲线插值测试（M4 调整面板显示数学）：期望值与 Rust adjustments.rs 的
 * `曲线_控制点精确过点_且中间单调` / `曲线_极值点不过冲` 同一组手算口径——
 * 两端同值锁死，漂移任一侧暴露。
 */
import { describe, expect, it } from "vitest";
import { curveAt, normalizePoints } from "./curves";

describe("normalizePoints", () => {
  it("钳制到 [0,255] 并按 x 升序排序", () => {
    expect(normalizePoints([[255, 255], [0, 0]])).toEqual([[0, 0], [255, 255]]);
    expect(normalizePoints([[-10, -5], [300, 999]])).toEqual([[0, 0], [255, 255]]);
  });

  it("少于 2 点或 x 重复返回 null", () => {
    expect(normalizePoints([])).toBeNull();
    expect(normalizePoints([[128, 128]])).toBeNull();
    expect(normalizePoints([[64, 0], [64, 255]])).toBeNull();
  });
});

describe("curveAt（与 Rust curves_lut 同口径）", () => {
  it("恒等曲线逐点不变", () => {
    const pts: [number, number][] = [[0, 0], [255, 255]];
    for (const v of [0, 1, 64, 128, 200, 255]) {
      expect(curveAt(pts, v)).toBeCloseTo(v, 5);
    }
  });

  it("控制点精确过点且全程单调不降", () => {
    const pts: [number, number][] = [[0, 0], [64, 96], [255, 255]];
    expect(curveAt(pts, 0)).toBeCloseTo(0, 5);
    expect(curveAt(pts, 64)).toBeCloseTo(96, 5);
    expect(curveAt(pts, 255)).toBeCloseTo(255, 5);
    let prev = -Infinity;
    for (let i = 0; i <= 255; i++) {
      const y = curveAt(pts, i);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-4);
      prev = y;
    }
    // 暗部抬升、亮部基本保持（与 Rust 同断言口径）
    expect(curveAt(pts, 16)).toBeGreaterThan(16);
    expect(Math.abs(curveAt(pts, 240) - 240)).toBeLessThan(8);
  });

  it("U 形曲线不冲出控制点值域（极值点切线置 0）", () => {
    const pts: [number, number][] = [[0, 64], [128, 0], [255, 192]];
    for (let i = 0; i <= 255; i++) {
      const y = curveAt(pts, i);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(192);
    }
    expect(curveAt(pts, 128)).toBeCloseTo(0, 5);
  });

  it("x 超出首尾钳到端点段", () => {
    const pts: [number, number][] = [[0, 0], [128, 128], [255, 255]];
    expect(curveAt(pts, -20)).toBeCloseTo(0, 5);
    expect(curveAt(pts, 300)).toBeCloseTo(255, 5);
  });
});
