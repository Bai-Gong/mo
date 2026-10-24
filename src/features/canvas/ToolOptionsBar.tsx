/**
 * 工具选项栏（产品分析「顶部菜单栏＋随工具动态变化的选项栏」，M3 起步）：
 * 画笔/橡皮下显示笔刷大小（直径 px，画笔/橡皮共用）与前景色；裁剪下显示
 * 操作提示。其余工具暂无选项（颜色面板随 M4 进）。
 */
import { Minus, Plus } from "lucide-react";
import { useDocsStore } from "../../core/document/store";
import { hexColor, rgbString, type Rgba } from "../../core/canvas/pixelPicker";

const SIZE_MIN = 1;
const SIZE_MAX = 512;

export function ToolOptionsBar() {
  const tool = useDocsStore((s) => s.tool);
  const brushSize = useDocsStore((s) => s.brushSize);
  const setBrushSize = useDocsStore((s) => s.setBrushSize);
  const picked = useDocsStore((s) => s.pickedColor);

  if (tool !== "brush" && tool !== "eraser" && tool !== "crop") return null;

  const foreground: Rgba = picked ?? { r: 0, g: 0, b: 0, a: 255 };

  return (
    <div className="mo-tool-options" role="toolbar" aria-label="工具选项">
      {tool !== "crop" && (
        <>
          <span className="mo-tool-options__label">
            {tool === "brush" ? "画笔" : "橡皮"}
          </span>
          <div className="mo-tool-options__size" role="group" aria-label="笔刷大小">
            <button
              type="button"
              className="mo-tool-options__btn"
              disabled={brushSize <= SIZE_MIN}
              onClick={() => setBrushSize(brushSize - Math.max(1, Math.round(brushSize * 0.2)))}
              title={`减小笔刷（当前 ${brushSize}px）`}
              aria-label="减小笔刷"
            >
              <Minus size={12} aria-hidden />
            </button>
            <input
              type="range"
              min={SIZE_MIN}
              max={64}
              step={1}
              value={Math.min(brushSize, 64)}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              title="笔刷大小（直径，像素）"
              aria-label="笔刷大小"
            />
            <button
              type="button"
              className="mo-tool-options__btn"
              disabled={brushSize >= SIZE_MAX}
              onClick={() => setBrushSize(brushSize + Math.max(1, Math.round(brushSize * 0.2)))}
              title={`增大笔刷（当前 ${brushSize}px）`}
              aria-label="增大笔刷"
            >
              <Plus size={12} aria-hidden />
            </button>
            <span className="mo-tool-options__value" title="笔刷大小（直径，像素）">
              {brushSize} px
            </span>
          </div>
          <span
            className="mo-tool-options__color"
            title={`前景色 ${hexColor(foreground)}（吸管 I 取色，画笔与填充共用）`}
          >
            <span
              className="mo-tool-options__swatch"
              style={{ backgroundColor: rgbString(foreground) }}
              aria-hidden
            />
            前景色
          </span>
          <span className="mo-tool-options__hint">一笔一条历史，Ctrl+Z 撤销</span>
        </>
      )}
      {tool === "crop" && (
        <>
          <span className="mo-tool-options__label">裁剪</span>
          <span className="mo-tool-options__hint">在画布拖出裁剪框，松手完成（Esc 取消重拖）</span>
        </>
      )}
    </div>
  );
}
