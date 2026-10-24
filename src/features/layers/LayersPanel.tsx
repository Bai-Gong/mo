/**
 * 图层面板（M2 起，产品分析「右侧停靠面板区」的首块）：列表（上=顶）、可见性、
 * 增删、上下移、活动层的不透明度与混合模式；M4 起图层分三种——栅格/调整
 * （徽标「调」）/文字（徽标「文」），并可一键新建亮度/曲线/色相调整图层。
 *
 * Rust 是事实源：所有操作走 layerPipeline（成功后快照落 store、合成像素重拉）。
 * 展示顺序与栈序相反——栈自底向上，面板自上而下（Photoshop 惯例）。
 * 调整层不参与混合模式（Rust 合成对调整层忽略之），下拉禁用；不透明度 =
 * 调整强度（原值与调整值按其线性混合）。
 */
import { useEffect } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import {
  selectActiveLayers,
  useDocsStore,
} from "../../core/document/store";
import {
  ADJUSTMENT_TYPE_LABELS,
  BLEND_MODE_LABELS,
  type BlendModeName,
  type LayerMeta,
} from "../../core/document/types";
import {
  activateLayer,
  addAdjustmentLayer,
  addLayer,
  deleteLayer,
  moveLayer,
  refreshLayers,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerVisible,
} from "../../core/document/layerPipeline";

/** 图层行徽标与摘要（按种类）。 */
function kindBadge(layer: LayerMeta): { badge: string; title: string; summary: string } {
  if (layer.kind.kind === "adjustment") {
    const a = layer.kind.adjustment;
    const summary =
      a.type === "brightness"
        ? `${a.amount > 0 ? "+" : ""}${Math.round(a.amount * 100)}`
        : a.type === "hue"
          ? `${a.degrees > 0 ? "+" : ""}${a.degrees}°`
          : `${a.points.length} 点`;
    return {
      badge: "调",
      title: "调整图层（非破坏，只作用于其下内容）",
      summary: `${ADJUSTMENT_TYPE_LABELS[a.type]} ${summary}`,
    };
  }
  if (layer.kind.kind === "text") {
    return { badge: "文", title: "文字图层（选项栏编辑内容）", summary: "文字" };
  }
  return {
    badge: "",
    title: "栅格图层",
    summary: BLEND_MODE_LABELS.find((m) => m.value === layer.blendMode)?.label ?? "正常",
  };
}

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
  const activeIsAdjustment = activeLayer?.kind.kind === "adjustment";
  const activeIsText = activeLayer?.kind.kind === "text";

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
      {/* 活动层的混合模式与不透明度（Photoshop：面板顶部控制活动层）。
          调整层不参与混合模式（合成忽略），禁用以免误导；不透明度=调整强度。 */}
      <div className="mo-layers__controls">
        <label className="mo-layers__field">
          <span>混合模式</span>
          <select
            value={activeLayer?.blendMode ?? "normal"}
            disabled={!activeLayer || activeIsAdjustment}
            title={activeIsAdjustment ? "调整图层不使用混合模式" : undefined}
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
            {activeIsAdjustment ? "调整强度" : "不透明度"}{" "}
            <em>{activeLayer ? Math.round(activeLayer.opacity * 100) : 0}%</em>
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

      {/* 图层操作按钮排：栅格新建 / 三种调整图层新建 / 删除 / 上下移 */}
      <div className="mo-layers__actions">
        <button type="button" className="mo-layers__btn" title="新建图层" onClick={() => run(addLayer(docId))}>
          <Plus size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="新建亮度调整图层（非破坏）"
          onClick={() => run(addAdjustmentLayer(docId, { type: "brightness", amount: 0 }))}
        >
          亮
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="新建曲线调整图层（非破坏）"
          onClick={() =>
            run(addAdjustmentLayer(docId, { type: "curves", points: [[0, 0], [255, 255]] }))
          }
        >
          曲
        </button>
        <button
          type="button"
          className="mo-layers__btn"
          title="新建色相调整图层（非破坏）"
          onClick={() => run(addAdjustmentLayer(docId, { type: "hue", degrees: 0 }))}
        >
          色
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
        {rows.map((layer) => {
          const { badge, title, summary } = kindBadge(layer);
          return (
            <li key={layer.id}>
              <button
                type="button"
                className={`mo-layers__row${layer.id === activeLayerId ? " mo-layers__row--active" : ""}`}
                onClick={() => run(activateLayer(docId, layer.id))}
                title={`${layer.name}（${title}；点击设为活动图层）`}
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
                {badge ? <span className="mo-layers__badge">{badge}</span> : null}
                <span className="mo-layers__name">{layer.name}</span>
                <span className="mo-layers__meta">
                  {summary}
                  {layer.opacity < 1 ? ` ${Math.round(layer.opacity * 100)}%` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {activeIsText && (
        <p className="mo-layers__note">文字图层：用文字工具选项栏编辑内容与样式</p>
      )}
    </div>
  );
}
