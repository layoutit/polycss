#!/usr/bin/env python3
"""Check shared canonical-JSON and binary32 conformance vectors."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

from reader import DomError, canonical_encode, parse_canonical_json, preflight_json_structure
from producer import canonical_json as producer_canonical_json


ROOT = Path(__file__).resolve().parent
CORPUS = ROOT / "corpus"


def parse_binary64(source: str):
    return json.loads(source, parse_int=float, parse_float=float)


def f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def bits(value: float) -> str:
    return struct.pack("<f", value)[::-1].hex()


def check_cases() -> None:
    preflight_json_structure("[0,1]", "array boundary", 2, 2)
    preflight_json_structure('{"a":0,"b":1}', "object boundary", 2, 2)
    for source, expected in [
        ("[0,1,2]", "JSON_ARRAY_LIMIT"),
        ('{"a":0,"b":1,"c":2}', "JSON_OBJECT_LIMIT"),
    ]:
        try:
            preflight_json_structure(source, "structure boundary", 2, 2)
        except DomError as error:
            if error.code != expected:
                raise
        else:
            raise AssertionError(f"{expected}: excessive JSON structure was accepted")
    excessive_key = ('{"' + "a" * 257 + '":0}').encode("utf-8")
    try:
        parse_canonical_json(excessive_key, "key boundary")
    except DomError as error:
        if error.code != "JSON_KEY_LIMIT":
            raise
    else:
        raise AssertionError("JSON_KEY_LIMIT: excessive object key was accepted")

    canonical = json.loads((CORPUS / "canonical-json-cases.json").read_text("utf-8"))
    assert canonical["version"] == 0
    for case in canonical["cases"]:
        actual = canonical_encode(parse_binary64(case["source"])).decode("utf-8")
        if actual != case["canonical"]:
            raise AssertionError(f"{case['id']}: {actual!r} != {case['canonical']!r}")
        produced = producer_canonical_json(parse_binary64(case["source"])).decode("utf-8")
        if produced != case["canonical"]:
            raise AssertionError(
                f"independent producer {case['id']}: {produced!r} != {case['canonical']!r}")
        parse_canonical_json(case["canonical"].encode("utf-8"), case["id"])
        if case["source"] != case["canonical"]:
            try:
                parse_canonical_json(case["source"].encode("utf-8"), case["id"])
            except DomError as error:
                if error.code != "NON_CANONICAL_JSON":
                    raise
            else:
                raise AssertionError(f"{case['id']}: noncanonical source was accepted")

    vectors = json.loads((CORPUS / "f32-vectors.json").read_text("utf-8"))
    assert vectors["version"] == 0
    for case in vectors["values"]:
        value = -0.0 if case.get("negativeZero") else float(case["value"])
        actual = bits(f32(value))
        if actual != case["bits"]:
            raise AssertionError(f"{case['id']}: {actual} != {case['bits']}")
    for case in vectors["operations"]:
        if case["op"] == "add":
            value = f32(f32(case["left"]) + f32(case["right"]))
        elif case["op"] == "multiply":
            value = f32(f32(case["left"]) * f32(case["right"]))
        elif case["op"] == "sqrt":
            value = f32(math.sqrt(f32(case["value"])))
        else:
            raise AssertionError(f"Unsupported vector operation {case['op']}")
        actual = bits(value)
        if actual != case["bits"]:
            raise AssertionError(f"{case['id']}: {actual} != {case['bits']}")


def check_stdin() -> None:
    payload = sys.stdin.buffer.read()
    value = parse_canonical_json(payload, "stdin canonical JSON")
    produced = producer_canonical_json(value)
    if produced != payload:
        raise AssertionError("independent producer canonical JSON differs from stdin")
    count = len(value) if isinstance(value, list) else 1
    print(json.dumps({"count": count, "sha256": hashlib.sha256(payload).hexdigest()}, separators=(",", ":")))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin", action="store_true")
    args = parser.parse_args()
    if args.stdin:
        check_stdin()
    else:
        check_cases()
        print("ok canonical-json and f32 vectors; independent producer matched")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, DomError, ValueError, OverflowError) as error:
        print(f"not ok: {error}", file=sys.stderr)
        raise SystemExit(1)
