/**
 * 应用外壳：坊标题栏（菜单＋窗口三键）＋ 左工具栏 ＋ 中央画布区（标签/选项栏/
 * 视口/状态栏）＋ 右停靠面板（M2 起：图层；M3 起：历史——坊 DockHost/DockPanel）。
 * 布局对应产品分析四区：顶部菜单栏、左侧工具栏、中央画布区、右侧停靠面板区
 * （属性/颜色随 M4+ 进）。
 */
import { ThemeProvider, DockHost, DockPanel } from "@baigong/fang";
import "@baigong/fang/tokens.css";
import { AppTitleBar } from "./AppTitleBar";
import { Toolbar } from "../features/canvas/Toolbar";
import { DocTabs } from "../features/canvas/DocTabs";
import { ToolOptionsBar } from "../features/canvas/ToolOptionsBar";
import { CanvasView } from "../features/canvas/CanvasView";
import { StatusBar } from "../features/statusbar/StatusBar";
import { LayersPanel } from "../features/layers/LayersPanel";
import { HistoryPanel } from "../features/history/HistoryPanel";
import { useDocsStore } from "../core/document/store";

function EmptyState() {
  return (
    <div className="mo-empty">
      <p className="mo-empty__title">打开一张图或新建文档开始（Ctrl+O / Ctrl+N）</p>
      <p className="mo-empty__note">M3 支持画笔/橡皮/填充/裁剪与撤销历史</p>
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
          <DockHost
            center={
              <div className="app-canvas-area">
                <DocTabs />
                {hasDoc ? <ToolOptionsBar /> : null}
                {hasDoc ? <CanvasView /> : <EmptyState />}
                <StatusBar />
              </div>
            }
            right={
              <>
                <DockPanel title="图层" collapsed={false}>
                  <LayersPanel />
                </DockPanel>
                <DockPanel title="历史" collapsed={false}>
                  <HistoryPanel />
                </DockPanel>
              </>
            }
            sideWidth={240}
          />
        </div>
      </div>
    </ThemeProvider>
  );
}
