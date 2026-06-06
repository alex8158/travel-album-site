#!/usr/bin/env python3
"""CLIP image analysis and deduplication CLI tool.

Provides three subcommands:
  analyze        - CLIP classification + OpenCV blur detection for images
  dedup          - CLIP embedding-based duplicate detection with union-find grouping
  clip-neighbors - CLIP embedding top-k neighbor search with three-tier classification

All JSON output goes to stdout. All errors/logs go to stderr.
Exit codes: 0=success, 1=runtime error, 2=model not found.
"""

import argparse
import json
import sys
import time

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Category prompt templates for CLIP zero-shot classification
# ---------------------------------------------------------------------------

CATEGORY_PROMPTS = {
    "people": [
        "a photo of a person",
        "a photo of people",
        "a portrait photo",
        "a group photo of people",
        "a photo of a diver underwater",
        "a photo of a scuba diver",
        "a photo of a snorkeler in the sea",
        "a photo of a swimmer underwater",
        "a photo of a person swimming in the ocean",
        "an underwater photo of a human",
    ],
    "animal": [
        "a photo of an animal",
        "a photo of wildlife in nature",
        "a photo of fish underwater",
        "a photo of marine life underwater",
        "a photo of coral reef creatures",
        "a photo of a sea turtle",
        "a photo of a shark",
        "a photo of a nudibranch",
        "an underwater photo focused on marine animals",
    ],
    "landscape": [
        "a photo of natural scenery",
        "a photo of mountains and sky",
        "a photo of ocean and beach",
        "a photo of underwater scenery without people",
        "a photo of coral reef scenery",
        "a photo of a sunset",
        "a photo of a forest",
    ],
    "other": [
        "a photo of food",
        "a photo of an object",
        "an abstract photo",
        "a photo of text or documents",
    ],
}


# ---------------------------------------------------------------------------
# Union-Find (Disjoint Set) for duplicate grouping
# ---------------------------------------------------------------------------


class UnionFind:
    """Union-Find with path compression and union by rank."""

    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]

    def union(self, x, y):
        px, py = self.find(x), self.find(y)
        if px == py:
            return
        if self.rank[px] < self.rank[py]:
            px, py = py, px
        self.parent[py] = px
        if self.rank[px] == self.rank[py]:
            self.rank[px] += 1


# ---------------------------------------------------------------------------
# Softmax helper
# ---------------------------------------------------------------------------


def softmax(scores):
    """Compute softmax over a list/array of scores.

    Uses the max-subtraction trick for numerical stability.
    Returns a list of floats summing to ~1.0.
    """
    arr = np.array(scores, dtype=np.float64)
    arr = arr - np.max(arr)
    exp_arr = np.exp(arr)
    total = np.sum(exp_arr)
    return (exp_arr / total).tolist()


# ---------------------------------------------------------------------------
# Blur detection (OpenCV CLAHE + Laplacian variance)
# ---------------------------------------------------------------------------


def detect_subject_overexposure(
    image_path,
    v_threshold=245,
    s_threshold=45,
    min_area_ratio=0.006,
    max_area_ratio=0.015,
    severe_total_area_ratio=0.012,
    min_component_pixels=300,
    center_weight=1.5,
    texture_gradient_threshold=5.0,
):
    """Detect overexposed subjects using multi-criteria analysis.

    Detection criteria (ALL must be met for a qualifying region):
    1. HSV V >= v_threshold (very bright)
    2. HSV S <= s_threshold (low saturation / near-white)
    3. Local Sobel gradient std < texture_gradient_threshold (featureless/detail-lost)
    4. Connected component area >= min_component_pixels

    Anti-false-positive guards:
    - Bright sand/seafloor: has texture (gradient > threshold), excluded
    - Water surface reflections: typically small/scattered, fails area threshold
    - Bubbles: small components, fails area threshold
    - Specular highlights: tiny, fails area threshold

    Center weighting: Components overlapping center 60% of image contribute
    center_weight (1.5x) to area ratio.

    Returns dict with severity, subjectOverexposed, largestRegionRatio,
    totalBrightArea, numQualifyingRegions, overexposureReason, qualityPenalty.
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            return {
                "severity": "none",
                "subjectOverexposed": False,
                "largestRegionRatio": None,
                "totalBrightArea": 0.0,
                "numQualifyingRegions": 0,
                "overexposureReason": None,
                "qualityPenalty": 0.0,
            }

        height, width = img.shape[:2]
        total_pixels = height * width

        # Convert to HSV
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        v_channel = hsv[:, :, 2]
        s_channel = hsv[:, :, 1]

        # Criterion 1 & 2: V >= v_threshold AND S <= s_threshold
        bright_mask = (v_channel >= v_threshold) & (s_channel <= s_threshold)

        # Criterion 3: Sobel gradient std < texture_gradient_threshold
        # Compute Sobel gradient magnitude on grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        sobel_x = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
        sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        gradient_magnitude = np.sqrt(sobel_x ** 2 + sobel_y ** 2)

        # Connected component analysis on the bright_mask
        bright_mask_uint8 = bright_mask.astype(np.uint8) * 255
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
            bright_mask_uint8, connectivity=8
        )

        # Define center 60% region
        center_x_start = int(width * 0.2)
        center_x_end = int(width * 0.8)
        center_y_start = int(height * 0.2)
        center_y_end = int(height * 0.8)

        qualifying_regions = []
        largest_region_pixels = 0

        # Skip label 0 (background)
        for label_id in range(1, num_labels):
            component_area = stats[label_id, cv2.CC_STAT_AREA]

            # Criterion 4: minimum component size
            if component_area < min_component_pixels:
                continue

            # Criterion 3: check texture within this component
            # Use eroded mask to exclude boundary pixels (edges have high
            # gradient from the transition, not from internal texture)
            component_mask = (labels == label_id).astype(np.uint8)
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            eroded_mask = cv2.erode(component_mask, kernel, iterations=1)
            interior_pixels = eroded_mask > 0

            # If erosion removes all pixels (very thin component), use original
            if np.sum(interior_pixels) < 10:
                interior_pixels = component_mask > 0

            component_gradients = gradient_magnitude[interior_pixels]
            gradient_std = float(np.std(component_gradients))

            if gradient_std >= texture_gradient_threshold:
                # Textured region — anti-false-positive exclusion
                continue

            # This component qualifies
            # Determine center weighting
            comp_x = stats[label_id, cv2.CC_STAT_LEFT]
            comp_y = stats[label_id, cv2.CC_STAT_TOP]
            comp_w = stats[label_id, cv2.CC_STAT_WIDTH]
            comp_h = stats[label_id, cv2.CC_STAT_HEIGHT]

            # Check if component overlaps with center 60%
            overlaps_center = (
                comp_x < center_x_end
                and (comp_x + comp_w) > center_x_start
                and comp_y < center_y_end
                and (comp_y + comp_h) > center_y_start
            )

            weight = center_weight if overlaps_center else 1.0
            weighted_area = component_area * weight

            qualifying_regions.append({
                "pixels": component_area,
                "weighted_pixels": weighted_area,
                "overlaps_center": overlaps_center,
            })

            if component_area > largest_region_pixels:
                largest_region_pixels = component_area

        num_qualifying = len(qualifying_regions)

        if num_qualifying == 0:
            return {
                "severity": "none",
                "subjectOverexposed": False,
                "largestRegionRatio": None,
                "totalBrightArea": 0.0,
                "numQualifyingRegions": 0,
                "overexposureReason": None,
                "qualityPenalty": 0.0,
            }

        # Compute area ratios
        total_weighted_area = sum(r["weighted_pixels"] for r in qualifying_regions)
        total_area_ratio = total_weighted_area / total_pixels
        largest_region_ratio = largest_region_pixels / total_pixels

        # Check if any single component exceeds max_area_ratio
        any_single_severe = any(
            (r["pixels"] / total_pixels) > max_area_ratio
            for r in qualifying_regions
        )

        # Severity classification
        if total_area_ratio >= severe_total_area_ratio or any_single_severe:
            severity = "severe"
        elif total_area_ratio >= min_area_ratio:
            severity = "mild"
        else:
            severity = "none"

        subject_overexposed = severity in ("mild", "severe")

        # Quality penalty: -0.15 for mild, 0 for none/severe
        if severity == "mild":
            quality_penalty = -0.15
        else:
            quality_penalty = 0.0

        overexposure_reason = (
            "subject_highlight_clipped" if subject_overexposed else None
        )

        return {
            "severity": severity,
            "subjectOverexposed": subject_overexposed,
            "largestRegionRatio": round(float(largest_region_ratio), 6),
            "totalBrightArea": round(float(total_area_ratio), 6),
            "numQualifyingRegions": num_qualifying,
            "overexposureReason": overexposure_reason,
            "qualityPenalty": quality_penalty,
        }

    except Exception as exc:
        print(
            f"Subject overexposure detection failed for {image_path}: {exc}",
            file=sys.stderr,
        )
        return {
            "severity": "none",
            "subjectOverexposed": False,
            "largestRegionRatio": None,
            "totalBrightArea": 0.0,
            "numQualifyingRegions": 0,
            "overexposureReason": None,
            "qualityPenalty": 0.0,
        }


def detect_overexposure(image_path, overexposure_threshold=0.40):
    """Detect overexposure using histogram analysis.

    Computes the fraction of pixels in the high-brightness zone (value > 240)
    across all channels. If this fraction exceeds the threshold, the image is
    classified as overexposed.

    Returns (overexposure_status, overexposure_ratio):
      - 'overexposed' if ratio >= threshold
      - 'normal' otherwise
      - On OpenCV failure returns ('unknown', None)
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            return "unknown", None
        # Convert to grayscale for a single-channel brightness check
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        total_pixels = gray.shape[0] * gray.shape[1]
        # Count pixels with brightness > 240 (near-white)
        overexposed_pixels = int(np.sum(gray > 240))
        ratio = overexposed_pixels / total_pixels if total_pixels > 0 else 0.0

        if ratio >= overexposure_threshold:
            status = "overexposed"
        else:
            status = "normal"
        return status, round(float(ratio), 4)
    except Exception as exc:
        print(f"OpenCV overexposure detection failed for {image_path}: {exc}",
              file=sys.stderr)
        return "unknown", None


def detect_blur(image_path, blur_threshold=15, clear_threshold=50):
    """Detect blur using dual Laplacian variance (with and without CLAHE).

    Uses the MINIMUM of two scores:
    - CLAHE-normalized Laplacian (good for well-lit photos)
    - Plain grayscale Laplacian (good for underwater/low-contrast photos
      where CLAHE inflates noise variance)

    Three-tier classification:
      blur_score < blur_threshold → blurry
      blur_threshold <= blur_score < clear_threshold → suspect
      blur_score >= clear_threshold → clear

    On OpenCV failure returns ('unknown', None).
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            return "unknown", None
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Score 1: CLAHE-normalized (original method)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        normalized = clahe.apply(gray)
        clahe_score = float(cv2.Laplacian(normalized, cv2.CV_64F).var())

        # Score 2: Plain grayscale (catches underwater blur that CLAHE misses)
        plain_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        # Use the lower score — if either method thinks it's blurry, it probably is
        blur_score = min(clahe_score, plain_score)

        if blur_score < blur_threshold:
            blur_status = "blurry"
        elif blur_score < clear_threshold:
            blur_status = "suspect"
        else:
            blur_status = "clear"
        return blur_status, blur_score
    except Exception as exc:
        print(f"OpenCV blur detection failed for {image_path}: {exc}",
              file=sys.stderr)
        return "unknown", None


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------


def load_model(model_dir):
    """Load CLIP model and processor from a local directory.

    Returns (model, processor) tuple.
    Prints to stderr and calls sys.exit(2) if model directory is missing.
    """
    from pathlib import Path

    model_path = Path(model_dir)
    if not model_path.exists():
        print(f"Model directory not found: {model_dir}", file=sys.stderr)
        sys.exit(2)

    # Check for key files that indicate a valid model directory
    has_config = (model_path / "config.json").exists()
    if not has_config:
        print(f"Model config not found in {model_dir}", file=sys.stderr)
        sys.exit(2)

    try:
        from transformers import CLIPModel, CLIPProcessor

        # Try loading as PyTorch model first
        try:
            processor = CLIPProcessor.from_pretrained(model_dir)
            model = CLIPModel.from_pretrained(model_dir)
            model.eval()
            return model, processor
        except Exception:
            pass

        # If ONNX-only export, download PyTorch model using config info
        import json
        config_path = model_path / "config.json"
        with open(config_path) as f:
            config_data = json.load(f)

        # Check if this is an ONNX-only directory (has model.onnx but no pytorch_model.bin)
        has_onnx = (model_path / "model.onnx").exists()
        has_pytorch = (model_path / "pytorch_model.bin").exists() or (model_path / "model.safetensors").exists()

        if has_onnx and not has_pytorch:
            # Load from HuggingFace hub using the model type from config
            model_type = config_data.get("_name_or_path", "openai/clip-vit-base-patch32")
            print(f"ONNX-only directory, loading PyTorch model from {model_type}", file=sys.stderr)
            processor = CLIPProcessor.from_pretrained(model_dir)
            model = CLIPModel.from_pretrained(model_type)
            model.eval()
            # Save PyTorch weights locally for next time
            model.save_pretrained(model_dir)
            return model, processor

        raise Exception("No loadable model found")
    except Exception as exc:
        print(f"Failed to load model from {model_dir}: {exc}",
              file=sys.stderr)
        sys.exit(2)


# ---------------------------------------------------------------------------
# CLIP classification
# ---------------------------------------------------------------------------


def classify_image(image_path, model, processor):
    """Classify a single image using CLIP zero-shot with multi-prompt scoring.

    Steps:
      1. Encode image with CLIP
      2. Encode all prompt texts with CLIP
      3. Compute cosine similarity between image and each prompt
      4. Class-internal max aggregation
      5. Cross-class softmax normalization

    Returns (category, category_scores) or raises on failure.
    """
    import torch
    from PIL import Image

    img = Image.open(image_path).convert("RGB")

    # Build flat list of all prompts and track category boundaries
    all_prompts = []
    category_names = []
    category_boundaries = []  # (start_idx, end_idx) per category
    idx = 0
    for cat_name, prompts in CATEGORY_PROMPTS.items():
        category_names.append(cat_name)
        start = idx
        all_prompts.extend(prompts)
        idx += len(prompts)
        category_boundaries.append((start, idx))

    # Get image features
    image_inputs = processor(images=img, return_tensors="pt")
    with torch.no_grad():
        image_output = model.get_image_features(**image_inputs)
        # Handle both tensor and BaseModelOutputWithPooling returns
        image_features = image_output if isinstance(image_output, torch.Tensor) else image_output.last_hidden_state[:, 0, :]

    # Get text features for all prompts at once
    text_inputs = processor(
        text=all_prompts, return_tensors="pt", padding=True, truncation=True
    )
    with torch.no_grad():
        text_output = model.get_text_features(**text_inputs)
        text_features = text_output if isinstance(text_output, torch.Tensor) else text_output.last_hidden_state[:, 0, :]

    # Normalize embeddings
    image_features = image_features / image_features.norm(
        p=2, dim=-1, keepdim=True
    )
    text_features = text_features / text_features.norm(
        p=2, dim=-1, keepdim=True
    )

    # Cosine similarities: (1, num_prompts)
    similarities = (image_features @ text_features.T).squeeze(0)
    similarities = similarities.cpu().numpy()

    # Class-internal max aggregation
    raw_scores = []
    for start, end in category_boundaries:
        cat_sims = similarities[start:end]
        raw_scores.append(float(np.max(cat_sims)))

    # Cross-class softmax normalization
    category_scores_list = softmax(raw_scores)

    category_scores = {}
    for i, cat_name in enumerate(category_names):
        category_scores[cat_name] = category_scores_list[i]

    # Rule-based decision: people-priority for underwater scenes
    people_score = category_scores.get("people", 0)
    animal_score = category_scores.get("animal", 0)
    landscape_score = category_scores.get("landscape", 0)

    if people_score >= 0.35 and people_score > landscape_score and people_score >= animal_score - 0.03:
        category = "people"
    elif animal_score >= 0.38 and animal_score - people_score >= 0.05:
        category = "animal"
    elif landscape_score >= 0.30:
        category = "landscape"
    else:
        # Fallback to argmax
        best_idx = int(np.argmax(category_scores_list))
        category = category_names[best_idx]

    return category, category_scores


# ---------------------------------------------------------------------------
# CLIP embedding extraction (for dedup)
# ---------------------------------------------------------------------------


def extract_embeddings(image_paths, model, processor):
    """Extract CLIP image embeddings for a list of images.

    Returns a numpy array of shape (N, 512) and a list of error indices.
    Failed images get a zero vector.
    """
    import torch
    from PIL import Image

    embeddings = []
    error_indices = []

    for i, path in enumerate(image_paths):
        try:
            img = Image.open(path).convert("RGB")
            inputs = processor(images=img, return_tensors="pt")
            with torch.no_grad():
                output = model.get_image_features(**inputs)
                # Handle both tensor and BaseModelOutputWithPooling returns
                features = output if isinstance(output, torch.Tensor) else output.last_hidden_state[:, 0, :]
            # Normalize
            features = features / features.norm(p=2, dim=-1, keepdim=True)
            embeddings.append(features.squeeze(0).cpu().numpy())
        except Exception as exc:
            print(f"Embedding extraction failed for {path}: {exc}",
                  file=sys.stderr)
            error_indices.append(i)
            embeddings.append(np.zeros(512, dtype=np.float32))

    return np.array(embeddings), error_indices


# ---------------------------------------------------------------------------
# Dedup: find duplicate groups
# ---------------------------------------------------------------------------


def find_duplicate_groups(embeddings, threshold, error_indices):
    """Find groups of duplicate images based on cosine similarity.

    For ≤500 images: full cosine similarity matrix.
    For >500 images: per-image top-k=50 nearest neighbor search.

    Returns list of (indices, similarities) tuples for each group with ≥2 members.
    """
    n = len(embeddings)
    error_set = set(error_indices)
    uf = UnionFind(n)
    pair_sims = {}  # (i, j) -> similarity where i < j

    # Normalize embeddings (handle zero vectors from errors)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    # Avoid division by zero for error images
    norms = np.where(norms == 0, 1.0, norms)
    normalized = embeddings / norms

    if n <= 500:
        # Full cosine similarity matrix
        sim_matrix = normalized @ normalized.T
        for i in range(n):
            if i in error_set:
                continue
            for j in range(i + 1, n):
                if j in error_set:
                    continue
                sim = float(sim_matrix[i, j])
                if sim > threshold:
                    uf.union(i, j)
                    pair_sims[(i, j)] = sim
    else:
        # Per-image top-k=50 nearest neighbor
        k = min(50, n)
        for i in range(n):
            if i in error_set:
                continue
            sims = normalized[i] @ normalized.T  # (N,)
            # Get top-k indices (excluding self)
            top_k_indices = np.argpartition(sims, -k)[-k:]
            for j in top_k_indices:
                j = int(j)
                if j == i or j in error_set:
                    continue
                sim = float(sims[j])
                if sim > threshold:
                    uf.union(i, j)
                    lo, hi = min(i, j), max(i, j)
                    if (lo, hi) not in pair_sims:
                        pair_sims[(lo, hi)] = sim

    # Collect connected components
    groups_map = {}
    for i in range(n):
        if i in error_set:
            continue
        root = uf.find(i)
        if root not in groups_map:
            groups_map[root] = []
        groups_map[root].append(i)

    # Filter to groups with ≥2 members
    result = []
    for indices in groups_map.values():
        if len(indices) < 2:
            continue
        # Collect similarities for pairs in this group
        group_sims = []
        for a_idx in range(len(indices)):
            for b_idx in range(a_idx + 1, len(indices)):
                lo = min(indices[a_idx], indices[b_idx])
                hi = max(indices[a_idx], indices[b_idx])
                if (lo, hi) in pair_sims:
                    group_sims.append([lo, hi, pair_sims[(lo, hi)]])
        result.append((sorted(indices), group_sims))

    return result


# ---------------------------------------------------------------------------
# Select best image to keep in a duplicate group
# ---------------------------------------------------------------------------


def select_best_to_keep(indices, metadata):
    """Select the best image to keep from a duplicate group.

    Priority: blur_score (highest) → resolution (width*height, highest) → file_size (largest).
    If no metadata available, keep the first image.
    """
    if not metadata:
        return indices[0]

    def sort_key(idx):
        meta = metadata.get(str(idx), {})
        blur = meta.get("blur_score", 0) or 0
        w = meta.get("width", 0) or 0
        h = meta.get("height", 0) or 0
        resolution = w * h
        file_size = meta.get("file_size", 0) or 0
        return (blur, resolution, file_size)

    return max(indices, key=sort_key)


# ---------------------------------------------------------------------------
# Subcommand: analyze
# ---------------------------------------------------------------------------


def _resolve_images(args):
    """Resolve image paths from --images or --images-file."""
    images = args.images or []
    if hasattr(args, 'images_file') and args.images_file:
        with open(args.images_file, 'r') as f:
            images = [
                line.strip() for line in f if line.strip()
            ]
    if not images:
        raise ValueError("No images provided (use --images or --images-file)")
    return images


def cmd_analyze(args):
    """Run CLIP classification + blur detection on a list of images."""
    start_time = time.time()
    args.images = _resolve_images(args)

    # Log received subject overexposure thresholds
    print(
        f"[analyze] overexposure thresholds: V={args.subject_v_threshold}, "
        f"S={args.subject_s_threshold}, minArea={args.min_area_ratio}, "
        f"maxArea={args.max_area_ratio}, "
        f"severeTotalArea={args.severe_total_area_ratio}, "
        f"minComponentPixels={args.min_component_pixels}, "
        f"textureGradient={args.texture_gradient_threshold}",
        file=sys.stderr,
    )

    # Load model
    model_load_start = time.time()
    model, processor = load_model(args.model_dir)
    model_load_time_ms = int((time.time() - model_load_start) * 1000)

    results = []
    for image_path in args.images:
        result = {
            "file": image_path,
            "classify_error": None,
            "blur_error": None,
            "overexposure_error": None,
            "category": None,
            "category_scores": None,
            "blur_status": "unknown",
            "blur_score": None,
            "overexposure_status": "unknown",
            "overexposure_ratio": None,
            "subject_overexposure": None,
        }

        # CLIP classification (independent of blur detection)
        try:
            category, category_scores = classify_image(
                image_path, model, processor
            )
            result["category"] = category
            result["category_scores"] = category_scores
        except Exception as exc:
            print(f"Classification failed for {image_path}: {exc}",
                  file=sys.stderr)
            result["classify_error"] = str(exc)

        # Blur detection (independent of classification)
        try:
            blur_status, blur_score = detect_blur(
                image_path,
                blur_threshold=args.blur_threshold,
                clear_threshold=args.clear_threshold,
            )
            result["blur_status"] = blur_status
            result["blur_score"] = blur_score
        except Exception as exc:
            print(f"Blur detection failed for {image_path}: {exc}",
                  file=sys.stderr)
            result["blur_error"] = str(exc)

        # Overexposure detection (independent of blur and classification)
        try:
            overexposure_status, overexposure_ratio = detect_overexposure(
                image_path,
                overexposure_threshold=args.overexposure_threshold,
            )
            result["overexposure_status"] = overexposure_status
            result["overexposure_ratio"] = overexposure_ratio
        except Exception as exc:
            print(f"Overexposure detection failed for {image_path}: {exc}",
                  file=sys.stderr)
            result["overexposure_error"] = str(exc)

        # Subject-level overexposure detection
        try:
            subject_result = detect_subject_overexposure(
                image_path,
                v_threshold=args.subject_v_threshold,
                s_threshold=args.subject_s_threshold,
                min_area_ratio=args.min_area_ratio,
                max_area_ratio=args.max_area_ratio,
                severe_total_area_ratio=args.severe_total_area_ratio,
                min_component_pixels=args.min_component_pixels,
                texture_gradient_threshold=args.texture_gradient_threshold,
            )
            result["subject_overexposure"] = subject_result
        except Exception as exc:
            print(
                f"Subject overexposure detection failed for {image_path}: {exc}",
                file=sys.stderr,
            )
            result["subject_overexposure"] = None

        results.append(result)

    total_time_ms = int((time.time() - start_time) * 1000)

    output = {
        "results": results,
        "model_load_time_ms": model_load_time_ms,
        "total_time_ms": total_time_ms,
    }

    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


# ---------------------------------------------------------------------------
# Subcommand: dedup
# ---------------------------------------------------------------------------


def cmd_dedup(args):
    """Run CLIP embedding-based deduplication on a list of images."""
    start_time = time.time()
    args.images = _resolve_images(args)

    # Load model
    model, processor = load_model(args.model_dir)

    # Parse metadata
    metadata = {}
    if args.metadata:
        try:
            metadata = json.loads(args.metadata)
        except json.JSONDecodeError as exc:
            print(f"Failed to parse --metadata JSON: {exc}", file=sys.stderr)
            # Continue without metadata — will use default priority

    # Extract embeddings
    embedding_start = time.time()
    embeddings, error_indices = extract_embeddings(
        args.images, model, processor
    )
    embedding_time_ms = int((time.time() - embedding_start) * 1000)

    # Find duplicate groups
    duplicate_groups = find_duplicate_groups(
        embeddings, args.threshold, error_indices
    )

    # Build output groups with best-to-keep selection
    groups = []
    for indices, similarities in duplicate_groups:
        keep = select_best_to_keep(indices, metadata)
        groups.append({
            "indices": indices,
            "keep": keep,
            "similarities": similarities,
        })

    total_time_ms = int((time.time() - start_time) * 1000)

    output = {
        "groups": groups,
        "embedding_time_ms": embedding_time_ms,
        "total_time_ms": total_time_ms,
    }

    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


# ---------------------------------------------------------------------------
# Subcommand: clip-neighbors
# ---------------------------------------------------------------------------


def cmd_clip_neighbors(args):
    """Extract CLIP embeddings and output three-tier candidate pairs.

    Uses top-k nearest neighbor search per image, then classifies each
    pair into confirmed_pairs or gray_zone_pairs based on CLI thresholds.
    All thresholds are received via CLI arguments (no hardcoded values).
    """
    start_time = time.time()
    args.images = _resolve_images(args)

    # Load model
    model, processor = load_model(args.model_dir)

    # Parse hash data
    hash_data = {}
    if args.hash_data:
        try:
            hash_data = json.loads(args.hash_data)
        except json.JSONDecodeError as exc:
            print(
                f"Failed to parse --hash-data JSON: {exc}",
                file=sys.stderr,
            )

    # Extract embeddings
    embedding_start = time.time()
    embeddings, error_indices = extract_embeddings(
        args.images, model, processor
    )
    embedding_time_ms = int((time.time() - embedding_start) * 1000)

    n = len(embeddings)
    error_set = set(error_indices)
    top_k = args.top_k

    confirmed_threshold = args.confirmed_threshold
    gray_high_threshold = args.gray_high_threshold
    gray_low_threshold = args.gray_low_threshold
    gray_low_seq_distance = args.gray_low_seq_distance
    gray_low_hash_distance = args.gray_low_hash_distance

    # Normalize embeddings (handle zero vectors from errors)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    normalized = embeddings / norms

    confirmed_pairs = []
    gray_zone_pairs = []
    seen = set()

    for i in range(n):
        if i in error_set:
            continue

        # Compute similarities to all other images
        sims = normalized[i] @ normalized.T  # (N,)

        # Get top-k+1 indices (including self), then exclude self
        k_fetch = min(top_k + 1, n)
        top_indices = np.argpartition(sims, -k_fetch)[-k_fetch:]

        for j_val in top_indices:
            j = int(j_val)
            if j == i or j in error_set:
                continue

            # Deduplicate pairs (i, j) and (j, i)
            lo, hi = min(i, j), max(i, j)
            if (lo, hi) in seen:
                continue
            seen.add((lo, hi))

            sim = float(sims[j])

            if sim >= confirmed_threshold:
                confirmed_pairs.append({
                    "i": lo,
                    "j": hi,
                    "similarity": sim,
                })
            elif sim >= gray_high_threshold:
                gray_zone_pairs.append({
                    "i": lo,
                    "j": hi,
                    "similarity": sim,
                })
            elif sim >= gray_low_threshold:
                # Additional conditions for the low gray tier
                i_data = hash_data.get(str(lo), {})
                j_data = hash_data.get(str(hi), {})
                seq_i = i_data.get("seqIndex", lo)
                seq_j = j_data.get("seqIndex", hi)
                p_hash_i = i_data.get("pHash")
                p_hash_j = j_data.get("pHash")
                d_hash_i = i_data.get("dHash")
                d_hash_j = j_data.get("dHash")

                seq_dist = abs(seq_i - seq_j)
                if seq_dist > gray_low_seq_distance:
                    continue

                p_dist = _hamming_hex(p_hash_i, p_hash_j)
                d_dist = _hamming_hex(d_hash_i, d_hash_j)

                if (
                    (p_dist is not None
                     and p_dist <= gray_low_hash_distance)
                    or (d_dist is not None
                        and d_dist <= gray_low_hash_distance)
                ):
                    gray_zone_pairs.append({
                        "i": lo,
                        "j": hi,
                        "similarity": sim,
                    })
            # else: sim < gray_low_threshold → skip

    total_time_ms = int((time.time() - start_time) * 1000)

    output = {
        "confirmed_pairs": confirmed_pairs,
        "gray_zone_pairs": gray_zone_pairs,
        "embedding_time_ms": embedding_time_ms,
        "total_time_ms": total_time_ms,
    }

    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


def _hamming_hex(hex_a, hex_b):
    """Compute hamming distance between two hex hash strings.

    Returns None if either hash is None or they differ in length.
    """
    if hex_a is None or hex_b is None:
        return None
    if len(hex_a) != len(hex_b):
        return None
    try:
        val_a = int(hex_a, 16)
        val_b = int(hex_b, 16)
    except (ValueError, TypeError):
        return None
    xor = val_a ^ val_b
    return bin(xor).count("1")


# ---------------------------------------------------------------------------
# Argument parsing and main entry point
# ---------------------------------------------------------------------------


def build_parser():
    """Build the argparse parser with analyze and dedup subcommands."""
    parser = argparse.ArgumentParser(
        description="CLIP image analysis and deduplication tool"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- analyze subcommand ---
    analyze_parser = subparsers.add_parser(
        "analyze",
        help="Classify images and detect blur"
    )
    analyze_parser.add_argument(
        "--images", nargs="+", required=False,
        help="List of image file paths"
    )
    analyze_parser.add_argument(
        "--images-file", type=str, default=None,
        help="Path to file containing image paths (one per line)"
    )
    analyze_parser.add_argument(
        "--model-dir", default="./models",
        help="Local model directory (default: ./models)"
    )
    analyze_parser.add_argument(
        "--blur-threshold", type=float, default=15.0,
        help="Blur detection lower threshold (default: 15)"
    )
    analyze_parser.add_argument(
        "--clear-threshold", type=float, default=50.0,
        help="Blur detection upper threshold (default: 50)"
    )
    analyze_parser.add_argument(
        "--overexposure-threshold", type=float, default=0.40,
        help="Overexposure threshold: fraction of pixels > 240 (default: 0.40)"
    )
    analyze_parser.add_argument(
        "--subject-v-threshold", type=int, default=245,
        help="HSV V-channel brightness threshold for subject overexposure (default: 245)"
    )
    analyze_parser.add_argument(
        "--subject-s-threshold", type=int, default=45,
        help="HSV S-channel low saturation threshold for subject overexposure (default: 45)"
    )
    analyze_parser.add_argument(
        "--min-area-ratio", type=float, default=0.006,
        help="Minimum connected component area ratio for subject overexposure (default: 0.006)"
    )
    analyze_parser.add_argument(
        "--max-area-ratio", type=float, default=0.015,
        help="Maximum area ratio for single component severe classification (default: 0.015)"
    )
    analyze_parser.add_argument(
        "--severe-total-area-ratio", type=float, default=0.012,
        help="Total qualifying area ratio above which severity is severe (default: 0.012)"
    )
    analyze_parser.add_argument(
        "--min-component-pixels", type=int, default=300,
        help="Minimum pixels per qualifying connected component (default: 300)"
    )
    analyze_parser.add_argument(
        "--texture-gradient-threshold", type=float, default=5.0,
        help="Sobel gradient std below this = featureless/overexposed (default: 5.0)"
    )

    # --- dedup subcommand ---
    dedup_parser = subparsers.add_parser(
        "dedup",
        help="[LEGACY] Detect duplicate images using CLIP embeddings"
    )
    dedup_parser.add_argument(
        "--images", nargs="+", required=False,
        help="List of image file paths"
    )
    dedup_parser.add_argument(
        "--images-file", type=str, default=None,
        help="Path to file containing image paths (one per line)"
    )
    dedup_parser.add_argument(
        "--model-dir", default="./models",
        help="Local model directory (default: ./models)"
    )
    dedup_parser.add_argument(
        "--threshold", type=float, default=0.9,
        help="Cosine similarity threshold for duplicates (default: 0.9)"
    )
    dedup_parser.add_argument(
        "--metadata", type=str, default=None,
        help="JSON string with per-image metadata for retention priority"
    )

    # --- clip-neighbors subcommand ---
    cn_parser = subparsers.add_parser(
        "clip-neighbors",
        help="CLIP top-k neighbor search with three-tier classification"
    )
    cn_parser.add_argument(
        "--images", nargs="+", required=False,
        help="List of image file paths"
    )
    cn_parser.add_argument(
        "--images-file", type=str, default=None,
        help="Path to file containing image paths (one per line)"
    )
    cn_parser.add_argument(
        "--model-dir", default="./models",
        help="Local model directory (default: ./models)"
    )
    cn_parser.add_argument(
        "--top-k", type=int, default=5,
        help="Number of nearest neighbors per image (default: 5)"
    )
    cn_parser.add_argument(
        "--confirmed-threshold", type=float, default=0.94,
        help="Similarity threshold for confirmed pairs (default: 0.94)"
    )
    cn_parser.add_argument(
        "--gray-high-threshold", type=float, default=0.90,
        help="Upper gray zone threshold (default: 0.90)"
    )
    cn_parser.add_argument(
        "--gray-low-threshold", type=float, default=0.85,
        help="Lower gray zone threshold (default: 0.85)"
    )
    cn_parser.add_argument(
        "--gray-low-seq-distance", type=int, default=12,
        help="Max sequence distance for low gray tier (default: 12)"
    )
    cn_parser.add_argument(
        "--gray-low-hash-distance", type=int, default=16,
        help="Max hash distance for low gray tier (default: 16)"
    )
    cn_parser.add_argument(
        "--hash-data", type=str, default=None,
        help="JSON with per-image pHash, dHash and seqIndex"
    )

    return parser


def main():
    """Main entry point."""
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "analyze":
            cmd_analyze(args)
        elif args.command == "dedup":
            cmd_dedup(args)
        elif args.command == "clip-neighbors":
            cmd_clip_neighbors(args)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"Runtime error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
