/**
 * 画布视口：单个活动文档的渲染与交互（M1 核心）。
 *
 * 渲染：RGBA8 像素一次性 putImageData 到离屏 canvas（按 doc 缓存），视口 canvas
 * 每帧 drawImage 缩放绘制——zoom≥1 关平滑（像素级检视见格点），zoom<1 开平滑。
 * 交互：滚轮以光标为锚缩放；抓手工具/按住空格/中键拖拽平移；吸管点击取色；
 * 光标移动实时回报图像坐标与悬停色（状态栏消费）。
 */
import { useEffect, useRef, useState } from "react";
import { useDocsStore, selectActiveDoc, selectActiveView } from "../../core/document/store";
import { getPixels } from "../../core/document/pixelStore";
import { pickPixel } from "../../core/canvas/pixelPicker";
import { insideImage, screenToImage } from "../../core/canvas/coords";

/** docId → 离屏源画布（putImageData 一次，缩放绘制走 drawImage）。 */
const sources = new Map<number, HTMLCanvasElement>();

function sourceOf(id: number, width: number, height: number): HTMLCanvasElement | null {
  const cached = sources.get(id);
  if (cached) return cached;
  const data = getPixels(id);
  if (!data) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // createImageData + set 而非 new ImageData(data)：TS 的 ArrayBufferLike 泛型
  // 与 DOM ImageDataArray 不兼容，此路径无需断言且语义相同。
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  sources.set(id, canvas);
  return canvas;
}

/** 透明度棋盘格图案（PNG alpha 可见性）。两色取自坊 token，保持视觉一致。 */
let checkerPattern: CanvasPattern | null = null;
function getCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (checkerPattern) return checkerPattern;
  const tile = document.createElement("canvas");
  tile.width = 16;
  tile.height = 16;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const styles = getComputedStyle(document.documentElement);
  const light = styles.getPropertyValue("--fang-color-bg-overlay").trim() || "#2e3136";
  const dark = styles.getPropertyValue("--fang-color-bg").trim() || "#1e1f22";
  tctx.fillStyle = light;
  tctx.fillRect(0, 0, 16, 16);
  tctx.fillStyle = dark;
  tctx.fillRect(0, 0, 8, 8);
  tctx.fillRect(8, 8, 8, 8);
  checkerPattern = ctx.createPattern(tile, "repeat");
  return checkerPattern;
}

export function CanvasView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doc = useDocsStore(selectActiveDoc);
  const view = useDocsStore(selectActiveView);
  const tool = useDocsStore((s) => s.tool);
  const viewportSize = useDocsStore((s) => s.viewportSize);

  // 按住空格 → 临时抓手（Photoshop 惯例）
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // 视口尺寸回传（ResizeObserver）——fit/居中的依据
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth > 0 && clientHeight > 0) {
        useDocsStore.getState().setViewportSize({ width: clientWidth, height: clientHeight });
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 活动文档或尺寸到位后补「适合窗口」（幂等）
  useEffect(() => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId !== null) useDocsStore.getState().ensureView(activeId);
  }, [doc?.id, viewportSize]);

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const cssWidth = container.clientWidth;
    const cssHeight = container.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const backingW = Math.round(cssWidth * dpr);
    const backingH = Math.round(cssHeight * dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (!doc || !view) return;

    // 已关闭文档的源画布回收（防内存累积）
    const liveIds = new Set(useDocsStore.getState().docs.map((d) => d.id));
    for (const id of sources.keys()) {
      if (!liveIds.has(id)) sources.delete(id);
    }

    const src = sourceOf(doc.id, doc.width, doc.height);
    if (!src) return;
    const sx = view.panX;
    const sy = view.panY;
    const sw = doc.width * view.zoom;
    const sh = doc.height * view.zoom;

    // 图像区域：透明棋盘格底 → 像素 → 描边
    const pattern = getCheckerPattern(ctx);
    if (pattern) {
      ctx.save();
      ctx.fillStyle = pattern;
      ctx.fillRect(sx, sy, sw, sh);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = view.zoom < 1; // ≥100% 见像素格点（像素级检视）
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, sx, sy, sw, sh);
    ctx.strokeStyle = getComputedStyle(container).getPropertyValue("--fang-color-border-strong").trim() || "#4a4e55";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 0.5, sy - 0.5, sw + 1, sh + 1);
  }, [doc, view, viewportSize]);

  // 滚轮缩放（以光标为锚；非被动监听才能 preventDefault）
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // 指数因子：触控板小步平滑、滚轮大步跨档；单事件钳到 [1/1.6, 1.6] 防飞跳
      const factor = Math.min(1.6, Math.max(1 / 1.6, Math.exp(-e.deltaY * 0.0018)));
      useDocsStore.getState().zoomAt(px, py, factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // —— 指针交互：平移拖拽 / 坐标回报 / 吸管取色 ——
  const dragRef = useRef<{ lastX: number; lastY: number } | null>(null);

  /** 屏幕（容器）坐标 → 图像格点 + 悬停色；图像外 → null/null。 */
  const probe = (px: number, py: number) => {
    const store = useDocsStore.getState();
    const activeDoc = selectActiveDoc(store);
    const activeView = selectActiveView(store);
    if (!activeDoc || !activeView) return { point: null, color: null };
    const pt = screenToImage(px, py, activeView);
    if (!insideImage(pt.x, pt.y, activeDoc)) return { point: null, color: null };
    const data = getPixels(activeDoc.id);
    if (!data) return { point: null, color: null };
    const ix = Math.floor(pt.x);
    const iy = Math.floor(pt.y);
    return { point: { x: ix, y: iy }, color: pickPixel(data, activeDoc.width, activeDoc.height, ix, iy) };
  };

  const localPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  const panning = tool === "hand" || spaceHeld;
  const cursorStyle = dragRef.current ? "grabbing" : panning ? "grab" : tool === "eyedropper" ? "crosshair" : "default";

  return (
    <div ref={containerRef} className="mo-canvas-container">
      <canvas
        ref={canvasRef}
        className="mo-canvas"
        style={{ cursor: cursorStyle }}
        onPointerDown={(e) => {
          const { px, py } = localPos(e);
          if (panning || e.button === 1) {
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { lastX: e.clientX, lastY: e.clientY };
          } else if (e.button === 0 && tool === "eyedropper") {
            const { color } = probe(px, py);
            if (color) useDocsStore.getState().pickColor(color);
          }
        }}
        onPointerMove={(e) => {
          if (dragRef.current) {
            const dx = e.clientX - dragRef.current.lastX;
            const dy = e.clientY - dragRef.current.lastY;
            dragRef.current = { lastX: e.clientX, lastY: e.clientY };
            useDocsStore.getState().panBy(dx, dy);
            return; // 平移中不更新取色（像素在动，等停手再回填）
          }
          const { px, py } = localPos(e);
          const { point, color } = probe(px, py);
          useDocsStore.getState().setCursor(point, color);
        }}
        onPointerUp={(e) => {
          if (dragRef.current) {
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          useDocsStore.getState().setCursor(null, null);
        }}
      />
    </div>
  );
}
