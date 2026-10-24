/**
 * 像素取色：从 RGBA8 缓冲按整数坐标取色 + 颜色格式化（吸管/状态栏用）。
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 取 (x, y) 像素。越界（图像外/未按格点取整/缓冲长度不符）返回 null——
 * 状态栏把 null 显示为「—」，不猜值。
 */
export function pickPixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): Rgba | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * 4;
  if (i + 4 > data.length) return null;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

/** #RRGGBB（大写；吸管结果的可复制表示）。 */
export function hexColor(c: Rgba): string {
  const h = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** css 颜色串：不透明 rgb()，带 alpha rgba()。 */
export function rgbString(c: Rgba): string {
  return c.a === 255
    ? `rgb(${c.r}, ${c.g}, ${c.b})`
    : `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(2)})`;
}
