/**
 * 调整面板（M4）：活动图层是调整图层时编辑其参数（亮度/色相滑杆、曲线
 * 拖点编辑器），否则显示占位提示。
 *
 * 提交纪律：滑杆拖动中只更新本地草稿，松手（pointerup/键盘松开/失焦）才
 * setAdjustmentParams——一次拖动一条历史，不按拖动帧灌历史；曲线同理
 * （拖点/加点松手提交）。参数即时反映在合成（Rust 非破坏重合成）。
 * 曲线预览与取值用 core/canvas/curves.ts（与 Rust 同口径的单调三次插值）。
 */
import { useEffect, useRef, useState } from "react";
import { useDocsStore, selectActiveLayers } from "../../core/document/store";
import { setAdjustmentParams } from "../../core/document/layerPipeline";
import { curveAt, normalizePoints } from "../../core/canvas/curves";
import type { AdjustmentSpec } from "../../core/document/types";

export function AdjustPanel() {
  const docId = useDocsStore((s) => s.activeId);
  const layers = useDocsStore(selectActiveLayers);
  const activeLayerId = useDocsStore((s) =>
    s.activeId === null ? 0 : (s.activeLayerId[s.activeId] ?? 0),
  );

  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const adjustment =
    activeLayer && activeLayer.kind.kind === "adjustment" ? activeLayer.kind.adjustment : null;

  if (docId === null || !adjustment) {
    return (
      <p className="mo-adjust__empty">
        选中调整图层后在此调参（图层面板可新建亮度/曲线/色相调整层）
      </p>
    );
  }
  return <AdjustEditor docId={docId} layerId={activeLayerId} adjustment={adjustment} />;
}

function AdjustEditor({
  docId,
  layerId,
  adjustment,
}: {
  docId: number;
  layerId: number;
  adjustment: AdjustmentSpec;
}) {
  const onError = (err: unknown) => {
    useDocsStore
      .getState()
      .setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
  };
  const commit = (next: AdjustmentSpec) => {
    void setAdjustmentParams(docId, layerId, next).catch(onError);
  };

  if (adjustment.type === "brightness") {
    return <BrightnessEditor value={adjustment.amount} onCommit={commit} />;
  }
  if (adjustment.type === "hue") {
    return <HueEditor value={adjustment.degrees} onCommit={commit} />;
  }
  return <CurvesEditor points={adjustment.points} onCommit={commit} />;
}

/** 滑杆编辑器骨架：拖动只动草稿，松手/失焦提交一次。 */
function useSliderCommit(value: number, toSpec: (v: number) => AdjustmentSpec, onCommit: (a: AdjustmentSpec) => void) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  useEffect(() => {
    setDraft(value);
    draftRef.current = value;
  }, [value]);
  const commitNow = () => {
    if (draftRef.current === value) return;
    onCommit(toSpec(draftRef.current));
  };
  return {
    draft,
    handlers: {
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = Number(e.target.value);
        draftRef.current = v;
        setDraft(v);
      },
      onPointerUp: commitNow,
      onKeyUp: commitNow,
      onBlur: commitNow,
    },
  };
}

function BrightnessEditor({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (a: AdjustmentSpec) => void;
}) {
  const { draft, handlers } = useSliderCommit(
    value,
    (v) => ({ type: "brightness", amount: v / 100 }),
    onCommit,
  );
  return (
    <div className="mo-adjust__body">
      <label className="mo-adjust__field">
        <span>
          亮度 <em>{draft > 0 ? `+${draft}` : draft}</em>
        </span>
        <input type="range" min={-100} max={100} step={1} value={draft} {...handlers} />
      </label>
      <p className="mo-adjust__note">-100 压暗 ～ +100 提亮（线性平移）；松手记一条历史</p>
    </div>
  );
}

function HueEditor({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (a: AdjustmentSpec) => void;
}) {
  const { draft, handlers } = useSliderCommit(
    value,
    (v) => ({ type: "hue", degrees: v }),
    onCommit,
  );
  return (
    <div className="mo-adjust__body">
      <label className="mo-adjust__field">
        <span>
          色相 <em>{draft > 0 ? `+${draft}` : draft}°</em>
        </span>
        <input type="range" min={-180} max={180} step={1} value={draft} {...handlers} />
      </label>
      <p className="mo-adjust__note">色轮旋转（HSL）；灰阶不变，松手记一条历史</p>
    </div>
  );
}

/** 曲线编辑器：SVG 网格 + 可拖控制点；空白处点击加点、双击删点（至少 2 个）。 */
function CurvesEditor({
  points,
  onCommit,
}: {
  points: [number, number][];
  onCommit: (a: AdjustmentSpec) => void;
}) {
  const [draft, setDraft] = useState<[number, number][]>(points);
  const draftRef = useRef(points);
  useEffect(() => {
    setDraft(points);
    draftRef.current = points;
  }, [points]);
  const dragIndex = useRef<number | null>(null);
  /** 拖动中把点钳在邻点区间内（端点只许上下移）：x 不会越过邻点，
   *  normalizePoints 的重排就不会让 dragIndex「换手」跳变（M4 评审修复）。 */
  const dragBounds = useRef<{ minX: number; maxX: number } | null>(null);
  const SIZE = 220; // 显示像素（SVG 坐标即 0..255 缩放后的视区）
  const toSvg = ([x, y]: [number, number]) => ({ cx: (x / 255) * SIZE, cy: SIZE - (y / 255) * SIZE });
  const fromSvg = (cx: number, cy: number): [number, number] => [
    Math.round((cx / SIZE) * 255),
    Math.round((1 - cy / SIZE) * 255),
  ];

  const commitNow = () => {
    const normalized = normalizePoints(draftRef.current);
    if (normalized && JSON.stringify(normalized) !== JSON.stringify(points)) {
      onCommit({ type: "curves", points: normalized });
    }
  };

  const svgRef = useRef<SVGSVGElement | null>(null);
  const localPos = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 显示尺寸可能被 CSS 缩放：按比例折回 SVG 坐标
    return {
      cx: ((e.clientX - rect.left) / rect.width) * SIZE,
      cy: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const captureBounds = (index: number) => {
    const pts = draftRef.current;
    const last = pts.length - 1;
    if (index === 0 || index === last) {
      // 端点 x 锁死（Photoshop 曲线端点同理），只许调 y
      dragBounds.current = { minX: pts[index][0], maxX: pts[index][0] };
      return;
    }
    const minX = pts[index - 1][0] + 1; // 保持整数严格递增（与 Rust「x 不重复」对齐）
    const maxX = pts[index + 1][0] - 1;
    dragBounds.current = minX <= maxX ? { minX, maxX } : { minX: pts[index][0], maxX: pts[index][0] };
  };

  return (
    <div className="mo-adjust__body">
      <svg
        ref={svgRef}
        className="mo-adjust__curve"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="application"
        aria-label="曲线编辑器（拖点调曲线，空白点击加点，双击删点）"
        onPointerDown={(e) => {
          if (draftRef.current.length >= 16) return; // 与 Rust 上限一致
          const { cx, cy } = localPos(e);
          const next = [...draftRef.current, fromSvg(cx, cy)];
          const normalized = normalizePoints(next);
          if (!normalized) return;
          draftRef.current = normalized;
          setDraft(normalized);
        }}
        onPointerMove={(e) => {
          if (dragIndex.current === null) return;
          const { cx, cy } = localPos(e);
          let [x, y] = fromSvg(cx, cy);
          if (dragBounds.current) {
            x = Math.min(dragBounds.current.maxX, Math.max(dragBounds.current.minX, x));
          }
          const next: [number, number][] = draftRef.current.map((p, i) =>
            i === dragIndex.current ? ([x, y] as [number, number]) : p,
          );
          const normalized = normalizePoints(next);
          if (!normalized) return;
          draftRef.current = normalized;
          setDraft(normalized);
        }}
        onPointerUp={() => {
          dragIndex.current = null;
          dragBounds.current = null;
          commitNow();
        }}
        onPointerLeave={() => {
          if (dragIndex.current !== null) {
            dragIndex.current = null;
            dragBounds.current = null;
            commitNow();
          }
        }}
      >
        {/* 网格与参考对角线 */}
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="currentColor" className="mo-adjust__grid">
            <line x1={(i * SIZE) / 4} y1={0} x2={(i * SIZE) / 4} y2={SIZE} />
            <line x1={0} y1={(i * SIZE) / 4} x2={SIZE} y2={(i * SIZE) / 4} />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className="mo-adjust__diagonal" />
        {/* 曲线预览（与 Rust 同口径的单调三次样条采样） */}
        <polyline
          className="mo-adjust__curve-line"
          points={Array.from({ length: 65 }, (_, i) => {
            const x = (i * 255) / 64;
            const y = curveAt(draft, x);
            const p = toSvg([x, y]);
            return `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`;
          }).join(" ")}
        />
        {/* 控制点（拖动改点、双击删点） */}
        {draft.map((p, i) => {
          const { cx, cy } = toSvg(p);
          return (
            <circle
              key={`${p[0]}-${p[1]}-${i}`}
              className="mo-adjust__curve-point"
              cx={cx}
              cy={cy}
              r={5}
              onPointerDown={(e) => {
                e.stopPropagation(); // 不触发画布加点的逻辑
                (e.target as Element).setPointerCapture?.(e.pointerId);
                dragIndex.current = i;
                captureBounds(i);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (draftRef.current.length <= 2) return; // 至少 2 点
                const next = draftRef.current.filter((_, j) => j !== i);
                draftRef.current = next;
                setDraft(next);
                // 双击即提交（无 pointerup 跟随）
                const normalized = normalizePoints(next);
                if (normalized) onCommit({ type: "curves", points: normalized });
              }}
            />
          );
        })}
      </svg>
      <p className="mo-adjust__note">
        暗部横轴 → 亮部；空白点击加点、双击删点、拖点调形（端点只上下移），松手记一条历史
      </p>
    </div>
  );
}
