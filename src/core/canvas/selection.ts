/**
 * 选区几何（M2）：三种选区形状的纯函数构造器。
 *
 * 形状类型与 Rust `SelectionShape`（src-tauri/src/selection.rs）的 serde 契约
 * 一致：`kind` 标签 + camelCase 字段，坐标为浮点图像像素——半像素边界正是
 * Rust 侧栅格化抗锯齿的来源。套索点列为 [x,y] 二元组数组。
 */

/** 矩形选区：左上角 + 宽高（已归一化，w/h ≥ 0）。 */
export interface RectSel {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 椭圆选区：中心 + 两轴半径。 */
export interface EllipseSel {
  kind: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** 套索选区：多边形顶点（绘制顺序），Rust 侧按 even-odd 规则栅格化。 */
export interface LassoSel {
  kind: "lasso";
  points: [number, number][];
}

export type SelectionShape = RectSel | EllipseSel | LassoSel;

/** 拖拽两点（图像坐标）→ 归一化矩形：任意拖拽方向都得到正宽高的左上原点矩形。 */
export function rectFromDrag(ax: number, ay: number, bx: number, by: number): RectSel {
  return {
    kind: "rect",
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/** 拖拽对角 → 椭圆：拖出的包围盒取中心和半径（等宽高拖拽即正圆）。 */
export function ellipseFromDrag(ax: number, ay: number, bx: number, by: number): EllipseSel {
  const r = rectFromDrag(ax, ay, bx, by);
  return {
    kind: "ellipse",
    cx: r.x + r.w / 2,
    cy: r.y + r.h / 2,
    rx: r.w / 2,
    ry: r.h / 2,
  };
}

/**
 * 套索收口：点列不足 3 点不成面 → null（调用方据此按「点击取消选区」处理）。
 */
export function closeLasso(points: readonly [number, number][]): LassoSel | null {
  if (points.length < 3) return null;
  return { kind: "lasso", points: [...points] };
}

/** 选区形状在图像坐标下是否小到等于「没拖出来」（marquee 点击容忍 2px）。 */
export function isTinyShape(shape: SelectionShape): boolean {
  if (shape.kind === "rect") return shape.w < 2 || shape.h < 2;
  if (shape.kind === "ellipse") return shape.rx < 1 || shape.ry < 1;
  return false; // 套索由 closeLasso 的点数判定
}
