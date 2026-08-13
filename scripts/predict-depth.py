"""Generate photo-only metric depth for the bundled Nutrition5k benchmark plates.

This is an experiment, not the production inference service. It uses the compact
Depth Anything V2 metric-indoor checkpoint so it can run on a CPU-only machine.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForDepthEstimation


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "benchmark" / "nutrition5k"
MODEL_ID = "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf"


def colorize_depth(depth_m: np.ndarray) -> np.ndarray:
    valid = np.isfinite(depth_m) & (depth_m > 0)
    if not valid.any():
        return np.zeros((*depth_m.shape, 3), dtype=np.uint8)
    low, high = np.percentile(depth_m[valid], [1, 99])
    normalized = np.clip((depth_m - low) / max(high - low, 1e-6), 0, 1)
    return cv2.applyColorMap((normalized * 255).astype(np.uint8), cv2.COLORMAP_JET)


def depth_metrics(predicted_m: np.ndarray, truth_path: Path) -> dict[str, float]:
    truth_m = cv2.imread(str(truth_path), cv2.IMREAD_UNCHANGED).astype(np.float32) / 10_000.0
    valid = np.isfinite(predicted_m) & (truth_m > 0) & (truth_m < 0.45)
    prediction = predicted_m[valid]
    truth = truth_m[valid]
    absolute = np.abs(prediction - truth)
    scale = float(np.median(truth) / max(np.median(prediction), 1e-6))
    aligned = prediction * scale
    return {
        "validPixels": int(valid.sum()),
        "maeMeters": float(absolute.mean()),
        "rmseMeters": float(np.sqrt(np.mean((prediction - truth) ** 2))),
        "absoluteRelativeError": float(np.mean(absolute / truth)),
        "medianScaleCorrection": scale,
        "scaleAlignedMaeMeters": float(np.mean(np.abs(aligned - truth))),
        "predictedMedianMeters": float(np.median(prediction)),
        "truthMedianMeters": float(np.median(truth)),
    }


def main() -> None:
    processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForDepthEstimation.from_pretrained(MODEL_ID)
    model.eval()
    summaries: list[dict[str, object]] = []

    for rgb_path in sorted(DATA.glob("dish_*-rgb.png")):
        dish_id = rgb_path.name.removeprefix("dish_").removesuffix("-rgb.png")
        truth_path = DATA / f"dish_{dish_id}-depth-raw.png"
        if not truth_path.exists():
            continue

        image = Image.open(rgb_path).convert("RGB")
        inputs = processor(images=image, return_tensors="pt")
        started = time.perf_counter()
        with torch.inference_mode():
            outputs = model(**inputs)
        result = processor.post_process_depth_estimation(
            outputs, target_sizes=[(image.height, image.width)]
        )[0]
        predicted = result["predicted_depth"].detach().cpu().numpy().astype(np.float32)
        latency = time.perf_counter() - started

        np.save(DATA / f"dish_{dish_id}-depth-predicted.npy", predicted)
        cv2.imwrite(str(DATA / f"dish_{dish_id}-depth-predicted.png"), colorize_depth(predicted))
        metrics = depth_metrics(predicted, truth_path)
        summary = {
            "dishId": dish_id,
            "model": MODEL_ID,
            "latencySeconds": latency,
            **metrics,
        }
        (DATA / f"dish_{dish_id}-depth-predicted.json").write_text(
            json.dumps(summary, indent=2), encoding="utf-8"
        )
        summaries.append(summary)
        print(json.dumps(summary), flush=True)

    aggregate = {
        "model": MODEL_ID,
        "cases": len(summaries),
        "meanMaeMeters": float(np.mean([row["maeMeters"] for row in summaries])),
        "meanAbsoluteRelativeError": float(np.mean([row["absoluteRelativeError"] for row in summaries])),
        "meanScaleAlignedMaeMeters": float(np.mean([row["scaleAlignedMaeMeters"] for row in summaries])),
        "meanLatencySeconds": float(np.mean([row["latencySeconds"] for row in summaries])),
    }
    (DATA / "predicted-depth-summary.json").write_text(
        json.dumps({"aggregate": aggregate, "cases": summaries}, indent=2), encoding="utf-8"
    )
    print(json.dumps({"aggregate": aggregate}), flush=True)


if __name__ == "__main__":
    main()
