// 百工·墨（Mo）：以图层为中心的位图编辑工具。M0 骨架 = 空窗口外壳 + app_info 命令。
// 图像编解码选型评审中（docs/图像库选型.md），本阶段不引入图像处理依赖；
// M1 起的打开/保存/像素访问命令随选型落位再挂进 invoke_handler。

use serde::Serialize;

/// 应用元信息：前端骨架页 invoke("app_info") 的返回契约（src/App.tsx）。
/// version 与 tauri.conf.json 的 version 同源维护（发布前一同提升）。
#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "百工·墨",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running mo");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_名称与语义化版本契约() {
        let info = app_info();
        assert_eq!(info.name, "百工·墨");
        // 版本必须是三段数字（前端展示与 release 打 tag 都依赖此形状）
        let parts: Vec<&str> = info.version.split('.').collect();
        assert_eq!(parts.len(), 3, "版本号应为 x.y.z，实际 {}", info.version);
        for part in &parts {
            assert!(
                part.chars().all(|c| c.is_ascii_digit()) && !part.is_empty(),
                "版本段应为纯数字，实际 {part}"
            );
        }
    }
}
