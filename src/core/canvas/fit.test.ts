/**
 * 视口数学测试：M1「适合窗口 / 像素级缩放」的边界不许漂移。
 */
import { describe, expect, it } from "vitest";
import { clampZoom, fitScale, MAX_ZOOM, MIN_ZOOM } from "./fit";

describe("clampZoom", () => {
  it("区间内原样通过", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(8)).toBe(8);
  });

  it("越界收拢到上下限", () => {
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it("非法值回退 1（不产生 NaN/Infinity）", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe("fitScale", () => {
  const wide = { width: 1200, height: 800 };

  it("竖图以高度为瓶颈（宽边留白）", () => {
    // 宽比 1200/600=2，高比 800/3000≈0.267 → 取小者
    expect(fitScale(wide, { width: 600, height: 3000 })).toBeCloseTo(0.2667, 3);
  });

  it("横图以宽度为瓶颈（上下留白）", () => {
    // 宽比 1200/4000=0.3，高比 800/1000=0.8 → 取小者
    expect(fitScale(wide, { width: 4000, height: 1000 })).toBeCloseTo(0.3, 6);
  });

  it("整除时正好 1（无缩放）", () => {
    expect(fitScale(wide, { width: 1200, height: 800 })).toBe(1);
  });

  it("超大图不越过下限 1%", () => {
    // 1200/120000=0.01 恰好触底；再大则钳制
    expect(fitScale(wide, { width: 240000, height: 160000 })).toBe(MIN_ZOOM);
  });

  it("超大缩放不越过上限 3200%（小图进大窗）", () => {
    // 裸比 800/25=32 触顶；更小的图被钳制
    expect(fitScale(wide, { width: 12, height: 8 })).toBe(MAX_ZOOM);
  });

  it("零尺寸/未布局回退 1，不产生 Infinity", () => {
    expect(fitScale(wide, { width: 0, height: 100 })).toBe(1);
    expect(fitScale(wide, { width: 100, height: 0 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
  });
});
