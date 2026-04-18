#!/usr/bin/env python3
"""
ML-based image quality service for travel album.

Provides three capabilities:
1. DINOv2 embedding extraction (for dedup clustering)
2. MUSIQ IQA score (technical quality assessment)
3. LAION aesthetic score (visual appeal)

Usage:
  python quality_service.py embeddings <image_paths_json>
  python quality_service.py quality <image_path>
  python quality_service.py batch_quality <image_paths_json>

All output is JSON to stdout.
"""

import sys
import json
import os
import warnings
import numpy as np

warnings.filterwarnings("ignore")

# Lazy-load models to avoid loading everything on every call
_dinov2_model = None
_dinov2_transform = None
_musiq_model = None
_aesthetic_model = None
_aesthetic_clip_model = None
_aesthetic_clip_preprocess = None


def _load_dinov2():
    """Load DINOv2-small for embedding extraction."""
    global _dinov2_model, _dinov2_transform
    if _dinov2_model is not None:
        return _dinov2_model, _dinov2_transform

    import torch
    from torchvision import transforms

    print("Loading DINOv2-small...", file=sys.stderr)
    _dinov2_model = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14', pretrained=True)
    _dinov2_model.eval()

    _dinov2_transform = transforms.Compose([
        transforms.Resize(256, interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])

    return _dinov2_model, _dinov2_transform


def _load_musiq():
    """Load MUSIQ model via pyiqa for IQA scoring."""
    global _musiq_model
    if _musiq_model is not None:
        return _musiq_model

    import pyiqa

    print("Loading MUSIQ...", file=sys.stderr)
    _musiq_model = pyiqa.create_metric('musiq', device='cpu')
    return _musiq_model


def _load_aesthetic():
    """Load LAION aesthetic predictor."""
    global _aesthetic_model, _aesthetic_clip_model, _aesthetic_clip_preprocess
    if _aesthetic_model is not None:
        return _aesthetic_model, _aesthetic_clip_model, _aesthetic_clip_preprocess

    import torch
    import clip

    print("Loading LAION aesthetic predictor...", file=sys.stderr)

    # Load CLIP for feature extraction
    _aesthetic_clip_model, _aesthetic_clip_preprocess = clip.load("ViT-L/14", device="cpu")

    # Load aesthetic predictor (linear layer on top of CLIP)
    model_path = os.path.join(os.path.dirname(__file__), "models", "sac+logos+ava1-l14-linearMSE.pth")
    if not os.path.exists(model_path):
        # Download if not present
        import urllib.request
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        url = "https://github.com/christophschuhmann/improved-aesthetic-predictor/raw/main/sac+logos+ava1-l14-linearMSE.pth"
        print(f"Downloading aesthetic model from {url}...", file=sys.stderr)
        urllib.request.urlretrieve(url, model_path)

    _aesthetic_model = torch.nn.Linear(768, 1)
    _aesthetic_model.load_state_dict(torch.load(model_path, map_location="cpu"))
    _aesthetic_model.eval()

    return _aesthetic_model, _aesthetic_clip_model, _aesthetic_clip_preprocess



def extract_embeddings(image_paths):
    """Extract DINOv2 embeddings for a list of images.
    Returns list of {path, embedding} dicts.
    """
    import torch
    from PIL import Image

    model, transform = _load_dinov2()
    results = []

    for path in image_paths:
        try:
            img = Image.open(path).convert("RGB")
            tensor = transform(img).unsqueeze(0)
            with torch.no_grad():
                embedding = model(tensor)
            emb = embedding[0].numpy().tolist()
            results.append({"path": path, "embedding": emb, "error": None})
        except Exception as e:
            results.append({"path": path, "embedding": None, "error": str(e)})

    return results


def compute_quality(image_path):
    """Compute IQA + aesthetic scores for a single image.
    Returns {musiq_score, aesthetic_score, error}.
    """
    import torch
    from PIL import Image

    result = {"musiq_score": None, "aesthetic_score": None, "error": None}

    # MUSIQ score
    try:
        musiq = _load_musiq()
        score = musiq(image_path)
        if torch.is_tensor(score):
            score = score.item()
        result["musiq_score"] = round(float(score), 2)
    except Exception as e:
        result["error"] = f"musiq: {e}"

    # Aesthetic score
    try:
        aesthetic_model, clip_model, clip_preprocess = _load_aesthetic()
        img = Image.open(image_path).convert("RGB")
        img_tensor = clip_preprocess(img).unsqueeze(0)
        with torch.no_grad():
            features = clip_model.encode_image(img_tensor)
            features = features / features.norm(dim=-1, keepdim=True)
            score = aesthetic_model(features.float())
        result["aesthetic_score"] = round(float(score.item()), 2)
    except Exception as e:
        if result["error"]:
            result["error"] += f"; aesthetic: {e}"
        else:
            result["error"] = f"aesthetic: {e}"

    return result


def batch_quality(image_paths):
    """Compute quality scores for multiple images."""
    results = []
    for path in image_paths:
        r = compute_quality(path)
        r["path"] = path
        results.append(r)
    return results


def find_duplicates(embeddings, threshold=0.92):
    """Find duplicate groups using cosine similarity on embeddings.
    Returns list of groups, each group is a list of indices.
    """
    import faiss

    # Filter out failed embeddings
    valid = [(i, e) for i, e in enumerate(embeddings) if e is not None]
    if len(valid) < 2:
        return []

    indices = [v[0] for v in valid]
    vectors = np.array([v[1] for v in valid], dtype=np.float32)

    # Normalize for cosine similarity
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    vectors = vectors / norms

    # Build FAISS index
    dim = vectors.shape[1]
    index = faiss.IndexFlatIP(dim)  # Inner product = cosine similarity on normalized vectors
    index.add(vectors)

    # Search: each vector against all others
    k = min(len(vectors), 20)  # top-20 neighbors
    scores, neighbors = index.search(vectors, k)

    # Build adjacency from threshold
    from collections import defaultdict
    adj = defaultdict(set)
    for i in range(len(vectors)):
        for j_idx in range(k):
            j = neighbors[i][j_idx]
            if j == i:
                continue
            sim = scores[i][j_idx]
            if sim >= threshold:
                real_i = indices[i]
                real_j = indices[j]
                adj[real_i].add(real_j)
                adj[real_j].add(real_i)

    # Connected components via BFS
    visited = set()
    groups = []
    for node in adj:
        if node in visited:
            continue
        group = []
        queue = [node]
        while queue:
            n = queue.pop(0)
            if n in visited:
                continue
            visited.add(n)
            group.append(n)
            for neighbor in adj[n]:
                if neighbor not in visited:
                    queue.append(neighbor)
        if len(group) >= 2:
            groups.append(sorted(group))

    return groups


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: quality_service.py <command> [args]"}))
        sys.exit(1)

    command = sys.argv[1]

    if command == "embeddings":
        paths = json.loads(sys.argv[2])
        results = extract_embeddings(paths)
        print(json.dumps(results))

    elif command == "quality":
        path = sys.argv[2]
        result = compute_quality(path)
        print(json.dumps(result))

    elif command == "batch_quality":
        paths = json.loads(sys.argv[2])
        results = batch_quality(paths)
        print(json.dumps(results))

    elif command == "find_duplicates":
        # Input: JSON array of {index, embedding} or just embeddings array
        data = json.loads(sys.argv[2])
        threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.92
        groups = find_duplicates(data, threshold)
        print(json.dumps(groups))

    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
