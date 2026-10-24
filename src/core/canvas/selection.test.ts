/**
 * 选区几何纯函数测试（M2）：拖拽归一化、椭圆包围盒、套索收口。
 * 抗锯齿栅格化本身在 Rust 侧（src-tauri/src/selection.rs 测试），前端只负责
 * 产出与 serde 契约一致的浮点形状。
 */
import { describe, expect, it } from "vitest";
import {
  closeLasso,
  ellipseFromDrag,
  isTinyShape,
  rectFromDrag,
} from "./selection";

describe("rectFromDrag", () => {
  it("右下拖拽：原点即锚点", () => {
    expect(rectFromDrag(10, 20, 30, 50)).toEqual({ kind: "rect", x: 10, y: 20, w: 20, h: 30 });
  });

  it("左上拖拽（反向）：归一化为正宽高 + 左上原点", () => {
    expect(rectFromDrag(30, 50, 10, 20)).toEqual({ kind: "rect", x: 10, y: 20, w: 20, h: 30 });
  });

  it("浮点半像素边界原样保留（抗锯齿的几何来源）", () => {
    expect(rectFromDrag(2.5, 0, 5.5, 3)).toEqual({ kind: "rect", x: 2.5, y: 0, w: 3, h: 3 });
  });

  it("点击（零拖拽）：零尺寸矩形", () => {
    expect(rectFromDrag(4, 4, 4, 4)).toEqual({ kind: "rect", x: 4, y: 4, w: 0, h: 0 });
  });
});

describe("ellipseFromDrag", () => {
  it("对角拖拽 → 包围盒中心与半径", () => {
    expect(ellipseFromDrag(10, 10, 30, 50)).toEqual({
      kind: "ellipse",
      cx: 20,
      cy: 30,
      rx: 10,
      ry: 20,
    });
  });

  it("等宽高拖拽为正圆", () => {
    const e = ellipseFromDrag(0, 0, 20, 20);
    expect(e.rx).toBe(e.ry);
  });

  it("反向拖拽同样归一化", () => {
    expect(ellipseFromDrag(30, 50, 10, 10)).toEqual({
      kind: "ellipse",
      cx: 20,
      cy: 30,
      rx: 10,
      ry: 20,
    });
  });
});

describe("closeLasso", () => {
  it("不足 3 点不成面 → null（调用方按点击取消处理）", () => {
    expect(closeLasso([])).toBeNull();
    expect(closeLasso([[1, 1]])).toBeNull();
    expect(closeLasso([[1, 1], [5, 5]])).toBeNull();
  });

  it("3 点及以上原样收口（顶点顺序保留）", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(closeLasso(pts)).toEqual({ kind: "lasso", points: pts });
  });
});

describe("isTinyShape", () => {
  it("矩形/椭圆拖拽过小视为点击（选区取消）", () => {
    expect(isTinyShape({ kind: "rect", x: 1, y: 1, w: 1.5, h: 30 })).toBe(true);
    expect(isTinyShape({ kind: "rect", x: 1, y: 1, w: 3, h: 3 })).toBe(false);
    expect(isTinyShape({ kind: "ellipse", cx: 5, cy: 5, rx: 0.5, ry: 9 })).toBe(true);
    expect(isTinyShape({ kind: "ellipse", cx: 5, cy: 5, rx: 2, ry: 2 })).toBe(false);
  });

  it("套索不由尺寸判定（点数在 closeLasso 把关）", () => {
    expect(isTinyShape({ kind: "lasso", points: [[0, 0]] })).toBe(false);
  });
});
