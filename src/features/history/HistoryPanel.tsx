/**
 * 历史面板（M3，产品分析「右侧停靠面板区」：历史）：撤销/重做按钮 + 条目
 * 列表（点条目跳转到该状态）。Rust 是事实源：撤销重做跳转走 layerPipeline
 * （成功后历史/图层快照落 store、合成像素重拉）；标签打开/切换时面板自愈
 * （历史未拉取即拉一次）。
 *
 * 语义：index = 已应用条数；「初始状态」行对应 index 0，第 i 条对应 index i+1。
 * 点击某行 = 跳到该状态（Rust 单命令内多步 undo/redo，原子完成）。
 */
import { useEffect } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { useDocsStore } from "../../core/document/store";
import { jumpHistory, redo, refreshHistory, undo } from "../../core/document/layerPipeline";

export function HistoryPanel() {
  const docId = useDocsStore((s) => s.activeId);
  const history = useDocsStore((s) =>
    s.activeId === null ? null : (s.history[s.activeId] ?? null),
  );

  // 标签打开/切换后自动拉一次历史（面板自愈：null 即拉）
  useEffect(() => {
    if (docId === null || history !== null) return;
    refreshHistory(docId).catch((err) => {
      useDocsStore.getState().setMessage({
        kind: "error",
        text: `历史拉取失败：${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }, [docId, history]);

  if (docId === null) {
    return <p className="mo-history__empty">打开图像或新建文档后出现历史</p>;
  }
  if (history === null) {
    return <p className="mo-history__empty">读取历史…</p>;
  }

  const { entries, index } = history;
  const canUndo = index > 0;
  const canRedo = index < entries.length;

  const onError = (err: unknown) => {
    useDocsStore.getState().setMessage({
      kind: "error",
      text: err instanceof Error ? err.message : String(err),
    });
  };

  // 行序：最新在上（Photoshop 惯例）。初始状态行 target=0，第 i 条 target=i+1。
  const rows: { label: string; target: number; active: boolean }[] = [
    { label: "初始状态", target: 0, active: index === 0 },
    ...entries.map((label, i) => ({
      label,
      target: i + 1,
      active: index === i + 1,
    })),
  ];

  return (
    <div className="mo-history">
      <div className="mo-history__actions">
        <button
          type="button"
          className="mo-history__btn"
          disabled={!canUndo}
          onClick={() => undo(docId).catch(onError)}
          title="撤销（Ctrl+Z）"
        >
          <Undo2 size={14} aria-hidden />
          撤销
        </button>
        <button
          type="button"
          className="mo-history__btn"
          disabled={!canRedo}
          onClick={() => redo(docId).catch(onError)}
          title="重做（Ctrl+Shift+Z / Ctrl+Y）"
        >
          <Redo2 size={14} aria-hidden />
          重做
        </button>
      </div>
      <ul className="mo-history__list">
        {[...rows].reverse().map((row) => (
          <li key={row.target}>
            <button
              type="button"
              className={`mo-history__row${row.active ? " mo-history__row--active" : ""}`}
              onClick={() => jumpHistory(docId, row.target).catch(onError)}
              title={`跳转到「${row.label}」`}
            >
              {row.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="mo-history__note">
        {canUndo ? "点条目可跳回该状态" : "尚无可撤销的编辑"}
        {entries.length > 0 ? ` · ${index}/${entries.length}` : ""}
      </p>
    </div>
  );
}
