/**
 * 窗口适配器接线：把坊 TitleBar 的窗口三键接到 Tauri 当前窗口（形态参照 jian）。
 *
 * main.tsx 渲染前调用一次（TitleBar 挂载帧读取已注入的适配器）；
 * onResized 同时驱动最大化状态回传（最大化/向下还原图标切换）。
 * 对应权限在 capabilities/default.json（minimize/toggle-maximize/close/is-maximized）。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { installWindowAdapter } from "@baigong/fang";

export function setupWindowControls(): void {
  // 纯浏览器（vite dev 直开，不经 tauri dev）无 Tauri IPC：不注入，
  // TitleBar 三键置灰——避免 minimize/isMaximized 等调用产生未处理 rejection
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const win = getCurrentWindow();
  installWindowAdapter({
    minimize: () => void win.minimize(),
    toggleMaximize: () => void win.toggleMaximize(),
    close: () => void win.close(),
    isMaximized: () => win.isMaximized(),
    onMaximizeChange(cb) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void win.onResized(async () => {
        if (!disposed) cb(await win.isMaximized());
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  });
}
