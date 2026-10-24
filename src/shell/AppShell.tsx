/**
 * 应用外壳：坊标题栏（菜单＋窗口三键）＋ 左工具栏 ＋ 中央画布区（标签/视口/状态栏）。
 * 布局对应产品分析四区中 M1 落地的部分：顶部菜单栏、左侧工具栏、中央画布区；
 * 右侧停靠面板区自 M2 图层系统起进（届时换坊 DockHost）。
 */
import { ThemeProvider } from "@baigong/fang";
import "@baigong/fang/tokens.css";
import { AppTitleBar } from "./AppTitleBar";
import { Toolbar } from "../features/canvas/Toolbar";
import { DocTabs } from "../features/canvas/DocTabs";
import { CanvasView } from "../features/canvas/CanvasView";
import { StatusBar } from "../features/statusbar/StatusBar";
import { useDocsStore } from "../core/document/store";

function EmptyState() {
  return (
    <div className="mo-empty">
      <p className="mo-empty__title">打开一张图开始（Ctrl+O）</p>
      <p className="mo-empty__note">M1 支持 JPG / PNG 的打开、查看与另存</p>
    </div>
  );
}

export function AppShell() {
  const hasDoc = useDocsStore((s) => s.docs.length > 0);

  return (
    <ThemeProvider>
      <div className="app-shell">
        <AppTitleBar />
        <div className="app-main">
          <Toolbar />
          <div className="app-canvas-area">
            <DocTabs />
            {hasDoc ? <CanvasView /> : <EmptyState />}
            <StatusBar />
          </div>
        </div>
      </div>
    </ThemeProvider>
  );
}
