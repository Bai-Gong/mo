/**
 * 画布视口：单个活动文档的渲染与交互（M1 核心 + M2 选区 + M3 绘制/裁剪）。
 *
 * 渲染：合成像素（Rust get_pixels，图层栈合成结果）putImageData 到离屏
 * canvas（按 doc+compositeVersion 缓存），视口 canvas 每帧 drawImage 缩放绘制——
 * zoom≥1 关平滑（像素级检视见格点），zoom<1 开平滑。选区（已提交 + 拖拽中）以
 * 白实线+黑虚线双描显示；画笔/橡皮拖拽中以同宽圆头折线做视觉预览（像素事实
 * 在松手提交 Rust 后生成）；裁剪拖框外压暗、框内保持。
 * 交互：滚轮以光标为锚缩放；抓手/空格/中键平移；吸管取色；矩形/椭圆选框拖拽、
 * 套索自由圈选（松手提交 Rust 栅格化；拖拽过小/不足 3 点按点击取消选区）；
 * 画笔/橡皮拖拽采点（松手一笔提交 paint_stroke，一笔一条历史）；裁剪拖框
 * （松手提交整栈裁剪）。
 */
import { useEffect, useRef, useState } from "react";
import {
  useDocsStore,
  selectActiveDoc,
  selectActiveView,
  selectActiveSelection,
} from "../../core/document/store";
import { getPixels } from "../../core/document/pixelStore";
import { pickPixel } from "../../core/canvas/pixelPicker";
import { insideImage, screenToImage } from "../../core/canvas/coords";
import {
  closeLasso,
  ellipseFromDrag,
  isTinyShape,
  rectFromDrag,
  type SelectionShape,
} from "../../core/canvas/selection";
import { commitSelection, cropDoc, deselect, paintStroke } from "../../core/document/layerPipeline";
import type { Viewport } from "../../core/document/types";

/** docId → 离屏源画布 + 其合成版本（putImageData 一次，版本变才重建）。 */
const sources = new Map<number, { version: number; canvas: HTMLCanvasElement }>();

function sourceOf(
  id: number,
  version: number,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const cached = sources.get(id);
  if (cached && cached.version === version) return cached.canvas;
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
  sources.set(id, { version, canvas });
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

/** 图像坐标形状 → 屏幕坐标轮廓（白实线 + 黑虚线双描，静态蚂蚁线观感）。 */
function strokeShape(
  ctx: CanvasRenderingContext2D,
  shape: SelectionShape,
  view: Viewport,
): void {
  const toX = (x: number) => view.panX + x * view.zoom;
  const toY = (y: number) => view.panY + y * view.zoom;
  ctx.beginPath();
  if (shape.kind === "rect") {
    ctx.rect(toX(shape.x), toY(shape.y), shape.w * view.zoom, shape.h * view.zoom);
  } else if (shape.kind === "ellipse") {
    ctx.ellipse(
      toX(shape.cx),
      toY(shape.cy),
      Math.max(shape.rx * view.zoom, 0.5),
      Math.max(shape.ry * view.zoom, 0.5),
      0,
      0,
      Math.PI * 2,
    );
  } else {
    shape.points.forEach(([x, y], i) =>
      i === 0 ? ctx.moveTo(toX(x), toY(y)) : ctx.lineTo(toX(x), toY(y)),
    );
    ctx.closePath();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** 选区拖拽会话（图像坐标）。marquee 为对角两点；lasso 为已采顶点列。 */
interface MarqueeDraft {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** 画笔/橡皮拖拽会话（图像坐标折线；erase 标记橡皮）。 */
interface StrokeDraft {
  points: [number, number][];
  erase: boolean;
}

/** 前景色（画笔/填充共用）：吸管最近取到的颜色，未取过用黑。 */
function foregroundColor(): [number, number, number, number] {
  const picked = useDocsStore.getState().pickedColor;
  return picked ? [picked.r, picked.g, picked.b, picked.a] : [0, 0, 0, 255];
}

function rgbaCss(c: [number, number, number, number], alpha = 1): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255) * alpha})`;
}

export function CanvasView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doc = useDocsStore(selectActiveDoc);
  const view = useDocsStore(selectActiveView);
  const tool = useDocsStore((s) => s.tool);
  const viewportSize = useDocsStore((s) => s.viewportSize);
  const compositeVersion = useDocsStore((s) =>
    s.activeId === null ? 0 : (s.compositeVersion[s.activeId] ?? 0),
  );
  const selectionEcho = useDocsStore(selectActiveSelection);

  // 选区工具的拖拽会话（图像坐标）
  const [marqueeDraft, setMarqueeDraft] = useState<MarqueeDraft | null>(null);
  const [lassoDraft, setLassoDraft] = useState<[number, number][] | null>(null);
  // 画笔/橡皮与裁剪的拖拽会话（图像坐标）
  const [strokeDraft, setStrokeDraft] = useState<StrokeDraft | null>(null);
  const [cropDraft, setCropDraft] = useState<MarqueeDraft | null>(null);
  const brushSize = useDocsStore((s) => s.brushSize);
  const selecting = marqueeDraft !== null || lassoDraft !== null;

  // 按住空格 → 临时抓手（Photoshop 惯例）；Esc → 取消进行中的拖拽会话
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
      if (e.code === "Escape") {
        setMarqueeDraft(null);
        setLassoDraft(null);
        setStrokeDraft(null);
        setCropDraft(null);
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

  // 活动文档或尺寸到位后补「适合窗口」（幂等；裁剪改尺寸后 views 置 null 重适配）
  useEffect(() => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId !== null) useDocsStore.getState().ensureView(activeId);
  }, [doc?.id, doc?.width, doc?.height, viewportSize]);

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

    const src = sourceOf(doc.id, compositeVersion, doc.width, doc.height);
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

    // 选区轮廓：已提交回显 + 拖拽中的预览
    if (selectionEcho) strokeShape(ctx, selectionEcho, view);
    if (marqueeDraft) {
      const shape =
        tool === "marquee-ellipse"
          ? ellipseFromDrag(marqueeDraft.ax, marqueeDraft.ay, marqueeDraft.bx, marqueeDraft.by)
          : rectFromDrag(marqueeDraft.ax, marqueeDraft.ay, marqueeDraft.bx, marqueeDraft.by);
      strokeShape(ctx, shape, view);
    }
    if (lassoDraft && lassoDraft.length > 1) {
      strokeShape(ctx, { kind: "lasso", points: lassoDraft }, view);
    }

    // 画笔/橡皮拖拽预览：同宽圆头折线（视觉近似；像素事实由 Rust 松手后生成）
    if (strokeDraft && strokeDraft.points.length > 0) {
      const color = strokeDraft.erase
        ? ([255, 255, 255, 160] as [number, number, number, number])
        : (() => {
            const c = foregroundColor();
            return [c[0], c[1], c[2], Math.max(c[3], 40)] as [number, number, number, number];
          })();
      const toX = (x: number) => view.panX + x * view.zoom;
      const toY = (y: number) => view.panY + y * view.zoom;
      ctx.save();
      ctx.strokeStyle = rgbaCss(color);
      ctx.fillStyle = rgbaCss(color);
      ctx.lineWidth = Math.max(brushSize * view.zoom, 1);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = strokeDraft.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(toX(pts[0][0]), toY(pts[0][1]), Math.max((brushSize * view.zoom) / 2, 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(toX(x), toY(y)) : ctx.lineTo(toX(x), toY(y))));
        ctx.stroke();
      }
      ctx.restore();
    }

    // 裁剪拖框预览：框外压暗（evenodd 挖洞）+ 框线双描
    if (cropDraft) {
      const shape = rectFromDrag(cropDraft.ax, cropDraft.ay, cropDraft.bx, cropDraft.by);
      const cx = view.panX + shape.x * view.zoom;
      const cy = view.panY + shape.y * view.zoom;
      const cw = shape.w * view.zoom;
      const ch = shape.h * view.zoom;
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.rect(cx, cy, cw, ch);
      ctx.fill("evenodd");
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.setLineDash([]);
      ctx.strokeRect(cx - 0.5, cy - 0.5, cw + 1, ch + 1);
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(cx - 0.5, cy - 0.5, cw + 1, ch + 1);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }, [doc, view, viewportSize, compositeVersion, selectionEcho, marqueeDraft, lassoDraft, tool, strokeDraft, cropDraft, brushSize]);

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

  // —— 指针交互：平移拖拽 / 坐标回报 / 吸管取色 / 选区圈选 ——

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

  /** 屏幕坐标 → 图像坐标（选区几何用，不取整）。 */
  const toImagePos = (px: number, py: number): { x: number; y: number } | null => {
    const view = selectActiveView(useDocsStore.getState());
    if (!view) return null;
    return screenToImage(px, py, view);
  };

  const reportError = (err: unknown) => {
    useDocsStore.getState().setMessage({
      kind: "error",
      text: err instanceof Error ? err.message : String(err),
    });
  };

  /** 提交选区（形状过小按「点击取消选区」处理——Photoshop 惯例）。 */
  const commitMarquee = (draft: MarqueeDraft) => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId === null) return;
    const shape =
      tool === "marquee-ellipse"
        ? ellipseFromDrag(draft.ax, draft.ay, draft.bx, draft.by)
        : rectFromDrag(draft.ax, draft.ay, draft.bx, draft.by);
    if (isTinyShape(shape)) {
      deselect(activeId).catch(reportError);
    } else {
      commitSelection(activeId, shape).catch(reportError);
    }
  };

  const commitLasso = (points: [number, number][]) => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId === null) return;
    const shape = closeLasso(points);
    if (shape === null) {
      deselect(activeId).catch(reportError);
    } else {
      commitSelection(activeId, shape).catch(reportError);
    }
  };

  /** 提交笔画：一笔 = 一条历史（paint_stroke 落活动图层，受选区约束）。 */
  const commitStroke = (draft: StrokeDraft) => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId === null || draft.points.length === 0) return;
    const size = useDocsStore.getState().brushSize;
    paintStroke(activeId, {
      points: draft.points,
      radius: size / 2, // 前端「大小」为直径（Photoshop 惯例），Rust 收半径
      color: foregroundColor(),
      erase: draft.erase,
    }).catch(reportError);
  };

  /** 提交裁剪：拖框过小按取消处理（不误裁）。 */
  const commitCrop = (draft: MarqueeDraft) => {
    const activeId = useDocsStore.getState().activeId;
    if (activeId === null) return;
    const shape = rectFromDrag(draft.ax, draft.ay, draft.bx, draft.by);
    if (isTinyShape(shape)) return;
    cropDoc(activeId, { x: shape.x, y: shape.y, w: shape.w, h: shape.h }).catch(reportError);
  };

  const panning = tool === "hand" || spaceHeld;
  const isSelectTool = tool === "marquee-rect" || tool === "marquee-ellipse" || tool === "lasso";
  const isPaintTool = tool === "brush" || tool === "eraser";
  const cursorStyle = dragRef.current
    ? "grabbing"
    : panning
      ? "grab"
      : isSelectTool || isPaintTool || tool === "crop" || tool === "eyedropper"
        ? "crosshair"
        : "default";

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
          } else if (e.button === 0 && isSelectTool) {
            const pt = toImagePos(px, py);
            if (!pt) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            if (tool === "lasso") {
              setLassoDraft([[pt.x, pt.y]]);
            } else {
              setMarqueeDraft({ ax: pt.x, ay: pt.y, bx: pt.x, by: pt.y });
            }
          } else if (e.button === 0 && isPaintTool) {
            const pt = toImagePos(px, py);
            if (!pt) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setStrokeDraft({ points: [[pt.x, pt.y]], erase: tool === "eraser" });
          } else if (e.button === 0 && tool === "crop") {
            const pt = toImagePos(px, py);
            if (!pt) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setCropDraft({ ax: pt.x, ay: pt.y, bx: pt.x, by: pt.y });
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
          if (selecting) {
            // 选区拖拽中：更新草稿几何（套索按屏幕 2px 距离采点，避免顶点爆炸）
            const pt = toImagePos(px, py);
            if (!pt) return;
            if (marqueeDraft) {
              setMarqueeDraft({ ...marqueeDraft, bx: pt.x, by: pt.y });
            } else if (lassoDraft) {
              const last = lassoDraft[lassoDraft.length - 1];
              const view = selectActiveView(useDocsStore.getState());
              if (!view) return;
              const dxScreen = (pt.x - last[0]) * view.zoom;
              const dyScreen = (pt.y - last[1]) * view.zoom;
              if (dxScreen * dxScreen + dyScreen * dyScreen >= 4) {
                setLassoDraft([...lassoDraft, [pt.x, pt.y]]);
              }
            }
            return;
          }
          if (strokeDraft) {
            // 笔画拖拽中：按屏幕 1.5px 距离采点（预览平滑 + 顶点数可控）
            const pt = toImagePos(px, py);
            if (!pt) return;
            const last = strokeDraft.points[strokeDraft.points.length - 1];
            const view = selectActiveView(useDocsStore.getState());
            if (!view) return;
            const dxScreen = (pt.x - last[0]) * view.zoom;
            const dyScreen = (pt.y - last[1]) * view.zoom;
            if (dxScreen * dxScreen + dyScreen * dyScreen >= 2.25) {
              setStrokeDraft({ ...strokeDraft, points: [...strokeDraft.points, [pt.x, pt.y]] });
            }
            return;
          }
          if (cropDraft) {
            const pt = toImagePos(px, py);
            if (!pt) return;
            setCropDraft({ ...cropDraft, bx: pt.x, by: pt.y });
            return;
          }
          const { point, color } = probe(px, py);
          useDocsStore.getState().setCursor(point, color);
        }}
        onPointerUp={(e) => {
          if (dragRef.current) {
            dragRef.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            return;
          }
          if (marqueeDraft) {
            const draft = marqueeDraft;
            setMarqueeDraft(null);
            e.currentTarget.releasePointerCapture(e.pointerId);
            commitMarquee(draft);
          } else if (lassoDraft) {
            const draft = lassoDraft;
            setLassoDraft(null);
            e.currentTarget.releasePointerCapture(e.pointerId);
            commitLasso(draft);
          } else if (strokeDraft) {
            const draft = strokeDraft;
            setStrokeDraft(null);
            e.currentTarget.releasePointerCapture(e.pointerId);
            commitStroke(draft);
          } else if (cropDraft) {
            const draft = cropDraft;
            setCropDraft(null);
            e.currentTarget.releasePointerCapture(e.pointerId);
            commitCrop(draft);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setMarqueeDraft(null);
          setLassoDraft(null);
          setStrokeDraft(null);
          setCropDraft(null);
        }}
        onPointerLeave={() => {
          useDocsStore.getState().setCursor(null, null);
        }}
      />
    </div>
  );
}
