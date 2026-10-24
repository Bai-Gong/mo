//! M1 图像管线：打开（解码→RGBA8 文档）、像素传输、另存（编码 + ICC 写回）。
//!
//! 选型定案（docs/图像库选型.md）：image 0.25.x 默认 feature 作总入口——JPEG 解码
//! 走内置 zune-jpeg、PNG 编解码走内置 png 0.18.x；内部工作格式 `RgbaImage`（RGBA8）；
//! 色彩管理 M1 只做 sRGB 假设 + ICC 元数据保全（读出挂在文档上、另存时原样写回），
//! 不做完整 ICC 变换。
//!
//! 像素的事实源在 Rust 侧（`Documents` 注册表）：前端按文档 id 拉一次原始字节用于
//! 显示与取色，另存由本侧直接从驻留像素编码——M2+ 图层栈在该文档模型上生长。

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
    RgbaImage,
};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

/// 打开命令回给前端的文档元信息（camelCase 契约）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedImageInfo {
    pub doc_id: u32,
    pub width: u32,
    pub height: u32,
    /// 是否携带 ICC 色彩配置（状态栏提示「含色彩配置，另存时原样保留」）。
    /// 字节本体只留 Rust 侧，不跨 IPC 传。
    pub has_icc: bool,
    /// 来源格式名（"png" / "jpeg"），另存对话框的默认项。
    pub format: String,
}

/// 解码后的图像文档：RGBA8 像素 + 打开时读出的 ICC。
#[derive(Debug)]
pub struct ImageDocument {
    pub width: u32,
    pub height: u32,
    pub pixels: RgbaImage,
    pub icc_profile: Option<Vec<u8>>,
    pub format: ImageFormat,
}

/// 文档注册表：多标签画布各持一个 id；像素驻留 Rust 侧内存。
#[derive(Default)]
pub struct Documents {
    next_id: AtomicU32,
    docs: Mutex<HashMap<u32, ImageDocument>>,
}

impl Documents {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记文档，返回新 id（从 1 起，0 保留为非法值）。
    pub fn insert(&self, doc: ImageDocument) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.docs
            .lock()
            .expect("文档注册表锁中毒")
            .insert(id, doc);
        id
    }

    /// 借用访问文档；id 不存在（已关闭/从未打开）返回 Err。
    pub fn with_doc<R>(&self, id: u32, f: impl FnOnce(&ImageDocument) -> R) -> Result<R, String> {
        let guard = self.docs.lock().expect("文档注册表锁中毒");
        let doc = guard
            .get(&id)
            .ok_or_else(|| format!("文档 {id} 不存在（可能已关闭）"))?;
        Ok(f(doc))
    }

    /// 摘除文档（关标签释放内存）。返回是否真的摘到了。
    pub fn remove(&self, id: u32) -> bool {
        self.docs
            .lock()
            .expect("文档注册表锁中毒")
            .remove(&id)
            .is_some()
    }
}

/// 解码磁盘图像文件 → RGBA8 文档（真实管线入口，命令与测试共用）。
///
/// ICC 读取：`ImageDecoder::icc_profile()`——JPEG（zune-jpeg 解析 APP2）与
/// PNG（iCCP chunk）均透传（选型文档已核源码 image `src/codecs/jpeg/decoder.rs:126`、
/// `src/codecs/png.rs:307`）。
pub fn decode_image_file(path: &Path) -> Result<ImageDocument, String> {
    // image 对恶意输入可能 panic（其 CHANGES.md 自列已知问题）——catch_unwind 屏障
    // 让坏文件变成一条错误而不是拖垮进程（选型「风险与待验证」节的低成本兜底；
    // release 的 panic=abort 下不可捕，dev/debug 构建有效）。
    let decoded = std::panic::catch_unwind(|| decode_image_inner(path));
    match decoded {
        Ok(result) => result,
        Err(_) => Err(format!(
            "图像解码器在处理该文件时崩溃（可能为损坏或恶意构造的图像）：{}",
            path.display()
        )),
    }
}

fn decode_image_inner(path: &Path) -> Result<ImageDocument, String> {
    let reader = ImageReader::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let reader = reader
        .with_guessed_format()
        .map_err(|e| format!("无法读取文件内容：{e}"))?;
    let format = reader
        .format()
        .ok_or_else(|| format!("无法识别图像格式：{}", path.display()))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("解码器初始化失败：{e}"))?;
    let icc_profile = decoder
        .icc_profile()
        .map_err(|e| format!("读取 ICC 色彩配置失败：{e}"))?;
    let dynamic = DynamicImage::from_decoder(decoder).map_err(|e| format!("解码失败：{e}"))?;
    let (width, height) = (dynamic.width(), dynamic.height());
    // JPG（无 alpha）等格式在此统一补不透明通道，落位选型定案的 RGBA8 工作格式。
    let pixels = dynamic.to_rgba8();
    Ok(ImageDocument {
        width,
        height,
        pixels,
        icc_profile,
        format,
    })
}

/// 另存格式（M1 支持面，与选型范围一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveFormat {
    Png,
    Jpeg,
}

impl SaveFormat {
    /// 前端传 "png" / "jpeg"。
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "jpeg" | "jpg" => Ok(Self::Jpeg),
            other => Err(format!("M1 不支持的保存格式：{other}（支持 png / jpeg）")),
        }
    }
}

/// 把驻留像素编码写入磁盘（真实管线出口，命令与测试共用）。
///
/// ICC 写回：PngEncoder 写 iCCP、JpegEncoder 写 APP2（image 0.25.6 起的
/// `ImageEncoder::set_icc_profile`，Png/Jpeg 编码器均已实现，选型文档已核）。
/// JPEG 质量 1–100（与 image 编码器同刻度），越界收拢。
pub fn encode_image_file(
    doc: &ImageDocument,
    path: &Path,
    format: SaveFormat,
    quality: u8,
) -> Result<(), String> {
    let file = File::create(path).map_err(|e| format!("无法创建输出文件：{e}"))?;
    let (width, height) = (doc.width, doc.height);
    let raw = doc.pixels.as_raw();
    match format {
        SaveFormat::Png => {
            let mut encoder = PngEncoder::new(file);
            if let Some(icc) = doc.icc_profile.as_ref() {
                encoder
                    .set_icc_profile(icc.clone())
                    .map_err(|e| format!("写入 ICC 配置失败：{e}"))?;
            }
            encoder
                .write_image(raw, width, height, ExtendedColorType::Rgba8)
                .map_err(|e| format!("PNG 编码失败：{e}"))?;
        }
        SaveFormat::Jpeg => {
            let quality = quality.clamp(1, 100);
            let mut encoder = JpegEncoder::new_with_quality(file, quality);
            if let Some(icc) = doc.icc_profile.as_ref() {
                encoder
                    .set_icc_profile(icc.clone())
                    .map_err(|e| format!("写入 ICC 配置失败：{e}"))?;
            }
            // JPEG 无 alpha：0.25.10 内置编码器只收 L8/Rgb8（源码 encode 的 match
            // 只有这两支），Rgba8 在此显式丢 alpha 转 RGB 后再进编码器。
            let rgb = DynamicImage::ImageRgba8(doc.pixels.clone()).to_rgb8();
            encoder
                .write_image(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
                .map_err(|e| format!("JPEG 编码失败：{e}"))?;
        }
    }
    Ok(())
}

fn format_name(format: ImageFormat) -> String {
    match format {
        ImageFormat::Jpeg => "jpeg".into(),
        ImageFormat::Png => "png".into(),
        other => format!("{other:?}").to_lowercase(),
    }
}

/// 打开图像文件并登记为文档（前端「打开…」的落点）。
#[tauri::command]
pub fn open_image(path: String, documents: State<Documents>) -> Result<OpenedImageInfo, String> {
    let doc = decode_image_file(&PathBuf::from(path))?;
    let info = OpenedImageInfo {
        doc_id: 0,
        width: doc.width,
        height: doc.height,
        has_icc: doc.icc_profile.is_some(),
        format: format_name(doc.format),
    };
    let doc_id = documents.insert(doc);
    Ok(OpenedImageInfo { doc_id, ..info })
}

/// 取文档原始像素（RGBA8，width×height×4 字节）。
///
/// 走 `tauri::ipc::Response` 原始字节通道：不经 JSON 数组序列化，
/// 前端 invoke 直接拿到 ArrayBuffer。
#[tauri::command]
pub fn get_pixels(doc_id: u32, documents: State<Documents>) -> Result<Response, String> {
    documents.with_doc(doc_id, |doc| Response::new(doc.pixels.as_raw().clone()))
}

/// 另存文档（前端「另存为…」的落点）。quality 仅 JPEG 生效（1–100）。
#[tauri::command]
pub fn save_document(
    doc_id: u32,
    path: String,
    format: String,
    quality: u8,
    documents: State<Documents>,
) -> Result<(), String> {
    let format = SaveFormat::parse(&format)?;
    documents.with_doc(doc_id, |doc| {
        encode_image_file(doc, &PathBuf::from(path), format, quality)
    })?
}

/// 关闭文档释放 Rust 侧驻留像素（关标签时调用）。
#[tauri::command]
pub fn close_document(doc_id: u32, documents: State<Documents>) -> bool {
    documents.remove(doc_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 测试用具：真实磁盘文件（temp 目录），走 decode/encode 真实管线 ——

    /// 每测试独占的临时文件路径（进程 id + 计数器避免并发测试互踩）。
    fn temp_path(name: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("mo-m1-{}-{n}-{name}", std::process::id()));
        p
    }

    /// 64×64 四象限纯色样张：红/绿/蓝/白，各象限 32×32（块中心采样远离 8×8 边界，
    /// JPEG 有损往返的断言点取在各象限中心，色差只来自压缩本身）。
    fn sample_doc(icc: Option<Vec<u8>>) -> ImageDocument {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, color) in [
            (0u32, 0u32, [255u8, 0, 0, 255]),
            (32, 0, [0, 255, 0, 255]),
            (0, 32, [0, 0, 255, 255]),
            (32, 32, [255, 255, 255, 255]),
        ] {
            for dy in 0..32 {
                for dx in 0..32 {
                    img.put_pixel(x + dx, y + dy, image::Rgba(color));
                }
            }
        }
        ImageDocument {
            width: 64,
            height: 64,
            pixels: img,
            icc_profile: icc,
            format: ImageFormat::Png,
        }
    }

    fn fake_icc() -> Vec<u8> {
        // 任意字节即可：png iCCP / jpeg APP2 均按不透明负载读写，管线不解析内容
        (0..64u32).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn assert_channel_close(actual: [u8; 4], expected: [u8; 4], tol: i32, ctx: &str) {
        for ch in 0..4 {
            let diff = (actual[ch] as i32 - expected[ch] as i32).abs();
            assert!(
                diff <= tol,
                "{ctx} 第 {ch} 通道差 {diff} 超容差 {tol}：实际 {actual:?} 期望 {expected:?}"
            );
        }
    }

    // —— 准入场景「打开 → 查看 → 另存」的 Rust 侧真实往返 ——

    #[test]
    fn png_往返_像素无损且_icc_保全() {
        let path = temp_path("roundtrip.png");
        let doc = sample_doc(Some(fake_icc()));
        encode_image_file(&doc, &path, SaveFormat::Png, 0).expect("PNG 编码写盘");

        // 「打开」：真实磁盘文件 → 真实 png 解码管线
        let reopened = decode_image_file(&path).expect("重新打开");
        assert_eq!((reopened.width, reopened.height), (64, 64));
        // PNG 无损：逐字节相等
        assert_eq!(
            reopened.pixels.as_raw(), doc.pixels.as_raw(),
            "PNG 往返必须像素无损"
        );
        // 元数据保全：iCCP 原样写回、原样读出
        assert_eq!(reopened.icc_profile.as_deref(), Some(fake_icc().as_slice()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn jpeg_往返_尺寸精确_象限中心色在容差内_icc_保全() {
        let path = temp_path("roundtrip.jpg");
        let doc = sample_doc(Some(fake_icc()));
        encode_image_file(&doc, &path, SaveFormat::Jpeg, 90).expect("JPEG 编码写盘");

        let reopened = decode_image_file(&path).expect("重新打开");
        assert_eq!((reopened.width, reopened.height), (64, 64), "尺寸必须精确保持");
        // JPEG 有损：象限中心（(16,16)/(48,16)/(16,48)/(48,48)）色在容差内
        for (x, y, expect) in [
            (16u32, 16u32, [255u8, 0, 0, 255]),
            (48, 16, [0, 255, 0, 255]),
            (16, 48, [0, 0, 255, 255]),
            (48, 48, [255, 255, 255, 255]),
        ] {
            let px = reopened.pixels.get_pixel(x, y).0;
            assert_channel_close(px, expect, 16, &format!("象限中心 ({x},{y})"));
        }
        // JPEG 无 alpha：解码后统一补不透明
        for px in reopened.pixels.pixels() {
            assert_eq!(px.0[3], 255, "JPEG 往返后 alpha 应统一为不透明");
        }
        // APP2 ICC 往返
        assert_eq!(reopened.icc_profile.as_deref(), Some(fake_icc().as_slice()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 打开_不存在路径与坏文件_返回错误而非崩溃() {
        let missing = temp_path("不存在.png");
        let err = decode_image_file(&missing).expect_err("不存在路径必须报错");
        assert!(err.contains("无法打开文件"), "错误信息应可读：{err}");

        let garbage = temp_path("garbage.png");
        std::fs::write(&garbage, b"this is definitely not an image").expect("写测试文件");
        let err = decode_image_file(&garbage).expect_err("非图像内容必须报错");
        assert!(!err.is_empty());
        let _ = std::fs::remove_file(&garbage);
    }

    #[test]
    fn 注册表_多文档_id_互异_摘除后访问报错() {
        let docs = Documents::new();
        let a = docs.insert(sample_doc(None));
        let b = docs.insert(sample_doc(None));
        assert_ne!(a, b, "两个文档的 id 必须互异（多标签画布的前提）");

        // 像素经注册表可取（get_pixels 命令的内核路径）
        let len = docs
            .with_doc(a, |doc| doc.pixels.as_raw().len())
            .expect("登记后可访问");
        assert_eq!(len, 64 * 64 * 4, "RGBA8 字节长度应为 w*h*4");

        assert!(docs.remove(a), "摘除已存在的文档应返回 true");
        assert!(
            docs.with_doc(a, |_| ()).is_err(),
            "摘除后再访问应报错（get_pixels 同路径）"
        );
        assert!(!docs.remove(a), "重复摘除应返回 false");
    }

    #[test]
    fn 保存格式_只收_png_jpeg() {
        assert_eq!(SaveFormat::parse("png"), Ok(SaveFormat::Png));
        assert_eq!(SaveFormat::parse("JPEG"), Ok(SaveFormat::Jpeg));
        assert_eq!(SaveFormat::parse("jpg"), Ok(SaveFormat::Jpeg));
        assert!(SaveFormat::parse("webp").is_err(), "M1 范围外格式应拒绝");
    }
}
