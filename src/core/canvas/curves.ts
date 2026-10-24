/**
 * 曲线插值（M4 调整面板的显示数学）：与 Rust adjustments.rs `curves_lut`
 * 同口径的 Fritsh–Carlson 单调三次 Hermite 插值。Rust 是像素事实源；本模块
 * 只服务曲线编辑器的**预览绘制**与拖拽取值——两端用同一组手算期望值锁定
 * （curves.test.ts ↔ adjustments.rs 测试），漂移会在任一侧暴露。
 */

/** 点列校验/归一：钳 [0,255]、按 x 升序排序；<2 点或 x 重复返回 null。 */
export function normalizePoints(
  points: [number, number][],
): [number, number][] | null {
  if (points.length < 2) return null;
  const clamped = points.map(
    ([x, y]) =>
      [Math.min(255, Math.max(0, x)), Math.min(255, Math.max(0, y))] as [number, number],
  );
  clamped.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i][0] - clamped[i - 1][0] < 1e-4) return null; // x 重复
  }
  return clamped;
}

/** 段切线（Fritsch–Carlson）：端点取邻段斜率、单调段调和平均、极值点置 0。 */
function tangentsOf(points: [number, number][]): number[] {
  const n = points.length - 1;
  const slope: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = points[i + 1][0] - points[i][0];
    slope.push(dx < 1e-4 ? 0 : (points[i + 1][1] - points[i][1]) / dx);
  }
  const t = new Array<number>(points.length).fill(0);
  t[0] = slope[0];
  t[n] = slope[n - 1];
  for (let i = 1; i < n; i++) {
    t[i] =
      slope[i - 1] * slope[i] <= 0
        ? 0
        : (3 * (slope[i - 1] * slope[i])) / (slope[i - 1] + slope[i]);
  }
  return t;
}

/** 曲线在 x 处的值（0..255；点列须已归一，未归一先走 normalizePoints）。 */
export function curveAt(points: [number, number][], x: number): number {
  if (points.length < 2) return x;
  const n = points.length - 1;
  const tangents = tangentsOf(points);
  let seg = points.findIndex(
    (p, i) => i < n && x >= p[0] && x <= points[i + 1][0],
  );
  if (seg < 0) seg = x < points[0][0] ? 0 : n - 1;
  const [x0, y0] = points[seg];
  const [x1, y1] = points[seg + 1];
  const dx = x1 - x0;
  if (dx < 1e-4) return y0;
  const t = Math.min(1, Math.max(0, (x - x0) / dx));
  const h00 = 2 * t * t * t - 3 * t * t + 1;
  const h10 = t * t * t - 2 * t * t + t;
  const h01 = -2 * t * t * t + 3 * t * t;
  const h11 = t * t * t - t * t;
  const y = h00 * y0 + h10 * dx * tangents[seg] + h01 * y1 + h11 * dx * tangents[seg + 1];
  return Math.min(255, Math.max(0, y));
}
