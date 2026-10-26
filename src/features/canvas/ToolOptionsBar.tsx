/**
 * 工具选项栏（产品分析「顶部菜单栏＋随工具动态变化的选项栏」）：
 * 画笔/橡皮下显示笔刷大小（直径 px）与前景色；裁剪显示操作提示；
 * 文字工具（M4）显示字体/字号/前景色——活动层是文字层时直接编辑其内容。
 *
 * 提交纪律（与调整面板同口径）：字体下拉与笔刷滑杆等「一次离散动作」即时
 * 提交；字号/颜色/位置/文本内容为草稿本地编辑，**失焦或回车才提交**——
 * 一次编辑一条「编辑文字」历史，不按击键/拖帧灌历史（M4 评审修复）。
 */
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useDocsStore, selectActiveLayers } from "../../core/document/store";
import { hexColor, rgbString, type Rgba } from "../../core/canvas/pixelPicker";
import { setTextLayer } from "../../core/document/layerPipeline";
import { tauriLayerIo } from "../../core/document/layerIo";
import type { TextSpec } from "../../core/document/types";

const SIZE_MIN = 1;
const SIZE_MAX = 512;
const TEXT_SIZE_MIN = 4;

/** 本机字体族（font_families 一次拉取，会话级缓存；探测失败回退默认族）。 */
let familiesCache: string[] | null = null;

export function ToolOptionsBar() {
  const tool = useDocsStore((s) => s.tool);
  const brushSize = useDocsStore((s) => s.brushSize);
  const setBrushSize = useDocsStore((s) => s.setBrushSize);
  const picked = useDocsStore((s) => s.pickedColor);

  if (tool !== "brush" && tool !== "eraser" && tool !== "crop" && tool !== "text") return null;

  const foreground: Rgba = picked ?? { r: 0, g: 0, b: 0, a: 255 };

  return (
    <div className="mo-tool-options" role="toolbar" aria-label="工具选项">
      {tool !== "crop" && tool !== "text" && (
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
      {tool === "text" && <TextOptions foreground={foreground} />}
    </div>
  );
}

/** 字符串草稿：本地编辑，失焦/回车提交一次（未变不提交）。 */
function useDraftCommit(value: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  const ref = useRef(value);
  useEffect(() => {
    setDraft(value);
    ref.current = value;
  }, [value]);
  const commit = () => {
    if (ref.current === value) return; // 未变不提交
    onCommit(ref.current);
  };
  return {
    draft,
    set: (v: string) => {
      ref.current = v;
      setDraft(v);
    },
    commit,
    /** 数字/文本输入共用的提交句柄（回车 = 失焦提交）。 */
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") e.currentTarget.blur();
    },
  };
}

/** 文字工具选项：无活动文字层时设新文本默认值；有则就地编辑该层内容。 */
function TextOptions({ foreground }: { foreground: Rgba }) {
  const docId = useDocsStore((s) => s.activeId);
  const layers = useDocsStore(selectActiveLayers);
  const activeLayerId = useDocsStore((s) =>
    s.activeId === null ? 0 : (s.activeLayerId[s.activeId] ?? 0),
  );
  const family = useDocsStore((s) => s.textFamily);
  const size = useDocsStore((s) => s.textSize);
  const setTextFamily = useDocsStore((s) => s.setTextFamily);
  const setTextSize = useDocsStore((s) => s.setTextSize);

  const [families, setFamilies] = useState<string[]>(familiesCache ?? ["微软雅黑"]);
  useEffect(() => {
    if (familiesCache) return;
    let alive = true;
    tauriLayerIo
      .fontFamilies()
      .then((list) => {
        if (!alive || list.length === 0) return;
        familiesCache = list;
        setFamilies(list);
        // 默认族取第一个实际存在的（候选表顺序优先 CJK）
        const store = useDocsStore.getState();
        if (!list.includes(store.textFamily)) store.setTextFamily(list[0]);
      })
      .catch(() => {
        /* 探测失败保持默认族；Rust 侧按回退链兜底 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const activeSpec =
    activeLayer && activeLayer.kind.kind === "text" ? activeLayer.kind.spec : null;

  const onError = (err: unknown) => {
    useDocsStore
      .getState()
      .setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
  };

  /** 字体：下拉一次离散动作，即时提交（编辑活动层则改层，否则设默认）。 */
  const onFamily = (value: string) => {
    setTextFamily(value);
    if (docId !== null && activeSpec) {
      void setTextLayer(docId, activeLayerId, { ...activeSpec, family: value }).catch(onError);
    }
  };

  /** 字号：草稿编辑，失焦/回车提交（无活动文字层时只设新文本默认值）。 */
  const sizeField = useDraftCommit(String(activeSpec ? activeSpec.size : size), (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(512, Math.max(TEXT_SIZE_MIN, n));
    if (docId !== null && activeSpec) {
      void setTextLayer(docId, activeLayerId, { ...activeSpec, size: clamped }).catch(onError);
    } else {
      setTextSize(clamped);
    }
  });

  return (
    <>
      <span className="mo-tool-options__label">文字</span>
      <label className="mo-tool-options__field">
        <span>字体</span>
        <select value={family} onChange={(e) => onFamily(e.target.value)}>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="mo-tool-options__field">
        <span>字号</span>
        <input
          type="number"
          min={TEXT_SIZE_MIN}
          max={512}
          step={1}
          value={sizeField.draft}
          onChange={(e) => sizeField.set(e.target.value)}
          onBlur={sizeField.commit}
          onKeyDown={sizeField.onKeyDown}
          title="字号（px；回车或失焦提交）"
        />
      </label>
      {docId !== null && activeSpec ? (
        <ActiveTextEditor docId={docId} layerId={activeLayerId} spec={activeSpec} />
      ) : (
        <>
          <span
            className="mo-tool-options__color"
            title={`新文本颜色 ${hexColor(foreground)}（吸管 I 取色）`}
          >
            <span
              className="mo-tool-options__swatch"
              style={{ backgroundColor: rgbString(foreground) }}
              aria-hidden
            />
            颜色
          </span>
          <span className="mo-tool-options__hint">点击画布放置文本（T），选中文字图层后在此编辑</span>
        </>
      )}
    </>
  );
}

/** 活动文字层的内容编辑器：内容/颜色/位置全为草稿，失焦或回车提交一条历史。 */
function ActiveTextEditor({
  docId,
  layerId,
  spec,
}: {
  docId: number;
  layerId: number;
  spec: TextSpec;
}) {
  const onError = (err: unknown) => {
    useDocsStore
      .getState()
      .setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
  };

  const textField = useDraftCommit(spec.text, (v) => {
    void setTextLayer(docId, layerId, { ...spec, text: v }).catch(onError);
  });

  const colorHex = `#${[spec.color[0], spec.color[1], spec.color[2]]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
  const colorField = useDraftCommit(colorHex, (hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if ([r, g, b].some(Number.isNaN)) return;
    void setTextLayer(docId, layerId, { ...spec, color: [r, g, b, spec.color[3]] }).catch(onError);
  });

  const xField = useDraftCommit(String(Math.round(spec.x)), (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return;
    void setTextLayer(docId, layerId, { ...spec, x: n }).catch(onError);
  });
  const yField = useDraftCommit(String(Math.round(spec.y)), (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return;
    void setTextLayer(docId, layerId, { ...spec, y: n }).catch(onError);
  });

  return (
    <>
      <label className="mo-tool-options__field mo-tool-options__field--grow">
        <span>内容</span>
        <input
          type="text"
          value={textField.draft}
          onChange={(e) => textField.set(e.target.value)}
          onBlur={textField.commit}
          onKeyDown={textField.onKeyDown}
          title="文字内容（回车或点画布外提交一条「编辑文字」历史）"
        />
      </label>
      <label className="mo-tool-options__field">
        <span>颜色</span>
        <input
          type="color"
          value={colorField.draft}
          onChange={(e) => colorField.set(e.target.value)}
          onBlur={colorField.commit}
          title="文字颜色（选好点别处提交）"
        />
      </label>
      <label className="mo-tool-options__field">
        <span>X</span>
        <input
          type="number"
          value={xField.draft}
          onChange={(e) => xField.set(e.target.value)}
          onBlur={xField.commit}
          onKeyDown={xField.onKeyDown}
          title="基线左端点 X（图像坐标；回车或失焦提交）"
        />
      </label>
      <label className="mo-tool-options__field">
        <span>Y</span>
        <input
          type="number"
          value={yField.draft}
          onChange={(e) => yField.set(e.target.value)}
          onBlur={yField.commit}
          onKeyDown={yField.onKeyDown}
          title="基线左端点 Y（图像坐标；回车或失焦提交）"
        />
      </label>
    </>
  );
}
