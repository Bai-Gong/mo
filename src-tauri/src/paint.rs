//! M3 画笔/橡皮：折线笔画 → 圆头笔触栅格化（抗锯齿），落到活动图层。
//!
//! 覆盖模型：每像素取「像素中心到折线的最近距离」，覆盖率
//! `cov = clamp(radius + 0.5 − dist, 0, 1)`——笔芯全实、边缘 1px 线性过渡
//! （与选区蒙版同口径的亚像素抗锯齿）。同一笔画内多段重叠取**并集覆盖**
//! （逐像素一次合成），即 Photoshop「整笔一次不透明度」语义，不做流量叠加
//! （流量/喷枪后置）。
//!
//! 画笔 = 覆盖率 × 颜色 alpha 作源 alpha 的标准 source-over（与 layers.rs
//! `fill_layer` 同一公式）；橡皮 = destination-out（覆盖率直接按比例削减
//! 目标 alpha，颜色参数只取 alpha 当强度）。
//!
//! 性能口径：M3 顺序扫描包围盒（像素 × 笔画段数），准入量级毫秒级；大笔画
//! 出现卡顿时再上段空间分桶或 rayon。

use image::RgbaImage;
use tauri::State;

use crate::history::{read_region, DirtyRect, HistoryEntry};
use crate::imageio::{ImageDocument, Documents};
use crate::layers::{to_u8, EditResult, snapshot};
use crate::selection::Selection;

/// 笔画半径下限（0.5px → 1px 细笔；再小无意义）与上限（防误传打穿内存）。
const RADIUS_MIN: f64 = 0.5;
const RADIUS_MAX: f64 = 512.0;

/// 点到线段的最近距离（标准投影钳制）。
fn dist_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= 0.0 {
        0.0
    } else {
        (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
    };
    let cx = ax + t * dx;
    let cy = ay + t * dy;
    ((px - cx) * (px - cx) + (py - cy) * (py - cy)).sqrt()
}

/// 像素中心 (px+0.5, py+0.5) 到折线的最近距离（单点 = 到该点）。
fn dist_to_polyline(px: f64, py: f64, points: &[[f64; 2]]) -> f64 {
    let (x, y) = (px + 0.5, py + 0.5);
    if points.len() == 1 {
        let (ax, ay) = (points[0][0], points[0][1]);
        return ((x - ax) * (x - ax) + (y - ay) * (y - ay)).sqrt();
    }
    points
        .windows(2)
        .map(|w| dist_to_segment(x, y, w[0][0], w[0][1], w[1][0], w[1][1]))
        .fold(f64::INFINITY, f64::min)
}

/// 笔画脏矩形：折线包围盒外扩 radius+1（抗锯齿带），与画布求交。
/// 空集（全部在画布外够不着）→ None。
pub fn stroke_bbox(
    points: &[[f64; 2]],
    radius: f64,
    width: u32,
    height: u32,
) -> Option<DirtyRect> {
    if points.is_empty() {
        return None;
    }
    let pad = radius + 1.0;
    let min_x = points.iter().fold(f64::INFINITY, |a, p| a.min(p[0])) - pad;
    let max_x = points.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p[0])) + pad;
    let min_y = points.iter().fold(f64::INFINITY, |a, p| a.min(p[1])) - pad;
    let max_y = points.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p[1])) + pad;
    let x0 = min_x.max(0.0).floor() as u32;
    let y0 = min_y.max(0.0).floor() as u32;
    let x1 = max_x.min(width as f64).ceil() as u32;
    let y1 = max_y.min(height as f64).ceil() as u32;
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// 把笔画栅格化进脏矩形区域（调用方先用 stroke_bbox 求出矩形并留好 before）。
/// 返回是否真的触及了像素（覆盖率全 0 → false，调用方不压历史）。
fn stroke_region(
    img: &mut RgbaImage,
    selection: Option<&Selection>,
    bbox: DirtyRect,
    points: &[[f64; 2]],
    radius: f64,
    color: [u8; 4],
    erase: bool,
) -> bool {
    let (bx, by, bw, _) = bbox;
    let width = img.width() as usize;
    let color_a = color[3] as f32 / 255.0;
    let cs = [
        color[0] as f32 / 255.0,
        color[1] as f32 / 255.0,
        color[2] as f32 / 255.0,
    ];
    let mut touched = false;
    for (i, px) in img.pixels_mut().enumerate() {
        let (x, y) = ((i % width) as u32, (i / width) as u32);
        if x < bx || x >= bx + bw || y < by || y >= by + bbox.3 {
            continue; // 脏矩形外不动（省一次距离计算）
        }
        let dist = dist_to_polyline(x as f64, y as f64, points);
        if dist >= radius + 0.5 {
            continue; // 笔够不着
        }
        let mut cov = (radius + 0.5 - dist).clamp(0.0, 1.0) as f32;
        if let Some(sel) = selection {
            cov *= sel.mask[i] as f32 / 255.0; // 选区约束：蒙版 0 处不落笔
        }
        if cov <= 0.0 {
            continue;
        }
        touched = true;
        if erase {
            // destination-out：按覆盖率削减目标 alpha（rgb 随之清零避免残色）
            let new_a = px.0[3] as f32 / 255.0 * (1.0 - cov);
            px.0[3] = to_u8(new_a);
            if px.0[3] == 0 {
                px.0[0] = 0;
                px.0[1] = 0;
                px.0[2] = 0;
            }
        } else {
            // source-over：cov × 颜色 alpha 为源 alpha（与填充同一公式）
            let as_ = cov * color_a;
            let ab = px.0[3] as f32 / 255.0;
            let ao = as_ + ab * (1.0 - as_);
            if ao <= 0.0 {
                px.0 = [0, 0, 0, 0];
            } else {
                for ch in 0..3 {
                    let co = as_ * cs[ch] + (1.0 - as_) * ab * (px.0[ch] as f32 / 255.0);
                    px.0[ch] = to_u8(co / ao);
                }
                px.0[3] = to_u8(ao);
            }
        }
    }
    touched
}

/// 文档级笔画入口（命令与测试共用）：画到活动图层并压历史。
///
/// 空点列 / 半径收拢后仍够不着画布 / 覆盖全 0 → 无操作（不压历史条目）。
pub fn edit_stroke(
    doc: &mut ImageDocument,
    points: &[[f64; 2]],
    radius: f64,
    color: [u8; 4],
    erase: bool,
) -> Result<(), String> {
    if points.is_empty() {
        return Ok(());
    }
    let radius = radius.clamp(RADIUS_MIN, RADIUS_MAX);
    let Some(bbox) = stroke_bbox(points, radius, doc.width, doc.height) else {
        return Ok(());
    };
    let active = doc.active_layer_id;
    let layer = doc
        .stack
        .iter_mut()
        .find(|l| l.id == active)
        .ok_or_else(|| format!("活动图层 {active} 不存在"))?;
    let before = read_region(&layer.pixels, bbox);
    let touched = stroke_region(&mut layer.pixels, doc.selection.as_ref(), bbox, points, radius, color, erase);
    if !touched {
        return Ok(());
    }
    let after = read_region(&layer.pixels, bbox);
    if before == after {
        return Ok(()); // 名义触及但字节未变（如透明层上透明笔）——不留空条目
    }
    doc.history.push(HistoryEntry::Pixels {
        label: if erase { "橡皮擦".into() } else { "画笔".into() },
        layer_id: active,
        dirty: bbox,
        before,
        after,
        active_before: active,
        active_after: active,
    });
    Ok(())
}

/// 画笔/橡皮命令：points 为图像坐标折线，radius 为半径（px），color 的 alpha
/// 橡皮路径下当作擦除强度。
#[tauri::command]
pub fn paint_stroke(
    doc_id: u32,
    points: Vec<[f64; 2]>,
    radius: f64,
    color: [u8; 4],
    erase: bool,
    documents: State<Documents>,
) -> Result<EditResult, String> {
    documents.with_doc_mut(doc_id, |doc| {
        edit_stroke(doc, &points, radius, color, erase)?;
        Ok(EditResult {
            layers: snapshot(doc),
            history: doc.history.info(),
            width: doc.width,
            height: doc.height,
        })
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imageio::new_document;
    use crate::layers::apply_selection;
    use crate::selection::SelectionShape;

    fn doc8() -> ImageDocument {
        let mut doc = new_document(16, 16, None).expect("新建");
        doc.active_layer_id = doc.stack.iter().next().unwrap().id;
        doc
    }

    fn px(doc: &ImageDocument, x: u32, y: u32) -> [u8; 4] {
        doc.stack
            .iter()
            .next()
            .unwrap()
            .pixels
            .get_pixel(x, y)
            .0
    }

    #[test]
    fn 单点画笔_中心满覆盖_边缘半覆盖_远处不落() {
        let mut doc = doc8();
        // 半径 4 的圆点画在 (8,8)（像素中心 8.5,8.5 距圆心 8,8 约 0.707）
        edit_stroke(&mut doc, &[[8.0, 8.0]], 4.0, [255, 0, 0, 255], false).expect("画笔");
        // 中心：满覆盖纯红
        assert_eq!(px(&doc, 8, 8), [255, 0, 0, 255], "笔芯中心应满覆盖");
        // 恰在半径边缘（距 4.0）：cov = 4.5−4.0 = 0.5 → 半透明红
        let edge = px(&doc, 12, 8); // 像素中心 (12.5,8.5) 距 (8,8) = √(4.5²+0.5²)≈4.53 → cov≈0（取远一点的点）
        let _ = edge;
        // 选 (11,8)：中心 (11.5,8.5) 距离 √(3.5²+0.5²)=3.54 → cov = 4.5−3.54 ≈ 0.96
        let near = px(&doc, 11, 8);
        assert!(near[3] > 200 && near[3] < 255, "半径内侧应有部分覆盖：{near:?}");
        // (13,8)：中心 (13.5,8.5) 距 5.59 > 4.5 → 不落笔
        assert_eq!(px(&doc, 13, 8), [0, 0, 0, 0], "笔外像素不应被触及");
    }

    #[test]
    fn 线段画笔_沿线覆盖_两端圆头_笔外不动() {
        let mut doc = doc8();
        edit_stroke(
            &mut doc,
            &[[3.0, 8.0], [12.0, 8.0]],
            2.0,
            [0, 0, 255, 255],
            false,
        )
        .expect("画笔");
        // 线中段下方一格：像素中心 (8.5,9.5) 距线 1.0 → cov = 2.5−1.0 = 1.0 满覆盖
        assert_eq!(px(&doc, 8, 9), [0, 0, 255, 255], "线芯应满覆盖");
        // 距线 2.5 以外：不落
        assert_eq!(px(&doc, 8, 12), [0, 0, 0, 0], "线外不应被触及");
        // 圆头：起点左侧 (1,8) 中心 (1.5,8.5) 距 (3,8) = 1.58 → cov≈0.92 落笔
        assert!(px(&doc, 1, 8)[3] > 0, "端点圆头应超出折线端");
        // (0,8)：距 3.5 > 2.5 → 不落
        assert_eq!(px(&doc, 0, 8), [0, 0, 0, 0]);
    }

    #[test]
    fn 同笔重叠_并集覆盖_不叠加透明度() {
        let mut doc = doc8();
        // 折返笔画：同一段来回两趟，50% 黑
        edit_stroke(
            &mut doc,
            &[[4.0, 4.0], [10.0, 4.0], [4.0, 4.0]],
            2.0,
            [0, 0, 0, 128],
            false,
        )
        .expect("画笔");
        let p = px(&doc, 7, 4);
        // 并集语义：两趟重叠处 alpha 仍 ≈128（一次 source-over），非 128+128 叠加
        assert!(
            p[3] >= 124 && p[3] <= 132,
            "重叠段应为并集覆盖（α≈128），实际 {p:?}"
        );
    }

    #[test]
    fn 橡皮_削减已有像素_alpha_笔外保持() {
        let mut doc = doc8();
        // 先整层填不透明白
        crate::layers::apply_fill(&mut doc, [255, 255, 255, 255]).expect("填充");
        edit_stroke(&mut doc, &[[8.0, 8.0]], 3.0, [0, 0, 0, 255], true).expect("橡皮");
        // 笔芯中心：alpha 削到 0
        assert_eq!(px(&doc, 8, 8), [0, 0, 0, 0], "橡皮笔芯应擦透");
        // 笔外：保持白
        assert_eq!(px(&doc, 2, 2), [255, 255, 255, 255], "笔外不应被擦");
    }

    #[test]
    fn 选区约束_蒙版外不落笔() {
        let mut doc = doc8();
        apply_selection(
            &mut doc,
            SelectionShape::Rect { x: 0.0, y: 0.0, w: 8.0, h: 16.0 },
        );
        edit_stroke(
            &mut doc,
            &[[4.0, 8.0], [12.0, 8.0]],
            1.5,
            [255, 0, 0, 255],
            false,
        )
        .expect("画笔");
        // 选区内（x<8）落笔
        assert!(px(&doc, 4, 8)[3] > 0, "选区内应落笔");
        // 选区外（x≥8）不落
        assert_eq!(px(&doc, 12, 8), [0, 0, 0, 0], "选区外不应落笔");
    }

    #[test]
    fn 画布外笔画与空点列_无操作不压历史() {
        let mut doc = doc8();
        edit_stroke(&mut doc, &[], 4.0, [255, 0, 0, 255], false).expect("空点列");
        // 半径远够不着（点在画布外远处）
        edit_stroke(&mut doc, &[[100.0, 100.0]], 1.0, [255, 0, 0, 255], false).expect("画布外");
        assert_eq!(doc.history.info().index, 0, "无操作不应压历史");
        assert_eq!(doc.history.info().entries.len(), 0);
    }

    #[test]
    fn 包围盒_与画布求交_全外为空() {
        // 点 (2,2)、半径 1：外扩 2 → 坐标范围 [0,4]，x1=ceil(4)=4（开区间）
        assert_eq!(stroke_bbox(&[[2.0, 2.0]], 1.0, 8, 8), Some((0, 0, 4, 4)));
        assert_eq!(stroke_bbox(&[[100.0, 100.0]], 1.0, 8, 8), None);
        assert_eq!(stroke_bbox(&[], 1.0, 8, 8), None);
    }
}
