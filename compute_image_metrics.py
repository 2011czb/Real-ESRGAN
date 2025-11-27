import argparse
import csv
import os
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import cv2
import numpy as np
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

try:
    import torch
except ImportError as exc:  # pragma: no cover
    raise ImportError("torch is required for this script. Please install PyTorch first.") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="计算一个或多个图像对的 PSNR / SSIM / LPIPS 指标"
    )
    parser.add_argument(
        "--before",
        required=True,
        type=Path,
        help="参考图像或目录的路径（通常是原始/低分辨率图像）",
    )
    parser.add_argument(
        "--after",
        required=True,
        type=Path,
        help="处理后图像或目录的路径（通常是增强后的图像）",
    )
    parser.add_argument(
        "--output",
        default=Path("results/image_metrics.csv"),
        type=Path,
        help="存储指标结果的输出CSV文件",
    )
    parser.add_argument(
        "--metrics",
        nargs="+",
        default=["psnr", "ssim", "lpips"],
        choices=["psnr", "ssim", "lpips"],
        help="要计算的指标名称",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="LPIPS计算设备（auto表示在有CUDA时优先使用）",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="递归扫描目录中的图像。文件名必须匹配。",
    )
    parser.add_argument(
        "--extensions",
        nargs="+",
        default=[".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"],
        help="扫描目录时允许的图像扩展名",
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=None,
        help="最大图像尺寸（宽度或高度）。超过此尺寸的图像会被下采样以加速计算。默认不限制。"
        "影响说明：PSNR/SSIM对分辨率较敏感，建议使用2048或更大；LPIPS是感知指标，1024通常足够。"
        "建议值：512(最快，仅LPIPS)、1024(快速，LPIPS为主)、2048(平衡，推荐)、4096(高精度)",
    )
    return parser.parse_args()


def list_images(directory: Path, recursive: bool, suffixes: Sequence[str]) -> Dict[str, Path]:
    files: Dict[str, Path] = {}
    iterator = directory.rglob("*") if recursive else directory.glob("*")
    suffixes_lower = {ext.lower() for ext in suffixes}

    for path in iterator:
        if path.is_file() and path.suffix.lower() in suffixes_lower:
            files[path.name] = path
    return files


def build_pairs(before: Path, after: Path, recursive: bool, suffixes: Sequence[str]) -> List[Tuple[str, Path, Path]]:
    if before.is_file():
        if not after.is_file():
            raise ValueError("当任一路径为文件时，--before 和 --after 必须都是文件")
        if before.name != after.name:
            print(f"[警告] 文件名不同: {before.name} vs {after.name}。仍将计算指标。")
        return [(before.name, before, after)]

    if not after.is_dir():
        raise ValueError("当 --before 是目录时，--after 必须是目录")

    before_map = list_images(before, recursive, suffixes)
    after_map = list_images(after, recursive, suffixes)

    pairs: List[Tuple[str, Path, Path]] = []
    missing_after = []

    for name, ref_path in before_map.items():
        if name not in after_map:
            missing_after.append(name)
            continue
        pairs.append((name, ref_path, after_map[name]))

    if missing_after:
        print(f"[警告] --after 中缺少 {len(missing_after)} 个文件，已跳过: {missing_after[:10]}...")

    if not pairs:
        raise RuntimeError("未找到匹配的图像对。请检查目录和扩展名。")

    return pairs


def load_image(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法读取图像: {path}")
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return img.astype(np.float32)


def _resize_image(img: np.ndarray, target_hw: Tuple[int, int]) -> np.ndarray:
    target_h, target_w = target_hw
    interp = cv2.INTER_LINEAR if img.shape[0] < target_h or img.shape[1] < target_w else cv2.INTER_AREA
    resized = cv2.resize(img, (target_w, target_h), interpolation=interp)
    return resized.astype(np.float32)


def _resize_to_max_size(img: np.ndarray, max_size: int) -> np.ndarray:
    """将图像下采样到最大尺寸，保持宽高比"""
    h, w = img.shape[:2]
    if max(h, w) <= max_size:
        return img

    if h > w:
        new_h = max_size
        new_w = int(w * max_size / h)
    else:
        new_w = max_size
        new_h = int(h * max_size / w)

    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized.astype(np.float32)


def align_shapes(
    ref: np.ndarray,
    test: np.ndarray,
    name: str,
    max_size: int = None,
) -> Tuple[np.ndarray, np.ndarray, Tuple[int, int]]:
    # 如果指定了最大尺寸，先对两个图像进行下采样
    if max_size is not None:
        ref_original_hw = ref.shape[:2]
        test_original_hw = test.shape[:2]
        ref = _resize_to_max_size(ref, max_size)
        test = _resize_to_max_size(test, max_size)
        if ref.shape[:2] != ref_original_hw or test.shape[:2] != test_original_hw:
            print(f"[信息] '{name}': 已将图像下采样到最大尺寸 {max_size} (参考: {ref_original_hw} -> {ref.shape[:2]}, 处理后: {test_original_hw} -> {test.shape[:2]})")

    if ref.shape == test.shape:
        return ref, test, ref.shape[:2]

    ref_hw = ref.shape[:2]
    test_hw = test.shape[:2]
    ref_area = ref_hw[0] * ref_hw[1]
    test_area = test_hw[0] * test_hw[1]

    if ref_area > test_area:
        target_hw = ref_hw
        test = _resize_image(test, target_hw)
        message = f"[信息] '{name}': 已将处理后的图像从 {test_hw} 调整到 {target_hw}"
    else:
        target_hw = test_hw
        ref = _resize_image(ref, target_hw)
        message = f"[信息] '{name}': 已将参考图像从 {ref_hw} 调整到 {target_hw}"

    print(message)
    return ref, test, target_hw


def compute_psnr(ref: np.ndarray, test: np.ndarray) -> float:
    return float(peak_signal_noise_ratio(ref, test, data_range=255))


def compute_ssim(ref: np.ndarray, test: np.ndarray) -> float:
    return float(structural_similarity(ref, test, channel_axis=-1, data_range=255))


def image_to_tensor(img: np.ndarray, device: torch.device) -> torch.Tensor:
    tensor = torch.from_numpy(img).permute(2, 0, 1).unsqueeze(0).to(device)
    tensor = tensor / 255.0 * 2.0 - 1.0
    return tensor


def prepare_lpips_model(device: torch.device):
    import lpips  # 延迟导入；当不需要LPIPS时避免依赖

    loss_fn = lpips.LPIPS(net="alex").to(device)
    loss_fn.eval()
    return loss_fn


def compute_metrics(
    pairs: List[Tuple[str, Path, Path]],
    metrics: Sequence[str],
    device_choice: str,
    max_size: int = None,
) -> Tuple[List[Dict[str, float]], Dict[str, float]]:
    results: List[Dict[str, float]] = []
    if device_choice == "auto":
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        resolved_device = device_choice
        if resolved_device == "cuda" and not torch.cuda.is_available():
            print("[警告] CUDA 不可用，LPIPS 将退回 CPU")
            resolved_device = "cpu"

    device = torch.device(resolved_device)
    lpips_model = None
    if "lpips" in metrics:
        if device.type == "cuda" and not torch.cuda.is_available():
            device = torch.device("cpu")
        lpips_model = prepare_lpips_model(device)

    for name, ref_path, test_path in pairs:
        ref = load_image(ref_path)
        test = load_image(test_path)
        ref, test, _ = align_shapes(ref, test, name, max_size)

        # 使用英文键名存储数据，便于后续计算平均值
        entry: Dict[str, float] = {"image": name}

        if "psnr" in metrics:
            entry["psnr"] = compute_psnr(ref, test)

        if "ssim" in metrics:
            entry["ssim"] = compute_ssim(ref, test)

        if "lpips" in metrics and lpips_model is not None:
            with torch.no_grad():
                ref_t = image_to_tensor(ref, device)
                test_t = image_to_tensor(test, device)
                score = lpips_model(ref_t, test_t)
                entry["lpips"] = float(score.item())

        results.append(entry)

    aggregates: Dict[str, float] = {}
    for metric in metrics:
        key = metric.lower()
        values = [row[key] for row in results if key in row]
        if values:
            # 使用中文键名存储平均值
            if key == "psnr":
                aggregates["平均PSNR"] = float(np.mean(values))
            elif key == "ssim":
                aggregates["平均SSIM"] = float(np.mean(values))
            elif key == "lpips":
                aggregates["平均LPIPS"] = float(np.mean(values))

    return results, aggregates


def write_csv(output_path: Path, rows: List[Dict[str, float]], aggregates: Dict[str, float], metrics: Sequence[str]) -> None:
    os.makedirs(output_path.parent, exist_ok=True)

    # 创建中文表头映射
    metric_headers = {
        "image": "图像文件名",
        "psnr": "PSNR",
        "ssim": "SSIM",
        "lpips": "LPIPS"
    }
    fieldnames = ["图像文件名"] + [metric_headers.get(m.lower(), m.upper()) for m in metrics]

    with open(output_path, "w", newline="", encoding="utf-8") as csvfile:
        dict_writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        dict_writer.writeheader()
        for row in rows:
            # 将英文键映射到中文表头
            mapped_row = {}
            for key, value in row.items():
                if key in metric_headers:
                    mapped_row[metric_headers[key]] = value
            dict_writer.writerow(mapped_row)

        if aggregates:
            csvfile.write("\n")
            plain_writer = csv.writer(csvfile)
            plain_writer.writerow(["指标", "数值"])
            for metric, value in aggregates.items():
                plain_writer.writerow([metric, value])

    print(f"[信息] 指标已保存到 {output_path}")


def main():
    args = parse_args()
    pairs = build_pairs(args.before, args.after, args.recursive, args.extensions)
    rows, aggregates = compute_metrics(pairs, args.metrics, args.device, args.max_size)
    write_csv(args.output, rows, aggregates, args.metrics)


if __name__ == "__main__":
    main()