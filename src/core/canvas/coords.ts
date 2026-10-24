/**
 * 视口坐标数学：屏幕（画布视口像素）↔ 图像（像素坐标）换算与缩放/平移。
 *
 * 约定（与 document/types.ts 的 Viewport 对应）：
 * - 屏幕点 p → 图像点 i：`i = (p - pan) / zoom`；
 * - zoom 以 1 = 100% 计，钳制见 fit.ts；
 * - 像素级取色用整数像素索引（调用侧 floor），本层保留浮点精度。
 */
import type { Viewport } from "../document/types";
import { clampZoom, fitScale } from "./fit";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 屏幕 → 图像坐标（浮点）。 */
export function screenToImage(px: number, py: number, view: Viewport): Point {
  return { x: (px - view.panX) / view.zoom, y: (py - view.panY) / view.zoom };
}

/** 图像 → 屏幕坐标。 */
export function imageToScreen(ix: number, iy: number, view: Viewport): Point {
  return { x: ix * view.zoom + view.panX, y: iy * view.zoom + view.panY };
}

/**
 * 以屏幕点 (cx, cy) 为锚缩放：锚点下的图像内容缩放前后不动。
 * 锚点不变式：screenToImage(cx, cy) 在缩放前后相等（测试锁定）。
 */
export function zoomAround(view: Viewport, factor: number, cx: number, cy: number): Viewport {
  const zoom = clampZoom(view.zoom * factor);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    panX: cx - (cx - view.panX) * ratio,
    panY: cy - (cy - view.panY) * ratio,
  };
}

/** 平移（屏幕像素位移，随拖拽方向）。 */
export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy };
}

/** 适合窗口（contain）：等比完整可见的最大缩放，居中放置（另一维留边）。 */
export function fitViewport(viewport: Size, image: Size): Viewport {
  const zoom = fitScale(viewport, image);
  return {
    zoom,
    panX: (viewport.width - image.width * zoom) / 2,
    panY: (viewport.height - image.height * zoom) / 2,
  };
}

/** 实际像素（100%）：zoom=1 居中。 */
export function actualSizeViewport(viewport: Size, image: Size): Viewport {
  return {
    zoom: 1,
    panX: (viewport.width - image.width) / 2,
    panY: (viewport.height - image.height) / 2,
  };
}

/** 坐标是否落在图像像素网格内（左上原点，右/下开区间）。 */
export function insideImage(x: number, y: number, image: Size): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}
