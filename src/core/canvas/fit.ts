/**
 * 画布视口数学：M1「缩放/平移/适合窗口」的纯逻辑核心。
 *
 * 缩放以 1 = 100% 计。上下限是本工具约定（参照 Photoshop 惯例量级：
 * 下限 1% 保证超大图也能全图入窗，上限 3200% 覆盖像素级检视——
 * M1 准入要求「放大到像素级」）。
 */
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 32;

/** 缩放值钳制：非法值（NaN/Infinity）回退 1，越界收拢到 [MIN_ZOOM, MAX_ZOOM]。 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * 适合窗口（contain）：图像等比完整可见时的最大缩放。
 * 以短边比为准——宽比与高比取小者，另一维居中留边。
 * 图像或视口任一维非正（零尺寸/未布局）时回退 1，不产生 Infinity/NaN。
 */
export function fitScale(
  viewport: { width: number; height: number },
  image: { width: number; height: number },
): number {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return 1;
  }
  return clampZoom(
    Math.min(viewport.width / image.width, viewport.height / image.height),
  );
}
