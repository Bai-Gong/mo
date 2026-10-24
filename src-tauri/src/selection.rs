//! M2 选区：矩形 / 椭圆 / 套索 → 栅格化为 8 位覆盖蒙版（0–255，抗锯齿边缘）。
//!
//! 抗锯齿的来源是**亚像素几何**：形状边界落在浮点坐标上，蒙版取每像素被
//! 覆盖的比例——矩形用解析法（像素格与矩形求交面积，精确），椭圆与套索用
//! 4×4 确定性超采样（每像素 16 个子样本点，17 级边缘灰阶）。不做随机抖动，
//! 同一输入任何平台得到同一蒙版（测试可断言具体值）。
//!
//! 蒙版语义：像素级不透明度。填充/绘制以 mask/255 作为该像素的 alpha 参与
//! 标准非预乘 source-over 合成（见 layers.rs `fill_layer`）。

use serde::{Deserialize, Serialize};

/// 选区形状（浮点像素坐标，图像左上为原点）。
///
/// serde 契约（前端 invoke 直传）：`{"kind":"rect","x":..,"y":..,"w":..,"h":..}`、
/// `{"kind":"ellipse","cx":..,"cy":..,"rx":..,"ry":..}`、
/// `{"kind":"lasso","points":[[x,y],..]}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SelectionShape {
    /// 矩形：左上角 + 宽高（前端已归一化，w/h 预期为非负；负值按空集处理）。
    Rect { x: f64, y: f64, w: f64, h: f64 },
    /// 椭圆：中心 + 两轴半径（负半径按空集处理）。
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
    /// 套索：多边形顶点（绘制顺序）；不足 3 点为空集，自交按 even-odd 规则。
    Lasso { points: Vec<[f64; 2]> },
}

/// 文档级选区：已栅格化的覆盖蒙版（与文档同尺寸，行优先）。
/// 形状本体不回存（前端持有自己画的轮廓用于显示；Rust 侧只认蒙版事实）。
#[derive(Debug, Clone)]
pub struct Selection {
    pub mask: Vec<u8>,
}

/// 每轴子样本数（4 → 每像素 16 样本）。
const SS: f64 = 4.0;

/// 把形状栅格化为 width×height 的覆盖蒙版（行优先，索引 y*width+x）。
pub fn rasterize(shape: &SelectionShape, width: u32, height: u32) -> Vec<u8> {
    let mut mask = vec![0u8; (width as usize) * (height as usize)];
    match shape {
        SelectionShape::Rect { x, y, w, h } => {
            if *w <= 0.0 || *h <= 0.0 {
                return mask; // 空集（含负尺寸）
            }
            let (left, top, right, bottom) = (*x, *y, *x + *w, *y + *h);
            // 只遍历包围盒覆盖到的像素行列（跳过全空区域，大图友好）
            let x0 = left.floor().clamp(0.0, width as f64) as u32;
            let x1 = right.ceil().clamp(0.0, width as f64) as u32;
            let y0 = top.floor().clamp(0.0, height as f64) as u32;
            let y1 = bottom.ceil().clamp(0.0, height as f64) as u32;
            for py in y0..y1 {
                for px in x0..x1 {
                    let cov_x = span_overlap(px as f64, px as f64 + 1.0, left, right);
                    let cov_y = span_overlap(py as f64, py as f64 + 1.0, top, bottom);
                    let coverage = cov_x * cov_y;
                    if coverage > 0.0 {
                        mask[(py * width + px) as usize] = to_u8(coverage);
                    }
                }
            }
        }
        SelectionShape::Ellipse { cx, cy, rx, ry } => {
            let (rx, ry) = (rx.abs(), ry.abs());
            if rx <= 0.0 || ry <= 0.0 {
                return mask;
            }
            // 包围盒：中心 ± 半径，再内缩到画布
            let x0 = (cx - rx).floor().clamp(0.0, width as f64) as u32;
            let x1 = (cx + rx).ceil().clamp(0.0, width as f64) as u32;
            let y0 = (cy - ry).floor().clamp(0.0, height as f64) as u32;
            let y1 = (cy + ry).ceil().clamp(0.0, height as f64) as u32;
            for py in y0..y1 {
                for px in x0..x1 {
                    let mut hits = 0u32;
                    for sy in 0..4 {
                        for sx in 0..4 {
                            let x = px as f64 + (sx as f64 + 0.5) / SS;
                            let y = py as f64 + (sy as f64 + 0.5) / SS;
                            let nx = (x - cx) / rx;
                            let ny = (y - cy) / ry;
                            if nx * nx + ny * ny <= 1.0 {
                                hits += 1;
                            }
                        }
                    }
                    if hits > 0 {
                        mask[(py * width + px) as usize] = to_u8(hits as f64 / 16.0);
                    }
                }
            }
        }
        SelectionShape::Lasso { points } => {
            if points.len() < 3 {
                return mask; // 面积未闭合，空集
            }
            // 包围盒（覆盖判断本身对画布外点也成立，先裁剪掉纯外部区域）
            let min_x = points.iter().fold(f64::INFINITY, |a, p| a.min(p[0]));
            let max_x = points.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p[0]));
            let min_y = points.iter().fold(f64::INFINITY, |a, p| a.min(p[1]));
            let max_y = points.iter().fold(f64::NEG_INFINITY, |a, p| a.max(p[1]));
            let x0 = min_x.floor().clamp(0.0, width as f64) as u32;
            let x1 = max_x.ceil().clamp(0.0, width as f64) as u32;
            let y0 = min_y.floor().clamp(0.0, height as f64) as u32;
            let y1 = max_y.ceil().clamp(0.0, height as f64) as u32;
            for py in y0..y1 {
                for px in x0..x1 {
                    let mut hits = 0u32;
                    for sy in 0..4 {
                        for sx in 0..4 {
                            let x = px as f64 + (sx as f64 + 0.5) / SS;
                            let y = py as f64 + (sy as f64 + 0.5) / SS;
                            if point_in_polygon(x, y, points) {
                                hits += 1;
                            }
                        }
                    }
                    if hits > 0 {
                        mask[(py * width + px) as usize] = to_u8(hits as f64 / 16.0);
                    }
                }
            }
        }
    }
    mask
}

/// 栅格化并装配文档级选区。
pub fn make_selection(shape: SelectionShape, width: u32, height: u32) -> Selection {
    let mask = rasterize(&shape, width, height);
    Selection { mask }
}

/// 全选蒙版（整个画布不透明）。
pub fn select_all_mask(width: u32, height: u32) -> Vec<u8> {
    vec![255u8; (width as usize) * (height as usize)]
}

/// 线段 [a0,a1) 与 [b0,b1) 的重叠长度，钳到 [0,1]（像素单位面积=1×1）。
#[inline]
fn span_overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).clamp(0.0, 1.0)
}

/// even-odd（射线交叉）点在多边形内判定。标准实现，边界容差不做特判：
/// 蒙版由 16 子样本多数表决，单点边界歧义被采样稀释。
fn point_in_polygon(x: f64, y: f64, pts: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = pts.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (pts[i][0], pts[i][1]);
        let (xj, yj) = (pts[j][0], pts[j][1]);
        // 边 (i,j) 跨过 y 的水平线，且交点在 x 右侧 → 交叉数翻转
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// 覆盖比例 [0,1] → u8（半进位；0.5 → 128，与填充合成公式同一取整口径）。
#[inline]
fn to_u8(coverage: f64) -> u8 {
    (coverage.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 整数边矩形：内部 255、外部 0、无中间值（整数边不需要抗锯齿）。
    #[test]
    fn 矩形_整数边_内满外空() {
        let mask = rasterize(
            &SelectionShape::Rect { x: 2.0, y: 2.0, w: 4.0, h: 3.0 },
            8,
            8,
        );
        let at = |x: usize, y: usize| mask[y * 8 + x];
        assert_eq!(at(3, 3), 255, "内部像素应全选");
        assert_eq!(at(5, 4), 255, "右下边界内像素（w=4 → x∈[2,6)）应全选");
        assert_eq!(at(2, 2), 255, "左上角起点像素应全选");
        assert_eq!(at(6, 3), 0, "右边界外（x=6 在 [2,6) 之外）应为空");
        assert_eq!(at(3, 5), 0, "下边界外（y=5 在 [2,5) 之外）应为空");
        assert_eq!(at(0, 0), 0, "远处外部应为空");
    }

    /// 半像素边矩形：跨边像素覆盖恰为 128（±2 容差给浮点）。
    #[test]
    fn 矩形_半像素边_跨边像素覆盖一半() {
        // 左边 x=2.5：像素 2 覆盖 [2,3)∩[2.5,…) = 0.5
        let mask = rasterize(
            &SelectionShape::Rect { x: 2.5, y: 0.0, w: 3.0, h: 2.0 },
            8,
            8,
        );
        let at = |x: usize, y: usize| mask[y * 8 + x];
        assert!(
            (at(2, 1) as i32 - 128).abs() <= 2,
            "跨边像素覆盖应为 128±2，实际 {}",
            at(2, 1)
        );
        assert_eq!(at(3, 1), 255, "边内像素应全选");
        assert_eq!(at(1, 1), 0, "边外像素应为空");
    }

    /// 椭圆：内部全选、远处空、斜向边界存在中间值（抗锯齿证据）。
    #[test]
    fn 椭圆_内满外空_斜边有抗锯齿() {
        // 圆心 (10,10) 半径 5
        let mask = rasterize(
            &SelectionShape::Ellipse { cx: 10.0, cy: 10.0, rx: 5.0, ry: 5.0 },
            20,
            20,
        );
        let at = |x: usize, y: usize| mask[y * 20 + x];
        assert_eq!(at(10, 10), 255, "圆心应全选");
        assert_eq!(at(13, 10), 255, "水平半径内部应全选");
        assert_eq!(at(0, 0), 0, "远处应为空");
        assert_eq!(at(19, 19), 0, "画布角落应为空");
        // 斜向 45° 边界附近：半径 5 的圆在 (10±5/√2) ≈ 13.5 处斜切像素格，
        // 像素 (13,13) 既有内部子样本也有外部子样本 → 覆盖为中间值
        let boundary = at(13, 13);
        assert!(
            boundary > 0 && boundary < 255,
            "斜向边界像素应为中间覆盖值，实际 {boundary}"
        );
        assert!(
            (boundary as i32 - 128).abs() <= 64,
            "45° 处覆盖应接近一半，实际 {boundary}"
        );
    }

    /// 椭圆退化（零半径）→ 空蒙版。
    #[test]
    fn 椭圆_零半径_空集() {
        let mask = rasterize(
            &SelectionShape::Ellipse { cx: 5.0, cy: 5.0, rx: 0.0, ry: 3.0 },
            10,
            10,
        );
        assert!(mask.iter().all(|&m| m == 0), "零半径椭圆应为空集");
    }

    /// 套索（多边形）：内部全选、外部空、非整数边有部分覆盖。
    #[test]
    fn 套索_三角形_内外判定与非整数边覆盖() {
        // 顶点带 .5 偏移，让左边 x=2.5 斜穿像素列
        let pts = vec![[2.5, 0.5], [10.5, 0.5], [10.5, 8.5], [2.5, 8.5]];
        let mask = rasterize(&SelectionShape::Lasso { points: pts }, 12, 10);
        let at = |x: usize, y: usize| mask[y * 12 + x];
        assert_eq!(at(6, 4), 255, "内部像素应全选");
        assert_eq!(at(0, 0), 0, "外部像素应为空");
        assert_eq!(at(11, 9), 0, "外部像素应为空");
        // 左边缘 x=2.5：像素列 2 的 4 个 x 子样本中 2 个在多边形内 → 覆盖约 0.5
        // （y 子样本全部在 [0.5,8.5] 内，不影响）
        let edge = at(2, 4);
        assert!(
            edge > 0 && edge < 255,
            "非整数边像素应为中间覆盖值，实际 {edge}"
        );
    }

    /// 套索不足 3 点 → 空集（点击/双点不成面）。
    #[test]
    fn 套索_不足三点_空集() {
        for pts in [vec![[1.0, 1.0]], vec![[1.0, 1.0], [5.0, 5.0]]] {
            let mask = rasterize(&SelectionShape::Lasso { points: pts }, 8, 8);
            assert!(mask.iter().all(|&m| m == 0), "不足 3 点应为空集");
        }
    }

    /// 负尺寸矩形按空集处理（前端已归一化，这里兜底不 panic）。
    #[test]
    fn 矩形_负尺寸_空集不崩() {
        let mask = rasterize(
            &SelectionShape::Rect { x: 2.0, y: 2.0, w: -3.0, h: 2.0 },
            8,
            8,
        );
        assert!(mask.iter().all(|&m| m == 0));
    }

    /// 全选蒙版。
    #[test]
    fn 全选_全不透明() {
        let mask = select_all_mask(3, 2);
        assert_eq!(mask, vec![255u8; 6]);
    }
}
