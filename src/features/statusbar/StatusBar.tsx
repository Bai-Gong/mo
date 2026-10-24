/**
 * 状态栏（产品分析「状态栏实时显示缩放比与光标坐标」）：像素信息的常驻出口。
 * 左：缩放控制（−/读数/+、适合窗口、实际像素）；中：光标坐标与文档尺寸；
 * 右：颜色（吸管选中优先，其次悬停预览）与 ICC 提示。
 */
import { Maximize2, Minus, Plus, Scan } from "lucide-react";
import { selectActiveDoc, useDocsStore } from "../../core/document/store";
import { hexColor, rgbString } from "../../core/canvas/pixelPicker";
import { MAX_ZOOM, MIN_ZOOM } from "../../core/canvas/fit";

const ZOOM_STEP = Math.sqrt(2);

export function StatusBar() {
  const doc = useDocsStore(selectActiveDoc);
  const view = useDocsStore((s) => (s.activeId === null ? undefined : (s.views[s.activeId] ?? undefined)));
  const cursor = useDocsStore((s) => s.cursor);
  const picked = useDocsStore((s) => s.pickedColor);
  const hover = useDocsStore((s) => s.hoverColor);
  const setZoom = useDocsStore((s) => s.setZoom);
  const fitActive = useDocsStore((s) => s.fitActive);
  const actualSizeActive = useDocsStore((s) => s.actualSizeActive);

  const zoomPct = view ? Math.round(view.zoom * 100) : null;
  const color = picked ?? hover;

  return (
    <footer className="mo-statusbar">
      <div className="mo-statusbar__group" role="group" aria-label="缩放">
        <button
          type="button"
          className="mo-statusbar__btn"
          disabled={!view || (view.zoom ?? 1) <= MIN_ZOOM}
          onClick={() => setZoom((view?.zoom ?? 1) / ZOOM_STEP)}
          title={`缩小（Ctrl+-，下限 ${MIN_ZOOM * 100}%）`}
          aria-label="缩小"
        >
          <Minus size={12} aria-hidden />
        </button>
        <span className="mo-statusbar__zoom" title="当前缩放比">
          {zoomPct === null ? "—" : `${zoomPct}%`}
        </span>
        <button
          type="button"
          className="mo-statusbar__btn"
          disabled={!view || (view.zoom ?? 1) >= MAX_ZOOM}
          onClick={() => setZoom((view?.zoom ?? 1) * ZOOM_STEP)}
          title={`放大（Ctrl+=，上限 ${MAX_ZOOM * 100}%，像素级检视）`}
          aria-label="放大"
        >
          <Plus size={12} aria-hidden />
        </button>
        <button type="button" className="mo-statusbar__btn" disabled={!doc} onClick={fitActive} title="适合窗口（Ctrl+0）">
          <Maximize2 size={12} aria-hidden />
        </button>
        <button type="button" className="mo-statusbar__btn" disabled={!doc} onClick={actualSizeActive} title="实际像素 100%（Ctrl+1）">
          <Scan size={12} aria-hidden />
        </button>
      </div>

      <div className="mo-statusbar__group mo-statusbar__group--mono" aria-label="像素信息">
        <span title="光标所在图像坐标">
          坐标 {cursor ? `${cursor.x}, ${cursor.y}` : "—, —"}
        </span>
        <span title="文档像素尺寸">
          尺寸 {doc ? `${doc.width} × ${doc.height} px` : "—"}
        </span>
      </div>

      <div className="mo-statusbar__group mo-statusbar__group--right">
        {doc?.hasIcc && (
          <span className="mo-statusbar__icc" title="文件携带 ICC 色彩配置：M1 按 sRGB 显示原样像素，另存时原样写回">
            ICC
          </span>
        )}
        <span className="mo-statusbar__color" title={color ? rgbString(color) : "吸管取色（I 切吸管后点击画布）"}>
          <span
            className="mo-statusbar__swatch"
            style={color ? { backgroundColor: rgbString(color) } : undefined}
            aria-hidden
          />
          <span className="mo-statusbar__hex">{color ? hexColor(color) : "#——————"}</span>
        </span>
      </div>
    </footer>
  );
}
