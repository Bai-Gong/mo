/**
 * 坐标数学测试：M1 准入「放大到像素级」的视口语义不许漂移。
 * 上下限与 contain 拟合的边界在 fit.test.ts，这里管换算/锚点/平移不变式。
 */
import { describe, expect, it } from "vitest";
import {
  actualSizeViewport,
  fitViewport,
  imageToScreen,
  insideImage,
  panBy,
  screenToImage,
  zoomAround,
} from "./coords";
import { MAX_ZOOM } from "./fit";

describe("screenToImage / imageToScreen", () => {
  const view = { zoom: 2, panX: 100, panY: 50 };

  it("互为逆变换", () => {
    const p = screenToImage(140, 90, view);
    expect(p).toEqual({ x: 20, y: 20 });
    expect(imageToScreen(p.x, p.y, view)).toEqual({ x: 140, y: 90 });
  });

  it("像素级放大（3200%）下图像像素边界对齐屏幕格点", () => {
    const pixelView = { zoom: MAX_ZOOM, panX: 0, panY: 0 };
    // 一个图像像素占 32 个屏幕像素：屏幕 10 与 11 同属图像像素 0，
    // 跨过边界（10 → 42）才进入下一个图像像素
    const a = screenToImage(10, 10, pixelView);
    const b = screenToImage(11, 10, pixelView);
    expect(Math.floor(a.x)).toBe(Math.floor(b.x));
    expect(b.x - a.x).toBeCloseTo(1 / MAX_ZOOM, 10);
    expect(Math.floor(screenToImage(42, 10, pixelView).x)).toBe(1);
  });

  it("缩放 <1 时多个图像像素叠在一个屏幕像素上", () => {
    const tiny = { zoom: 0.25, panX: 0, panY: 0 };
    expect(screenToImage(10, 0, tiny).x).toBe(40);
  });
});

describe("zoomAround（滚轮缩放）", () => {
  const view = { zoom: 1, panX: 20, panY: 10 };

  it("锚点下的图像内容不动（不变式）", () => {
    const cx = 300;
    const cy = 200;
    const before = screenToImage(cx, cy, view);
    const next = zoomAround(view, 4, cx, cy);
    const after = screenToImage(cx, cy, next);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(next.zoom).toBe(4);
  });

  it("连乘到上限即钳制，不产生 Infinity", () => {
    let v = view;
    for (let i = 0; i < 20; i++) v = zoomAround(v, 2, 0, 0);
    expect(v.zoom).toBe(MAX_ZOOM);
  });

  it("反向缩放过小钳到下限，锚点不变式仍成立", () => {
    const next = zoomAround({ zoom: 0.05, panX: 0, panY: 0 }, 0.1, 5, 5);
    expect(next.zoom).toBeGreaterThan(0);
    const a = screenToImage(5, 5, { zoom: 0.05, panX: 0, panY: 0 });
    const b = screenToImage(5, 5, next);
    expect(b.x).toBeCloseTo(a.x, 9);
  });
});

describe("panBy / fitViewport / actualSizeViewport", () => {
  it("平移只动 pan 不动 zoom", () => {
    const next = panBy({ zoom: 3, panX: 1, panY: 2 }, -10, 20);
    expect(next).toEqual({ zoom: 3, panX: -9, panY: 22 });
  });

  it("fit 居中：图像完整可见且居中放置", () => {
    const v = fitViewport({ width: 1000, height: 600 }, { width: 200, height: 100 });
    expect(v.zoom).toBe(5); // min(1000/200, 600/100) = min(5, 6)
    expect(v.panX).toBe(0); // (1000 - 200*5) / 2
    expect(v.panY).toBe(50); // (600 - 100*5) / 2
  });

  it("实际像素：zoom=1 且居中", () => {
    const v = actualSizeViewport({ width: 1000, height: 600 }, { width: 200, height: 100 });
    expect(v).toEqual({ zoom: 1, panX: 400, panY: 250 });
  });
});

describe("insideImage", () => {
  const image = { width: 4, height: 3 };
  it("左上原点含 (0,0)，右下开区间", () => {
    expect(insideImage(0, 0, image)).toBe(true);
    expect(insideImage(3, 2, image)).toBe(true);
    expect(insideImage(4, 2, image)).toBe(false);
    expect(insideImage(3, 3, image)).toBe(false);
    expect(insideImage(-1, 1, image)).toBe(false);
  });
});
