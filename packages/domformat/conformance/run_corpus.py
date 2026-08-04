#!/usr/bin/env python3
from __future__ import annotations

import binascii
import hashlib
import json
import tempfile
from pathlib import Path

from reader import (
    DEFAULT_LIMITS,
    DomError,
    canonical_encode,
    image_dimensions,
    parse_json,
    read_dom,
    validate_resources,
)


ROOT = Path(__file__).resolve().parent
CORPUS = ROOT / "corpus"


def expect_dom_error(code: str, operation) -> None:
    try:
        operation()
    except DomError as error:
        assert error.code == code, f"expected {code}, got {error.code}"
        print(f"ok python-{code.lower()}: {code}")
        return
    raise AssertionError(f"expected {code}")


def check_resource_boundaries(result: dict) -> None:
    image = next(record for record in result["document"]["resources"]["resources"]
                 if record["kind"] == "image")
    payload = result["resourceBytes"][image["id"]]
    animation_payload = (2).to_bytes(4, "big") + (0).to_bytes(4, "big")
    animation_body = b"acTL" + animation_payload
    animation_chunk = (len(animation_payload).to_bytes(4, "big") + animation_body
                       + (binascii.crc32(animation_body) & 0xFFFFFFFF).to_bytes(4, "big"))
    animated = payload[:33] + animation_chunk + payload[33:]
    expect_dom_error("IMAGE_ANIMATION_UNSUPPORTED",
                     lambda: image_dimensions(animated, image["mediaType"]))

    limits = dict(DEFAULT_LIMITS)
    limits["image_pixels_total"] = image["dimensions"]["width"] * image["dimensions"]["height"] - 1
    expect_dom_error("AGGREGATE_IMAGE_PIXEL_LIMIT",
                     lambda: validate_resources(result["document"]["resources"], limits))


def mutate(source: bytes, operation: str) -> bytes:
    if operation in {"none", "missing-resource", "resource-digest"}:
        return source
    if operation == "gzip-transport":
        return b"\x1f\x8b\x08\x00"
    if operation == "malformed-utf8":
        return b"\xff"
    if operation == "malformed-json":
        return b'{"meta":'

    text = source.decode("utf-8")
    if operation == "duplicate-key":
        return ('{"meta":null,' + text[1:]).encode("utf-8")
    if operation == "negative-zero":
        changed = text.replace('"version":0', '"version":-0', 1)
        assert changed != text
        return changed.encode("utf-8")

    document = parse_json(source, "corpus fixture")
    if operation == "unknown-top-level":
        document["privateAdapter"] = True
    elif operation == "unsupported-format":
        document["meta"]["format"] = "domformat@99"
    elif operation == "unsupported-profile":
        document["meta"]["profile"] = "polycss-3d@99"
    elif operation == "unknown-required-capability":
        document["meta"]["capabilities"].append("future-required")
    elif operation == "invalid-initial-experience":
        document["meta"]["initialExperience"] = "webpage-replay"
    elif operation == "embedded-payload":
        document["payloads"] = {}
    elif operation == "embedded-storage":
        record = document["resources"]["resources"][0]
        del record["path"]
        record["storage"] = {"mode": "embedded", "encoding": "base64"}
    elif operation == "unsafe-resource-path":
        document["resources"]["resources"][0]["path"] = "../private.png"
    elif operation == "duplicate-resource-path":
        records = document["resources"]["resources"]
        records[1]["path"] = records[0]["path"]
    elif operation == "casefold-resource-path":
        records = document["resources"]["resources"]
        records[1]["path"] = records[0]["path"].upper()
    elif operation == "resource-path-prefix":
        records = document["resources"]["resources"]
        records[1]["path"] = records[0]["path"] + "/model.css"
    elif operation == "reserved-resource-path":
        document["resources"]["resources"][0]["path"] = "assets/CON.png"
    elif operation == "trailing-dot-resource-path":
        document["resources"]["resources"][0]["path"] = "assets/checker."
    elif operation == "missing-aria-hidden":
        parents = {node["parent"] for node in document["tree"]["nodes"] if node["parent"] >= 0}
        terminal = next(node for node in document["tree"]["nodes"] if node["index"] not in parents)
        del terminal["attributes"]["aria-hidden"]
    else:
        raise ValueError(f"Unknown mutation {operation}")
    return canonical_encode(document)


def main() -> int:
    manifest = json.loads((CORPUS / "cases.json").read_text())
    source = (CORPUS / manifest["fixture"]["json"]).read_bytes()
    assert len(source) == manifest["fixture"]["byteLength"]
    assert hashlib.sha256(source).hexdigest() == manifest["fixture"]["sha256"]
    failures = []
    with tempfile.TemporaryDirectory(prefix="domformat-corpus-") as directory:
        for case in manifest["cases"]:
            case_root = Path(directory) / case["id"]
            (case_root / "assets").mkdir(parents=True)
            path = case_root / "model.json"
            path.write_bytes(mutate(source, case["mutation"]))
            for relative in manifest["fixture"]["resources"]:
                if case["mutation"] == "missing-resource" and relative.endswith(".png"):
                    continue
                payload = (CORPUS / relative).read_bytes()
                if case["mutation"] == "resource-digest" and relative.endswith(".png"):
                    payload = bytes((payload[0] ^ 1,)) + payload[1:]
                target = case_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
            actual = "valid"
            try:
                result = read_dom(path, require_resources=True)
                if case["id"] == "valid":
                    summary = result["summary"]
                    assert summary["constructionPlanSha256"] == manifest["fixture"]["constructionPlanSha256"]
                    assert summary["bindingPlanSha256"] == manifest["fixture"]["bindingPlanSha256"]
                    check_resource_boundaries(result)
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
