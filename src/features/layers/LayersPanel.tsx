/**
 * 图层面板（M2，产品分析「右侧停靠面板区」的首块）：列表（上=顶）、可见性、
 * 增删、上下移、活动层的不透明度与混合模式。
 *
 * Rust 是事实源：所有操作走 layerPipeline（成功后快照落 store、合成像素重拉）。
 * 展示顺序与栈序相反——栈自底向上，面板自上而下（Photoshop 惯例）。
 */
import { useEffect } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import {
  selectActiveLayers,
  useDocsStore,
} from "../../core/document/store";
import { BLEND_MODE_LABELS, type BlendModeName, type LayerMeta } from "../../core/document/types";
import {
  activateLayer,
  addLayer,
  deleteLayer,
  moveLayer,
  refreshLayers,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisible,
} from "../../core/document/layerPipeline";

export function LayersPanel() {
  const docId = useDocsStore((s) => s.activeId);
  const layers = useDocsStore(selectActiveLayers);
  const activeLayerId = useDocsStore((s) =>
    s.activeId === null ? 0 : (s.activeLayerId[s.activeId] ?? 0),
  );

  // 标签打开/切换/新建后自动拉一次快照（面板自愈：列表空即拉）
  useEffect(() => {
    if (docId === null) return;
    const s = useDocsStore.getState();
    if ((s.layers[docId] ?? []).length === 0) {
      refreshLayers(docId).catch((err) => {
        useDocsStore.getState().setMessage({
          kind: "error",
          text: `图层列表拉取失败：${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }
  }, [docId, layers.length]);

  if (docId === null) {
    return <p className="mo-layers__empty">打开图像或新建文档后出现图层</p>;
  }

  /** 面板行序 = 栈序倒序（顶在上）。 */
  const rows: LayerMeta[] = [...layers].reverse();
  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const activeIndex = layers.findIndex((l) => l.id === activeLayerId);
  const stackLen = layers.length;

  /** 面板「上移/下移」换算成栈索引（0 = 最底）。 */
  const moveBy = (delta: number) => {
    if (activeLayerId === 0) return;
    void moveLayer(docId, activeLayerId, activeIndex + delta);
  };

  const onError = (err: unknown) => {
    useDocsStore
      .getState()
      .setMessage({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
  };

  const run = (op: Promise<void>) => op.catch(onError);

  return (
    <div className="mo-layers">
      {/* 活动层的混合模式与不透明度（Photoshop：面板顶部控制活动层） */}
      <div className="mo-layers__controls">
        <label className="mo-layers__field">
          <span>混合模式</span>
          <select
            value={activeLayer?.blendMode ?? "normal"}
            disabled={!activeLayer}
            onChange={(e) => {
              if (activeLayer) {
                run(setLayerBlendMode(docId, activeLayer.id, e.target.value as BlendModeName));
              }
            }}
          >
            {BLEND_MODE_LABELS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-layers__field">
          <span>
            不透明度 <em>{activeLayer ? Math.round(activeLayer.opacity * 100) : 0}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            disabled={!activeLayer}
            value={activeLayer ? Math.round(activeLayer.opacity * 100) : 100}
            onChange={(e) => {
              if (activeLayer) {
                run(setLayerOpacity(docId, activeLayer.id, Number(e.target.value) / 100));
              }
            }}
          />
        </label>
      </div>

      {/* 图层操作按钮排 */}
      <div className="mo-layers__actions">
        <button type="button" className="mo-layers__btn" title="新建图层" onClick={() => run(addLayer(docId))}>
          <Plus size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="删除图层"
          disabled={stackLen <= 1}
          onClick={() => run(deleteLayer(docId, activeLayerId))}
        >
          <Trash2 size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="上移一层"
          disabled={activeIndex < 0 || activeIndex >= stackLen - 1}
          onClick={() => moveBy(1)}
        >
          <ArrowUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="下移一层"
          disabled={activeIndex <= 0}
          onClick={() => moveBy(-1)}
        >
          <ArrowDown size={14} aria-hidden />
        </button>
      </div>

      {/* 图层列表（上=顶） */}
      <ul className="mo-layers__list">
        {rows.map((layer) => (
          <li key={layer.id}>
            <button
              type="button"
              className={`mo-layers__row${layer.id === activeLayerId ? " mo-layers__row--active" : ""}`}
              onClick={() => run(activateLayer(docId, layer.id))}
              title={`${layer.name}（点击设为活动图层）`}
            >
              <span
                role="button"
                tabIndex={-1}
                className="mo-layers__eye"
                title={layer.visible ? "隐藏图层" : "显示图层"}
                onClick={(e) => {
                  e.stopPropagation();
                  run(setLayerVisible(docId, layer.id, !layer.visible));
                }}
              >
                {layer.visible ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
              </span>
              <span className="mo-layers__name">{layer.name}</span>
              <span className="mo-layers__meta">
                {BLEND_MODE_LABELS.find((m) => m.value === layer.blendMode)?.label}
                {layer.opacity < 1 ? ` ${Math.round(layer.opacity * 100)}%` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
