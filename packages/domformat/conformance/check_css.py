#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from reader import DEFAULT_LIMITS, DomError, validate_css


ROOT = Path(__file__).resolve().parent


def main() -> int:
    corpus = json.loads((ROOT / "corpus/css-security-cases.json").read_text())
    resources = {"checker": {"kind": "image"}}
    failures = []
    for case in corpus["cases"]:
        binding = {
            "id": "model-css",
            "scope": corpus["scope"],
            "assetTokens": case["tokens"],
        }
        actual = "valid"
        try:
            validate_css(case["css"].encode(), binding, resources, dict(DEFAULT_LIMITS))
        except DomError as error:
            actual = error.code
        if actual != case["expect"]:
            failures.append(f"{case['id']}: expected {case['expect']}, got {actual}")
        else:
            print(f"ok {case['id']}: {actual}")
    if failures:
        raise SystemExit("\n".join(failures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
