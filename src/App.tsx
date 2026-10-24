import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ThemeProvider } from "@baigong/fang";
import "@baigong/fang/tokens.css";

/** Rust 侧 app_info 命令的返回契约（src-tauri/src/lib.rs）。 */
interface AppInfo {
  name: string;
  version: string;
}

/**
 * M0 骨架页：空窗口准入的落点。
 * 坊接入（ThemeProvider + tokens.css）与 Rust 命令通道（app_info）在此打通；
 * M1 起多标签画布替换本页（产品分析四大区域布局）。
 */
export default function App() {
  const [version, setVersion] = useState("…");

  useEffect(() => {
    let alive = true;
    invoke<AppInfo>("app_info")
      .then((info) => {
        if (alive) setVersion(info.version);
      })
      .catch(() => {
        if (alive) setVersion("dev"); // 浏览器裸跑 vite dev 时无 Tauri IPC
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ThemeProvider>
      <main className="mo-welcome">
        <h1 className="mo-welcome__title">百工·墨</h1>
        <p className="mo-welcome__meta">M0 骨架 · v{version}</p>
        <p className="mo-welcome__note">以图层为中心的位图编辑与合成（M1 起可打开图片）</p>
      </main>
    </ThemeProvider>
  );
}
