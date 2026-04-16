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


def detect_blur(image_path, blur_threshold=15, clear_threshold=50):
    """Detect blur using CLAHE-normalized Laplacian variance.

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
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        normalized = clahe.apply(gray)
        laplacian = cv2.Laplacian(normalized, cv2.CV_64F)
        blur_score = float(laplacian.var())
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
        image_features = model.get_image_features(**image_inputs)

    # Get text features for all prompts at once
    text_inputs = processor(
        text=all_prompts, return_tensors="pt", padding=True, truncation=True
    )
    with torch.no_grad():
        text_features = model.get_text_features(**text_inputs)

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

    if people_score >= 0.30 and people_score >= animal_score - 0.03:
        category = "people"
    elif animal_score >= 0.38 and animal_score - people_score >= 0.05:
        category = "animal"
    elif landscape_score >= 0.35:
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
                features = model.get_image_features(**inputs)
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


def cmd_analyze(args):
    """Run CLIP classification + blur detection on a list of images."""
    start_time = time.time()

    # Load model
    model_load_start = time.time()
    model, processor = load_model(args.model_dir)
    model_load_time_ms = int((time.time() - model_load_start) * 1000)

    results = []
    for image_path in args.images:
        result = {
            "file": image_path,
            "error": False,
            "category": None,
            "category_scores": None,
            "blur_status": "unknown",
            "blur_score": None,
        }

        # CLIP classification
        try:
            category, category_scores = classify_image(
                image_path, model, processor
            )
            result["category"] = category
            result["category_scores"] = category_scores
        except Exception as exc:
            print(f"Classification failed for {image_path}: {exc}",
                  file=sys.stderr)
            result["error"] = True
            result["error_message"] = str(exc)

        # Blur detection (independent of classification success)
        blur_status, blur_score = detect_blur(
            image_path,
            blur_threshold=args.blur_threshold,
            clear_threshold=args.clear_threshold,
        )
        result["blur_status"] = blur_status
        result["blur_score"] = blur_score

        # If classification failed, mark as error but keep blur results
        # If blur also failed (unknown), that's fine — still not a full error
        # unless classification also failed
        if result["error"] and blur_status == "unknown":
            result["error_message"] = result.get(
                "error_message", "Processing failed"
            )

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
        "--images", nargs="+", required=True,
        help="List of image file paths"
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

    # --- dedup subcommand ---
    dedup_parser = subparsers.add_parser(
        "dedup",
        help="[LEGACY] Detect duplicate images using CLIP embeddings"
    )
    dedup_parser.add_argument(
        "--images", nargs="+", required=True,
        help="List of image file paths"
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
        "--images", nargs="+", required=True,
        help="List of image file paths"
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
