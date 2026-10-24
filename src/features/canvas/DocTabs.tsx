/**
 * 多文档标签栏：点击激活、×关闭（关闭走 openPipeline.closeDoc 释放两端内存）。
 */
import { X } from "lucide-react";
import { useDocsStore } from "../../core/document/store";
import { closeDoc } from "../../core/document/openPipeline";

export function DocTabs() {
  const docs = useDocsStore((s) => s.docs);
  const activeId = useDocsStore((s) => s.activeId);
  const setActive = useDocsStore((s) => s.setActive);

  if (docs.length === 0) return null;

  return (
    <div className="mo-tabs" role="tablist" aria-label="打开的文档">
      {docs.map((doc) => (
        <div
          key={doc.id}
          role="tab"
          aria-selected={doc.id === activeId}
          className={`mo-tabs__tab${doc.id === activeId ? " mo-tabs__tab--active" : ""}`}
          onPointerDown={() => setActive(doc.id)}
          title={doc.path}
        >
          <span className="mo-tabs__name">{doc.name}</span>
          <span className="mo-tabs__size">
            {doc.width}×{doc.height}
          </span>
          <button
            type="button"
            className="mo-tabs__close"
            aria-label={`关闭 ${doc.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void closeDoc(doc.id).catch(() => {
                /* Rust 侧释放失败不阻塞：标签与像素已在 closeDoc 内清掉 */
              });
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
