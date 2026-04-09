#!/usr/bin/env python3
"""Download and export CLIP model to ONNX format."""
import json
import hashlib
import os
import sys
from pathlib import Path

def compute_sha256(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"

def main():
    script_dir = Path(__file__).parent
    config_path = script_dir / "model_config.json"
    
    with open(config_path) as f:
        config = json.load(f)
    
    model_name = config["model_name"]
    revision = config["revision"]
    onnx_dir = script_dir / config["onnx_dir"]
    
    # Check if already exported
    if (onnx_dir / "model.onnx").exists():
        print(f"Model already exists at {onnx_dir}", file=sys.stderr)
        # Verify checksums if available
        if config.get("checksums"):
            for filename, expected in config["checksums"].items():
                filepath = onnx_dir / filename
                if filepath.exists():
                    actual = compute_sha256(filepath)
                    if actual != expected:
                        print(f"Checksum mismatch for {filename}: expected {expected}, got {actual}", file=sys.stderr)
                        sys.exit(1)
            print("Checksum verification passed", file=sys.stderr)
        return
    
    print(f"Downloading and exporting {model_name} (revision: {revision})...", file=sys.stderr)
    
    try:
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        from transformers import CLIPProcessor
        
        # Download and export to ONNX
        onnx_dir.mkdir(parents=True, exist_ok=True)
        
        model = ORTModelForFeatureExtraction.from_pretrained(
            model_name,
            revision=revision,
            export=True,
        )
        model.save_pretrained(str(onnx_dir))
        
        # Also save the processor/tokenizer
        processor = CLIPProcessor.from_pretrained(model_name, revision=revision)
        processor.save_pretrained(str(onnx_dir))
        
        print(f"Model exported to {onnx_dir}", file=sys.stderr)
        
        # Compute and save checksums
        checksums = {}
        for filepath in onnx_dir.rglob("*"):
            if filepath.is_file() and filepath.suffix in ('.onnx', '.json'):
                rel = filepath.relative_to(onnx_dir)
                checksums[str(rel)] = compute_sha256(filepath)
        
        config["checksums"] = checksums
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
        
        print(f"Checksums saved to {config_path}", file=sys.stderr)
        
    except Exception as e:
        print(f"Failed to export model: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
