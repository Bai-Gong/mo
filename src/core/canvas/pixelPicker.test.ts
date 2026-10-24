/**
 * 取色测试：吸管的像素语义（格点、边界、缓冲不符）不许猜值。
 */
import { describe, expect, it } from "vitest";
import { hexColor, pickPixel, rgbString, type Rgba } from "./pixelPicker";

/** 2×2 测试缓冲：四角红/绿/蓝/半透明白。 */
const W = 2;
const H = 2;
const DATA = new Uint8ClampedArray([
  255, 0, 0, 255, // (0,0) 红
  0, 255, 0, 255, // (1,0) 绿
  0, 0, 255, 255, // (0,1) 蓝
  255, 255, 255, 128, // (1,1) 半透明白
]);

describe("pickPixel", () => {
  it("四个格点取到对应颜色", () => {
    expect(pickPixel(DATA, W, H, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(pickPixel(DATA, W, H, 1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(pickPixel(DATA, W, H, 0, 1)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(pickPixel(DATA, W, H, 1, 1)).toEqual({ r: 255, g: 255, b: 255, a: 128 });
  });

  it("越界与负坐标返回 null（不猜值）", () => {
    expect(pickPixel(DATA, W, H, 2, 0)).toBeNull();
    expect(pickPixel(DATA, W, H, 0, 2)).toBeNull();
    expect(pickPixel(DATA, W, H, -1, 0)).toBeNull();
  });

  it("非整数坐标返回 null（像素索引必须格点对齐）", () => {
    expect(pickPixel(DATA, W, H, 0.5, 0)).toBeNull();
    expect(pickPixel(DATA, W, H, Number.NaN, 0)).toBeNull();
  });

  it("缓冲长度不符返回 null（截断数据不半取）", () => {
    const short = new Uint8ClampedArray(7);
    expect(pickPixel(short, W, H, 1, 1)).toBeNull();
  });
});

describe("颜色格式化", () => {
  it("hex 大写两位补零", () => {
    expect(hexColor({ r: 0, g: 128, b: 255, a: 255 } as Rgba)).toBe("#0080FF");
  });

  it("不透明 rgb()，带 alpha rgba()", () => {
    expect(rgbString({ r: 10, g: 20, b: 30, a: 255 })).toBe("rgb(10, 20, 30)");
    expect(rgbString({ r: 255, g: 255, b: 255, a: 128 })).toBe("rgba(255, 255, 255, 0.50)");
  });
});
