#!/usr/bin/env python3
"""Dependency-free independent domformat@0 reader and inspector.

This implementation intentionally shares no code with src/.  It validates the
bounded JSON transport, retained construction plan, resource integrity,
CSS closure, and state/binding graph.  It does not execute PolyCSS codecs.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re
import stat as stat_module
import struct
import sys
import unicodedata
from pathlib import Path
from typing import Any


DOCUMENT_FIELDS = ("meta", "tree", "cssBinding", "state", "bindings", "resources")
BASE64_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
STATE_INTERPRETERS = {
    "polycss-effects-prepared@0": "polycss-effects@0",
    "polycss-playback-packed@0": "polycss-playback@0",
    "polycss-pointer-grab-prepared@0": "polycss-pointer-grab@0",
    "polycss-surface-packed@0": "polycss-surface@0",
    "static-presentation@0": "static-presentation@0",
}
KNOWN_REQUIRED_CAPABILITIES = {
    "css-semantic-closure",
    "deterministic-json",
    "explicit-retained-tree",
    "logical-assets",
    "prepared-particle-effects",
    "prepared-playback",
    "prepared-pointer-grab-interaction",
    "prepared-surface-lighting",
}
ALLOWED_ELEMENTS = {"b", "div", "i", "img", "s", "span", "u"}
ALLOWED_ATTRIBUTES = {
    "alt", "aria-hidden", "class", "decoding", "draggable", "height",
    "id", "role", "width",
}
ALLOWED_STYLES = {
    "backgroundColor", "backgroundPosition", "backgroundPositionY",
    "backgroundRepeat", "backgroundSize", "height", "left", "objectFit",
    "borderBottomLeftRadius", "borderBottomRightRadius", "borderShape",
    "borderTopLeftRadius", "borderTopRightRadius", "color",
    "cornerBottomLeftShape", "cornerBottomRightShape",
    "cornerTopLeftShape", "cornerTopRightShape",
    "objectPosition", "opacity", "perspective", "perspectiveOrigin",
    "position", "top", "transform", "transformOrigin", "transformStyle",
    "visibility", "width",
}
ALLOWED_MOUNT_STYLES = {
    "backgroundColor", "backgroundPosition", "backgroundRepeat",
    "backgroundSize", "position",
}
ALLOWED_SINKS = {
    "host.style.backgroundColor", "host.style.backgroundImage", "host.style.backgroundPosition",
    "host.style.backgroundRepeat", "host.style.backgroundSize",
    "style.backgroundPosition", "style.backgroundPositionY", "style.height",
    "style.left", "style.opacity", "style.top", "style.transform",
    "style.visibility", "style.width",
}
MEDIA_TYPES = {
    "image/png", "image/webp", "text/css;charset=utf-8",
}
BASE_REQUIRED_CAPABILITIES = [
    "css-semantic-closure", "deterministic-json", "explicit-retained-tree", "logical-assets",
]
CAPABILITY_INTERPRETER_ORDER = [
    ("polycss-effects@0", "prepared-particle-effects"),
    ("polycss-pointer-grab@0", "prepared-pointer-grab-interaction"),
    ("polycss-playback@0", "prepared-playback"),
    ("polycss-surface@0", "prepared-surface-lighting"),
]
CONFORMANCE_INTERPRETER_ORDER = [
    ("polycss-effects@0", "particle-effects"),
    ("polycss-playback@0", "playback"),
    ("polycss-pointer-grab@0", "pointer-grab-interaction"),
    ("static-presentation@0", "presentation"),
    ("polycss-surface@0", "surface-lighting"),
]
INLINE_SAFE_FUNCTIONS = frozenset("""
abs acos asin atan atan2 calc clamp color color-mix cos exp hsl hsla hwb hypot
lab lch linear-gradient log matrix matrix3d max min mod oklab oklch polygon pow
radial-gradient rem rgb rgba rotate rotate3d rotatex rotatey rotatez round scale
scale3d scalex scaley scalez sign sin skew skewx skewy sqrt tan translate
translate3d translatex translatey translatez
""".split())
DEFAULT_LIMITS = {
    "file": 128 * 1024 * 1024,
    "decoded_total": 128 * 1024 * 1024,
    "nodes": 250_000,
    "depth": 64,
    "resources": 2048,
    "resource": 64 * 1024 * 1024,
    "resource_total": 128 * 1024 * 1024,
    "css": 16 * 1024 * 1024,
    "css_rules": 8192,
    "css_selectors": 32_768,
    "css_selector_bytes": 4096,
    "css_declarations": 131_072,
    "css_functions": 131_072,
    "css_asset_tokens": 2048,
    "binding_inputs": 256,
    "frames": 10_000,
    "timeline_ticks": 1_000_000,
    "prepared_transforms": 2_000_000,
    "prepared_states": 2_000_000,
    "prepared_changes": 4_000_000,
    "visibility_cells": 64 * 1024 * 1024,
    "effect_particles": 10_000,
    "effect_spawn_tuples": 1_000_000,
    "interaction_controls": 256,
    "interaction_objects": 65_536,
    "interaction_vertices": 2_000_000,
    "interaction_weights": 4_000_000,
    "interaction_weight_references": 8_000_000,
    "interaction_leaf_rows": 4_000_000,
    "image_pixels_total": 128 * 1024 * 1024,
}
JSON_MAX_ARRAY_ITEMS = min(
    DEFAULT_LIMITS["decoded_total"] // 2 + 1,
    max(
        DEFAULT_LIMITS["nodes"] * 16,
        DEFAULT_LIMITS["resources"],
        DEFAULT_LIMITS["frames"] * 3,
        DEFAULT_LIMITS["timeline_ticks"],
        DEFAULT_LIMITS["prepared_transforms"],
        DEFAULT_LIMITS["prepared_states"],
        DEFAULT_LIMITS["prepared_changes"],
        DEFAULT_LIMITS["effect_particles"],
        DEFAULT_LIMITS["effect_spawn_tuples"],
        DEFAULT_LIMITS["interaction_controls"],
        DEFAULT_LIMITS["interaction_objects"] * 16,
        DEFAULT_LIMITS["interaction_vertices"] * 4,
        DEFAULT_LIMITS["interaction_weights"] * 3,
        DEFAULT_LIMITS["interaction_leaf_rows"] * 4,
    ),
)
JSON_MAX_OBJECT_MEMBERS = min(
    DEFAULT_LIMITS["decoded_total"] // 4 + 1,
    max(128, DEFAULT_LIMITS["resources"]),
)
JSON_MAX_KEY_CODE_UNITS = 256
JSON_STRUCTURE = re.compile(r'["\[\]{}]')
JSON_CONTENT = re.compile(r'[^ \t\n\r,:]')


class DomError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def require(condition: bool, code: str, message: str) -> None:
    if not condition:
        raise DomError(code, message)


def preflight_json_structure(text: str, label: str,
                             maximum_array_items: int = JSON_MAX_ARRAY_ITEMS,
                             maximum_object_members: int = JSON_MAX_OBJECT_MEMBERS,
                             maximum_key_code_units: int = JSON_MAX_KEY_CODE_UNITS) -> None:
    # JSON syntax and scalar validation remain the standard decoder's job. This
    # pass only proves structural allocation bounds before that decoder creates
    # Python lists/dicts. Scanning comma runs between strings/containers with C
    # string operations keeps large numeric tables linear without a Python call
    # per number.
    offset = 0
    stack: list[list[Any]] = []

    def malformed(message: str) -> None:
        raise DomError("MALFORMED_JSON", f"{label} {message}")

    def bound(frame: list[Any]) -> None:
        maximum = maximum_array_items if frame[0] == "[" else maximum_object_members
        count = frame[1] + (1 if frame[2] else 0)
        require(count <= maximum,
                "JSON_ARRAY_LIMIT" if frame[0] == "[" else "JSON_OBJECT_LIMIT",
                f"{label} {'array has too many items' if frame[0] == '[' else 'object has too many members'}")

    def mark_parent_content() -> None:
        if stack:
            stack[-1][2] = True
            bound(stack[-1])

    while offset < len(text):
        match = JSON_STRUCTURE.search(text, offset)
        end = match.start() if match else len(text)
        if stack and end > offset:
            commas = text.count(",", offset, end)
            stack[-1][1] += commas
            if stack[-1][0] == "{" and commas > 0:
                stack[-1][3] = True
            if JSON_CONTENT.search(text, offset, end):
                stack[-1][2] = True
            bound(stack[-1])
        if match is None:
            offset = len(text)
            break

        token = match.group(0)
        position = match.start()
        if token == '"':
            is_key = bool(stack and stack[-1][0] == "{" and stack[-1][3])
            mark_parent_content()
            cursor = position + 1
            while True:
                close = text.find('"', cursor)
                if close < 0:
                    malformed("contains an unterminated string")
                slash = close - 1
                slash_count = 0
                while slash > position and text[slash] == "\\":
                    slash_count += 1
                    slash -= 1
                if slash_count % 2 == 0:
                    if is_key:
                        require(close - position - 1 <= maximum_key_code_units * 6,
                                "JSON_KEY_LIMIT", f"{label} object key is excessive")
                        stack[-1][3] = False
                    offset = close + 1
                    break
                cursor = close + 1
            continue

        if token in "[{":
            mark_parent_content()
            require(len(stack) < 256, "JSON_DEPTH", f"{label} nesting is too deep")
            stack.append([token, 0, False, token == "{"])
        else:
            require(bool(stack), "MALFORMED_JSON", f"{label} has an unmatched closing delimiter")
            expected = "]" if stack[-1][0] == "[" else "}"
            if token != expected:
                malformed("has mismatched container delimiters")
            bound(stack[-1])
            stack.pop()
        offset = position + 1

    if stack:
        malformed("contains an unterminated container")


def strict_keys(value: Any, allowed: set[str], code: str, label: str) -> dict:
    require(isinstance(value, dict), code, f"{label} must be an object")
    unknown = set(value) - allowed
    require(not unknown, code, f"{label} has unsupported fields: {sorted(unknown)}")
    return value


def as_int(value: Any, code: str, label: str, minimum: int = 0) -> int:
    require(
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and (not isinstance(value, float) or value.is_integer())
        and abs(value) <= 9_007_199_254_740_991 and value >= minimum,
        code, f"{label} must be a safe integer",
    )
    return int(value)


def is_safe_int(value: Any, minimum: int = -9_007_199_254_740_991,
                maximum: int = 9_007_199_254_740_991) -> bool:
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and float(value).is_integer()
            and minimum <= value <= maximum)


def integer_array(value: Any, maximum_length: int, code: str, label: str,
                  minimum: int = -9_007_199_254_740_991,
                  maximum: int = 9_007_199_254_740_991,
                  unique: bool = False) -> list[int]:
    require(isinstance(value, list) and len(value) <= maximum_length,
            code, f"{label} is missing or excessive")
    require(all(is_safe_int(entry, minimum, maximum) for entry in value),
            code, f"{label} contains an invalid integer")
    result = [int(entry) for entry in value]
    if unique:
        require(len(set(result)) == len(result), code,
                f"{label} must not contain duplicates")
    return result


def cumulative_references(value: Any, count: int, code: str, label: str) -> list[int]:
    deltas = integer_array(value, count, code, label)
    require(len(deltas) == count, code, f"{label} does not match its declared count")
    current, result = 0, []
    for index, delta in enumerate(deltas):
        current += delta
        require(is_safe_int(current, 0), code,
                f"{label} reference {index} is invalid")
        result.append(current)
    return result


def finite_f32(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return False
    try:
        return math.isfinite(struct.unpack("<f", struct.pack("<f", float(value)))[0])
    except (OverflowError, struct.error):
        return False


def f32(value: float) -> float:
    try:
        return struct.unpack("<f", struct.pack("<f", float(value)))[0]
    except (OverflowError, struct.error) as error:
        raise DomError("INVALID_F32", "Float32 operation overflowed") from error


def interaction_f32(value: float) -> float:
    try:
        result = f32(value)
        return result if math.isfinite(result) else math.nan
    except DomError:
        return math.nan


def interaction_add_f32(left: float, right: float) -> float:
    return interaction_f32(interaction_f32(left) + interaction_f32(right))


def interaction_mul_f32(left: float, right: float) -> float:
    return interaction_f32(interaction_f32(left) * interaction_f32(right))


def interaction_transform_f32(value: list[float], matrix: list[float]) -> list[float]:
    output = []
    for column in range(3):
        result = interaction_mul_f32(matrix[column], value[0])
        result = interaction_add_f32(result,
                                     interaction_mul_f32(matrix[4 + column], value[1]))
        result = interaction_add_f32(result,
                                     interaction_mul_f32(matrix[8 + column], value[2]))
        output.append(result)
    return output


def interaction_grab_displacement_bounds(input_contract: dict,
                                         source: dict) -> list[float] | None:
    cursor_bounds = input_contract["cursorBounds"]
    span_x = interaction_f32(cursor_bounds[1] - cursor_bounds[0])
    span_y = interaction_f32(cursor_bounds[3] - cursor_bounds[2])
    if not math.isfinite(span_x) or not math.isfinite(span_y):
        return None
    bounds = [0.0, 0.0, 0.0]
    for delta_x in (-span_x, span_x):
        for delta_y in (-span_y, span_y):
            transformed = interaction_transform_f32([
                interaction_mul_f32(delta_x, source["displacementMagnitude"]),
                interaction_mul_f32(delta_y, source["displacementMagnitude"]),
                0.0,
            ], source["inverseCameraMatrix"])
            if not all(math.isfinite(component) for component in transformed):
                return None
            bounds = [max(bound, abs(component))
                      for bound, component in zip(bounds, transformed)]
    return bounds


def interaction_projected_f32(position: list[float], source: dict) -> list[float] | None:
    camera = interaction_transform_f32(position, source["cameraViewMatrix"])
    camera = [interaction_add_f32(component, source["cameraViewMatrix"][12 + index])
              for index, component in enumerate(camera)]
    if not all(math.isfinite(component) for component in camera) or abs(camera[2]) <= 1e-6:
        return None
    projection = source["projection"]
    x_scale = interaction_f32(projection["scale"] / interaction_f32(-camera[2]))
    y_scale = interaction_f32(projection["scale"] / camera[2])
    projected = [
        interaction_add_f32(interaction_mul_f32(camera[0], x_scale), projection["origin"][0]),
        interaction_add_f32(interaction_mul_f32(camera[1], y_scale), projection["origin"][1]),
    ]
    return projected if all(math.isfinite(component) for component in projected) else None


def interaction_magnitude_f32(value: list[float]) -> bool:
    squared = interaction_mul_f32(value[0], value[0])
    squared = interaction_add_f32(squared, interaction_mul_f32(value[1], value[1]))
    squared = interaction_add_f32(squared, interaction_mul_f32(value[2], value[2]))
    return (math.isfinite(squared) and squared >= 0
            and math.isfinite(interaction_f32(math.sqrt(squared))))


def finite_f32_array(value: Any, length: int, code: str, label: str) -> list[float]:
    require(isinstance(value, list) and len(value) == length
            and all(finite_f32(entry) for entry in value),
            code, f"{label} must contain {length} finite f32 values")
    return [float(entry) for entry in value]


def base64_integers(value: Any, width: int, maximum_count: int,
                    code: str, label: str) -> list[int]:
    decoded_length = canonical_base64_decoded_length(value, label, code)
    require(decoded_length % width == 0 and decoded_length // width <= maximum_count,
            code, f"{label} is truncated or excessive")
    try:
        payload = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise DomError(code, f"{label} is not valid base64") from error
    require(len(payload) == decoded_length
            and base64.b64encode(payload).decode("ascii") == value,
            code, f"{label} is not canonical base64")
    return [int.from_bytes(payload[offset:offset + width], "little")
            for offset in range(0, len(payload), width)]


def exact_array(value: Any, expected: list[Any], code: str, message: str) -> None:
    require(isinstance(value, list) and value == expected, code, message)


def unique_targets(value: Any, maximum: int, code: str, label: str) -> list[str]:
    require(isinstance(value, list) and len(value) <= maximum,
            code, f"{label} targets are invalid or excessive")
    targets = [stable_id(target, f"{label} target") for target in value]
    require(len(set(targets)) == len(targets), code,
            f"{label} targets contain duplicates")
    return targets


def multiply_f32_matrices(left: list[float], right: list[float]) -> list[float]:
    output = []
    for row in range(4):
        for column in range(4):
            value = f32(f32(left[row * 4]) * f32(right[column]))
            for index in range(1, 4):
                value = f32(value + f32(f32(left[row * 4 + index])
                                        * f32(right[index * 4 + column])))
            output.append(value)
    return output


def inverse_matrix_pair(left: list[float], right: list[float]) -> bool:
    try:
        products = (multiply_f32_matrices(left, right),
                    multiply_f32_matrices(right, left))
    except DomError:
        return False
    return all(all(math.isfinite(value)
                   and abs(value - (1 if index % 5 == 0 else 0)) <= 1e-4
                   for index, value in enumerate(product))
               for product in products)


def safe_style(value: Any, label: str) -> str:
    require(isinstance(value, str) and len(value) <= 4096,
            "INVALID_STYLE_VALUE", f"{label} must be a short string")
    lower = value.lower()
    require(not any(token in value for token in ("\\", "/*", "*/"))
            and not any(token in lower for token in
                        ("url(", "javascript:", "expression(", "@import", "!important"))
            and not any(token in value for token in (";", "{", "}", "--"))
            and all(ord(character) >= 0x20 or character in "\t\n\f\r" for character in value),
            "UNSAFE_STYLE_VALUE", f"{label} is unsafe")
    quote, depth, index = "", 0, 0
    while index < len(value):
        character = value[index]
        if quote:
            if character == quote:
                quote = ""
            index += 1
            continue
        if character in "\"'":
            quote = character
            index += 1
            continue
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            require(depth >= 0, "UNSAFE_STYLE_VALUE",
                    f"{label} has unbalanced function delimiters")
        if re.match(r"[A-Za-z_-]", character):
            cursor = index + 1
            while cursor < len(value) and re.match(r"[A-Za-z0-9_-]", value[cursor]):
                cursor += 1
            if cursor < len(value) and value[cursor] == "(":
                name = value[index:cursor].lower()
                require(name in INLINE_SAFE_FUNCTIONS, "UNSAFE_STYLE_VALUE",
                        f"{label} uses context-dependent or unsupported function {name}()")
            index = cursor
            continue
        index += 1
    require(not quote and depth == 0, "UNSAFE_STYLE_VALUE",
            f"{label} has unterminated strings or functions")
    return value


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be")


def ecma_number(value: float) -> str:
    require(math.isfinite(value), "INVALID_NUMBER", "JSON number is not finite")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    source = repr(abs(value)).lower()
    if "e" in source:
        mantissa, exponent_text = source.split("e", 1)
        exponent = int(exponent_text)
    else:
        mantissa, exponent = source, 0
    if "." in mantissa:
        whole, fraction = mantissa.split(".", 1)
        digits = whole + fraction
        decimal_position = len(whole) + exponent
        while digits.endswith("0"):
            digits = digits[:-1]
    else:
        digits = mantissa
        decimal_position = len(mantissa) + exponent
    require(bool(digits), "INVALID_NUMBER", "JSON number has no digits")
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        if decimal_position <= 0:
            body = "0." + "0" * (-decimal_position) + digits
        elif decimal_position >= len(digits):
            body = digits + "0" * (decimal_position - len(digits))
        else:
            body = digits[:decimal_position] + "." + digits[decimal_position:]
        return sign + body
    scientific_exponent = decimal_position - 1
    body = digits[0] + (("." + digits[1:]) if len(digits) > 1 else "")
    exponent_sign = "+" if scientific_exponent >= 0 else "-"
    return f"{sign}{body}e{exponent_sign}{abs(scientific_exponent)}"


def canonical_encode(value: Any, depth: int = 0) -> bytes:
    require(depth <= 256, "JSON_DEPTH", "Canonical JSON nesting is too deep")
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, int):
        require(abs(value) <= 9_007_199_254_740_991, "INVALID_NUMBER",
                "Generated canonical integer is not safe")
        return str(value).encode("ascii")
    if isinstance(value, float):
        return ecma_number(value).encode("ascii")
    if isinstance(value, str):
        require(all(not 0xD800 <= ord(ch) <= 0xDFFF for ch in value),
                "INVALID_UNICODE", "JSON string contains a surrogate")
        normalized = unicodedata.normalize("NFC", value)
        return json.dumps(normalized, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
    if isinstance(value, list):
        return b"[" + b",".join(canonical_encode(item, depth + 1)
                                  for item in value) + b"]"
    require(isinstance(value, dict), "INVALID_JSON_VALUE",
            "Value is not canonical JSON data")
    entries = []
    for key in sorted(value, key=utf16_sort_key):
        require(sum(2 if ord(ch) > 0xffff else 1 for ch in key) <= JSON_MAX_KEY_CODE_UNITS,
                "JSON_KEY_LIMIT", "JSON object key is excessive")
        entries.append(canonical_encode(key, depth + 1) + b":"
                       + canonical_encode(value[key], depth + 1))
    return b"{" + b",".join(entries) + b"}"


def parse_canonical_json(payload: bytes, label: str) -> Any:
    try:
        text = payload.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise DomError("MALFORMED_UTF8", f"{label} is not UTF-8: {error}") from error
    preflight_json_structure(text, label)

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict:
        result = {}
        for raw_key, item in pairs:
            require(sum(2 if ord(ch) > 0xffff else 1 for ch in raw_key) <= JSON_MAX_KEY_CODE_UNITS, "JSON_KEY_LIMIT",
                    f"{label} object key is excessive")
            require(all(not 0xD800 <= ord(ch) <= 0xDFFF for ch in raw_key),
                    "INVALID_UNICODE", f"{label} key contains a surrogate")
            key = unicodedata.normalize("NFC", raw_key)
            require(key not in result, "DUPLICATE_NORMALIZED_KEY",
                    f"{label} has duplicate normalized key {key!r}")
            result[key] = item
        return result

    def bad_constant(value: str) -> None:
        raise DomError("INVALID_NUMBER", f"{label} contains {value}")

    try:
        value = json.loads(text, object_pairs_hook=pairs_hook,
                           parse_int=float, parse_float=float,
                           parse_constant=bad_constant)
    except DomError:
        raise
    except (ValueError, RecursionError) as error:
        raise DomError("MALFORMED_JSON", f"{label} is not JSON: {error}") from error
    encoded = canonical_encode(value)
    require(encoded == payload, "NON_CANONICAL_JSON",
            f"{label} is not canonically encoded")
    return value


def parse_json(payload: bytes, label: str) -> Any:
    try:
        text = payload.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise DomError("MALFORMED_UTF8", f"{label} is not UTF-8: {error}") from error
    preflight_json_structure(text, label)

    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict:
        result = {}
        for key, item in pairs:
            require(sum(2 if ord(ch) > 0xffff else 1 for ch in key) <= JSON_MAX_KEY_CODE_UNITS, "JSON_KEY_LIMIT",
                    f"{label} object key is excessive")
            require(all(not 0xD800 <= ord(ch) <= 0xDFFF for ch in key),
                    "INVALID_UNICODE", f"{label} key contains a surrogate")
            require(key == unicodedata.normalize("NFC", key),
                    "NON_NORMALIZED_JSON", f"{label} keys must use NFC")
            require(key not in result, "DUPLICATE_NORMALIZED_KEY",
                    f"{label} has duplicate key {key!r}")
            result[key] = item
        return result

    def integer(token: str) -> float:
        require(token != "-0", "INVALID_NUMBER", f"{label} must not encode negative zero")
        value = float(token)
        require(math.isfinite(value), "INVALID_NUMBER",
                f"{label} contains a non-finite number")
        return value

    def floating(token: str) -> float:
        value = float(token)
        require(math.isfinite(value) and not (value == 0 and token.startswith("-")),
                "INVALID_NUMBER", f"{label} contains an invalid number")
        return value

    def bad_constant(value: str) -> None:
        raise DomError("INVALID_NUMBER", f"{label} contains {value}")

    try:
        value = json.loads(text, object_pairs_hook=pairs_hook,
                           parse_int=integer, parse_float=floating,
                           parse_constant=bad_constant)
    except DomError:
        raise
    except (ValueError, RecursionError) as error:
        raise DomError("MALFORMED_JSON", f"{label} is not JSON: {error}") from error

    def validate(item: Any, depth: int = 0) -> None:
        require(depth <= 256, "JSON_DEPTH", f"{label} nesting is too deep")
        if isinstance(item, str):
            require(all(not 0xD800 <= ord(ch) <= 0xDFFF for ch in item),
                    "INVALID_UNICODE", f"{label} string contains a surrogate")
            require(item == unicodedata.normalize("NFC", item),
                    "NON_NORMALIZED_JSON", f"{label} strings must use NFC")
        elif isinstance(item, list):
            for entry in item:
                validate(entry, depth + 1)
        elif isinstance(item, dict):
            for entry in item.values():
                validate(entry, depth + 1)
        elif isinstance(item, float):
            require(math.isfinite(item), "INVALID_NUMBER", f"{label} number is not finite")

    validate(value)
    return value


def parse_transport(data: bytes, limits: dict[str, int]) -> tuple[str, bytes]:
    require(len(data) <= limits["file"], "FILE_LIMIT", "File is too large")
    require(not data.startswith(b"\x1f\x8b"), "UNSUPPORTED_TRANSPORT",
            "domformat@0 accepts plain JSON only")
    require(len(data) <= limits["decoded_total"], "DOCUMENT_DECODED_LIMIT",
            "JSON is too large")
    return "json", bytes(data)


def canonical_base64_decoded_length(value: Any, label: str,
                                    code: str = "INVALID_RESOURCE_BASE64") -> int:
    require(isinstance(value, str) and len(value) % 4 == 0,
            code, f"{label} is not canonical base64")
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    body_length = len(value) - padding
    require(all(value[index] in BASE64_ALPHABET for index in range(body_length))
            and all(value[index] == "=" for index in range(body_length, len(value)))
            and (padding == 0 or (len(value) >= 4
                 and body_length % 4 == (2 if padding == 2 else 3))),
            code, f"{label} is not canonical base64")
    return len(value) // 4 * 3 - padding


def stable_id(value: Any, label: str) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[a-z][A-Za-z0-9._:/-]{0,127}", value)
            and ".." not in value and "//" not in value,
            "INVALID_STABLE_ID", f"{label} is invalid")
    return value


def resource_id(value: Any, label: str) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", value),
            "INVALID_RESOURCE_ID", f"{label} is invalid")
    return value


def safe_path(value: Any, label: str) -> str:
    require(isinstance(value, str) and 0 < len(value) <= 240 and not value.startswith(("/", "\\"))
            and "\\" not in value and not any(ch in value for ch in ":%?#"),
            "UNSAFE_RESOURCE_PATH", f"{label} is unsafe")
    parts = value.split("/")
    reserved = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])", re.IGNORECASE)
    require(all(part not in ("", ".", "..") and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part)
                and not part.endswith(".") and not reserved.fullmatch(part.split(".", 1)[0])
                for part in parts), "UNSAFE_RESOURCE_PATH", f"{label} is unsafe or nonportable")
    return value


def real_directory(path: Path, code: str, label: str) -> Path:
    metadata = path.lstat()
    require(stat_module.S_ISDIR(metadata.st_mode) and not stat_module.S_ISLNK(metadata.st_mode),
            code, f"{label} must be a real directory, not a symbolic link")
    return path.resolve(strict=True)


def reject_symlink_components(base: Path, relative: str, code: str, label: str) -> None:
    current = base
    parts = relative.split("/")
    for index, part in enumerate(parts):
        current = current / part
        metadata = current.lstat()
        require(not stat_module.S_ISLNK(metadata.st_mode), code,
                f"{label} contains a symbolic-link path component")
        if index < len(parts) - 1:
            require(stat_module.S_ISDIR(metadata.st_mode), code,
                    f"{label} contains a non-directory path component")


def validate_meta(meta: Any) -> None:
    meta = strict_keys(meta, {"format", "profile", "title", "generator",
                              "capabilities", "optionalCapabilities", "initialExperience",
                              "conformance", "counts", "sourceArtifact"},
                       "INVALID_META", "META")
    require(meta.get("format") == "domformat@0", "UNSUPPORTED_FORMAT", "Unsupported format")
    require(meta.get("profile") == "polycss-3d@0", "UNSUPPORTED_PROFILE", "Unsupported profile")
    require(isinstance(meta.get("title"), str) and 0 < len(meta["title"]) <= 256,
            "INVALID_TITLE", "Invalid title")
    generator = strict_keys(meta.get("generator"), {"name", "version"}, "INVALID_META", "generator")
    require(isinstance(generator.get("name"), str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", generator["name"])
            and isinstance(generator.get("version"), str)
            and re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}", generator["version"]),
            "INVALID_META", "Invalid generator")
    capabilities = meta.get("capabilities")
    require(isinstance(capabilities, list) and 0 < len(capabilities) <= 128
            and all(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value)
                    for value in capabilities)
            and len(set(capabilities)) == len(capabilities), "INVALID_META", "Invalid required capabilities")
    unknown = [value for value in capabilities if value not in KNOWN_REQUIRED_CAPABILITIES]
    require(not unknown, "UNSUPPORTED_REQUIRED_CAPABILITY", f"Unsupported required capability {unknown[0] if unknown else ''}")
    optional_capabilities = meta.get("optionalCapabilities")
    if optional_capabilities is not None:
        require(isinstance(optional_capabilities, list) and len(optional_capabilities) <= 128
                and all(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value)
                        for value in optional_capabilities)
                and len(set(optional_capabilities)) == len(optional_capabilities)
                and not set(optional_capabilities).intersection(capabilities)
                and all(optional_capabilities[index - 1] < value
                        for index, value in enumerate(optional_capabilities) if index > 0),
                "INVALID_META", "Invalid optional capabilities")
    require("initialExperience" not in meta or meta["initialExperience"] in ("animation", "interaction"),
            "INVALID_META", "Invalid initial experience")
    conformance = strict_keys(meta.get("conformance"), {"executable", "declaredOnly"}, "INVALID_META", "conformance")
    combined = []
    for key in ("executable", "declaredOnly"):
        values = conformance.get(key)
        require(isinstance(values, list) and len(values) <= 128
                and all(isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,63}", value)
                        for value in values)
                and len(set(values)) == len(values), "INVALID_META", f"Invalid conformance.{key}")
        combined.extend(values)
    require(len(set(combined)) == len(combined), "INVALID_META", "Conformance sets overlap")
    counts = meta.get("counts")
    if counts is not None:
        counts = strict_keys(counts, {"nodes", "shapes", "leaves", "sourceFrames"}, "INVALID_META", "counts")
        for key, value in counts.items():
            as_int(value, "INVALID_META", f"counts.{key}")
    source = meta.get("sourceArtifact")
    if source is not None:
        source = strict_keys(source, {"byteLength", "decodedByteLength", "digest", "status"}, "INVALID_META", "sourceArtifact")
        as_int(source.get("byteLength"), "INVALID_META", "sourceArtifact.byteLength")
        as_int(source.get("decodedByteLength"), "INVALID_META", "sourceArtifact.decodedByteLength")
        require(isinstance(source.get("status"), str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", source["status"]),
                "INVALID_META", "Invalid sourceArtifact status")
        digest = strict_keys(source.get("digest"), {"algorithm", "value"}, "INVALID_META", "sourceArtifact.digest")
        require(digest.get("algorithm") == "sha256" and isinstance(digest.get("value"), str)
                and re.fullmatch(r"[0-9a-f]{64}", digest["value"]),
                "INVALID_META", "Invalid sourceArtifact digest")


def validate_resources(catalog: Any, limits: dict[str, int]) -> tuple[list[dict], dict[str, dict]]:
    catalog = strict_keys(catalog, {"version", "resources"}, "INVALID_RESOURCES", "RCRD")
    require(as_int(catalog.get("version"), "UNSUPPORTED_RESOURCE_SCHEMA", "RCRD version") == 0,
            "UNSUPPORTED_RESOURCE_SCHEMA", "RCRD version must be zero")
    records = catalog.get("resources")
    require(isinstance(records, list) and len(records) <= limits["resources"],
            "RESOURCE_COUNT_LIMIT", "Resource count is invalid")
    by_id, previous, total, total_image_pixels, external_paths = {}, "", 0, 0, set()
    for index, record in enumerate(records):
        record = strict_keys(record, {"id", "kind", "mediaType", "byteLength", "dimensions", "digest", "path"},
                             "INVALID_RESOURCE", f"resource {index}")
        rid = resource_id(record.get("id"), f"resource {index} id")
        require(rid > previous and rid not in by_id, "RESOURCE_ORDER", "Resources are not strictly sorted")
        previous = rid
        kind, media = record.get("kind"), record.get("mediaType")
        require(kind in ("stylesheet", "image") and media in MEDIA_TYPES,
                "UNSUPPORTED_MEDIA_TYPE", f"Resource {rid} kind/media is invalid")
        require((kind == "stylesheet" and media == "text/css;charset=utf-8")
                or (kind == "image" and media.startswith("image/")),
                "RESOURCE_KIND_MEDIA_MISMATCH", f"Resource {rid} kind/media mismatch")
        size = as_int(record.get("byteLength"), "INVALID_RESOURCE_SIZE", f"resource {rid} size")
        require(size <= limits["resource"], "INVALID_RESOURCE_SIZE", f"Resource {rid} is too large")
        total += size
        require(total <= limits["resource_total"], "AGGREGATE_RESOURCE_LIMIT", "Resources are too large")
        if kind == "image":
            dimensions = strict_keys(record.get("dimensions"), {"width", "height"},
                                     "INVALID_RESOURCE_DIMENSIONS", f"resource {rid} dimensions")
            width = as_int(dimensions.get("width"), "INVALID_RESOURCE_DIMENSIONS", "image width", 1)
            height = as_int(dimensions.get("height"), "INVALID_RESOURCE_DIMENSIONS", "image height", 1)
            require(width <= 16384 and height <= 16384 and width * height <= 64 * 1024 * 1024,
                    "IMAGE_DIMENSION_LIMIT", f"Resource {rid} dimensions are excessive")
            total_image_pixels += width * height
            require(total_image_pixels <= limits["image_pixels_total"],
                    "AGGREGATE_IMAGE_PIXEL_LIMIT", "Aggregate decoded image pixels are excessive")
        else:
            require("dimensions" not in record, "UNEXPECTED_RESOURCE_DIMENSIONS", "Non-image has dimensions")
        digest = strict_keys(record.get("digest"), {"algorithm", "value"}, "INVALID_RESOURCE_DIGEST", f"resource {rid} digest")
        require(digest.get("algorithm") == "sha256" and isinstance(digest.get("value"), str)
                and re.fullmatch(r"[0-9a-f]{64}", digest["value"]),
                "INVALID_RESOURCE_DIGEST", f"Resource {rid} digest is invalid")
        path = safe_path(record.get("path"), f"resource {rid} path")
        portable_path = path.lower()
        require(portable_path not in external_paths, "DUPLICATE_RESOURCE_PATH",
                f"Resource path {path} has a case-insensitive alias")
        require(all(not portable_path.startswith(existing + "/") and not existing.startswith(portable_path + "/")
                    for existing in external_paths), "RESOURCE_PATH_COLLISION",
                f"Resource path {path} has a file/directory collision")
        external_paths.add(portable_path)
        by_id[rid] = record
    return records, by_id


def validate_tree(tree: Any, resources: dict[str, dict], limits: dict[str, int]) -> tuple[list[dict], set[str]]:
    tree = strict_keys(tree, {"version", "mount", "nodes"}, "INVALID_TREE", "TREE")
    require(as_int(tree.get("version"), "UNSUPPORTED_TREE_SCHEMA", "TREE version") == 0,
            "UNSUPPORTED_TREE_SCHEMA", "TREE version must be zero")
    mount = strict_keys(tree.get("mount"), {"behavior", "attributes", "styles", "resourceStyles"}, "INVALID_MOUNT", "TREE mount")
    require(mount.get("behavior") == "replace-children", "INVALID_MOUNT", "Unsupported mount behavior")
    attributes = mount.get("attributes")
    require(isinstance(attributes, list) and len(attributes) <= 32, "INVALID_MOUNT", "Mount attributes invalid")
    names = set()
    for entry in attributes:
        require(isinstance(entry, list) and len(entry) == 2 and all(isinstance(x, str) for x in entry),
                "INVALID_MOUNT", "Mount attribute row is invalid")
        name, value = entry
        require(name not in ("data-domformat-instance", "data-domformat-mount-surface")
                and (name in ALLOWED_ATTRIBUTES or re.fullmatch(r"data-[a-z][a-z0-9._:-]{0,63}", name))
                and name not in names and len(value) <= 1024,
                "UNSAFE_ATTRIBUTE", f"Mount attribute {name} is invalid")
        names.add(name)
    nodes = tree.get("nodes")
    require(isinstance(nodes, list) and len(nodes) <= limits["nodes"], "NODE_COUNT_LIMIT", "Node count invalid")
    ids, depths, siblings, parent_indices = set(), [], {}, set()
    for index, node in enumerate(nodes):
        node = strict_keys(node, {"index", "id", "parent", "sibling", "namespace", "name", "classes",
                                  "attributes", "styles", "resourceAttributes", "resourceStyles"},
                           "INVALID_NODE", f"node {index}")
        require(as_int(node.get("index"), "NODE_INDEX", f"node {index} index") == index,
                "NODE_INDEX", f"Node {index} index is noncanonical")
        nid = stable_id(node.get("id"), f"node {index} id")
        require(nid not in ids, "DUPLICATE_NODE_ID", f"Node id {nid} is duplicated")
        ids.add(nid)
        parent = as_int(node.get("parent"), "INVALID_PARENT", f"node {nid} parent", -1)
        require(parent == -1 or parent < index, "INVALID_PARENT", f"Node {nid} parent is invalid")
        if parent >= 0:
            parent_indices.add(parent)
        sibling = as_int(node.get("sibling"), "INVALID_SIBLING", f"node {nid} sibling")
        expected = siblings.get(parent, 0)
        require(sibling == expected, "INVALID_SIBLING", f"Node {nid} sibling is invalid")
        siblings[parent] = expected + 1
        depth = 1 if parent == -1 else depths[parent] + 1
        require(depth <= limits["depth"], "TREE_DEPTH_LIMIT", f"Node {nid} is too deep")
        depths.append(depth)
        require(node.get("namespace") == "http://www.w3.org/1999/xhtml" and node.get("name") in ALLOWED_ELEMENTS,
                "FORBIDDEN_ELEMENT", f"Node {nid} element is invalid")
        classes = node.get("classes", [])
        require(isinstance(classes, list) and len(classes) <= 32
                and all(isinstance(token, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", token) for token in classes)
                and len(set(classes)) == len(classes),
                "INVALID_CLASS", f"Node {nid} classes are invalid")
        attrs = node.get("attributes", {})
        require(isinstance(attrs, dict) and len(attrs) <= 32, "INVALID_ATTRIBUTES", f"Node {nid} attributes invalid")
        for name, value in attrs.items():
            require(not name.lower().startswith("on")
                    and name not in ("class", "srcdoc", "style", "data-domformat-instance", "data-domformat-mount-surface")
                    and (name in ALLOWED_ATTRIBUTES or re.fullmatch(r"data-[a-z][a-z0-9._:-]{0,63}", name))
                    and isinstance(value, str) and len(value) <= 1024,
                    "UNSAFE_ATTRIBUTE", f"Node {nid} attribute {name} is invalid")
        styles = node.get("styles", {})
        require(isinstance(styles, dict) and len(styles) <= 64, "INVALID_STYLES", f"Node {nid} styles invalid")
        for name, value in styles.items():
            require(name in ALLOWED_STYLES, "UNSAFE_STYLE_PROPERTY", f"Node {nid} style {name} invalid")
            safe_style(value, f"Node {nid} style {name}")
        resource_attrs = node.get("resourceAttributes", {})
        require(isinstance(resource_attrs, dict), "INVALID_RESOURCE_ATTRIBUTES", "Resource attributes invalid")
        for name, rid in resource_attrs.items():
            require(name == "src" and rid in resources and resources[rid]["kind"] == "image",
                    "RESOURCE_ROLE_MISMATCH", f"Node {nid} resource attribute is invalid")
        validate_resource_styles(node.get("resourceStyles", {}), resources, f"node {nid}")
    for node in nodes:
        if node["index"] not in parent_indices:
            require(node.get("attributes", {}).get("aria-hidden") == "true", "ACCESSIBILITY_REQUIRED",
                    f"Terminal visual node {node['id']} must be aria-hidden")
    styles = mount.get("styles", {})
    require(isinstance(styles, dict), "INVALID_MOUNT", "Mount styles invalid")
    for name, value in styles.items():
        require(name in ALLOWED_MOUNT_STYLES, "UNSAFE_STYLE_PROPERTY", f"Mount style {name} invalid")
        safe_style(value, f"Mount style {name}")
        if name == "position":
            require(value == "relative", "INVALID_MOUNT", "Mount position must be relative")
    validate_resource_styles(mount.get("resourceStyles", {}), resources, "mount")
    return nodes, ids


def validate_resource_styles(styles: Any, resources: dict[str, dict], label: str) -> None:
    require(isinstance(styles, dict), "INVALID_RESOURCE_STYLES", f"{label} resource styles invalid")
    for name, binding in styles.items():
        require(name == "backgroundImage", "UNSAFE_STYLE_PROPERTY", f"{label} resource style invalid")
        binding = strict_keys(binding, {"resource", "syntax", "overlayOpacity"}, "INVALID_RESOURCE_STYLE", f"{label} resource style")
        rid = binding.get("resource")
        require(rid in resources and resources[rid]["kind"] == "image", "RESOURCE_ROLE_MISMATCH", f"{label} image resource invalid")
        syntax = binding.get("syntax")
        require(syntax in ("url", "overlay-url"), "INVALID_RESOURCE_STYLE", f"{label} syntax invalid")
        if syntax == "overlay-url":
            opacity = binding.get("overlayOpacity")
            require(not isinstance(opacity, bool) and isinstance(opacity, (int, float))
                    and math.isfinite(opacity) and 0 <= opacity <= 1,
                    "INVALID_RESOURCE_STYLE", f"{label} overlay opacity invalid")
        else:
            require("overlayOpacity" not in binding, "INVALID_RESOURCE_STYLE", f"{label} URL has overlay opacity")


def collect_targets(value: Any, output: list[str], maximum: int, label: str,
                    maximum_depth: int = 64) -> None:
    stack: list[tuple[Any, int]] = [(value, 0)]
    visited: set[int] = set()
    structural_maximum = maximum * 4 + maximum_depth
    containers = 0
    entries = 0
    while stack:
        current, depth = stack.pop()
        if isinstance(current, str):
            output.append(current)
            require(len(output) <= maximum, "TARGET_CARDINALITY_MISMATCH",
                    f"{label} exceeds its target limit")
            continue
        require(isinstance(current, (list, dict)), "INVALID_TARGETS",
                f"{label} contains a non-target value")
        require(depth < maximum_depth, "TARGET_DEPTH_LIMIT",
                f"{label} exceeds its nesting limit")
        identity = id(current)
        require(identity not in visited, "INVALID_TARGETS",
                f"{label} contains repeated or cyclic target groups")
        visited.add(identity)
        containers += 1
        require(containers <= structural_maximum, "TARGET_CARDINALITY_MISMATCH",
                f"{label} has too many target containers")
        current_entries = current if isinstance(current, list) else list(current.values())
        entries += len(current_entries)
        require(entries <= structural_maximum, "TARGET_CARDINALITY_MISMATCH",
                f"{label} has too many target entries")
        for item in reversed(current_entries):
            stack.append((item, depth + 1))


def validate_playback_contract(state_channel: dict, binding: dict,
                               binding_inputs: dict[str, dict],
                               limits: dict[str, int]) -> dict:
    code = "INVALID_PLAYBACK_STATE"
    exact_array(binding.get("inputs"), ["time.tick"], "INVALID_PLAYBACK_BINDING",
                "Playback inputs are incomplete or noncanonical")
    tick_input = binding_inputs.get("time.tick", {})
    require(tick_input.get("type") == "uint" and "default" not in tick_input,
            "INVALID_PLAYBACK_BINDING",
            "Playback time.tick input must be uint without a package default")
    exact_array(binding.get("sinks"), ["style.transform", "style.visibility"],
                "INVALID_PLAYBACK_BINDING", "Playback sinks are incomplete or noncanonical")
    targets = strict_keys(binding.get("targets"), {"model", "shapes", "leaves"},
                          "INVALID_PLAYBACK_BINDING", "playback targets")
    require(set(targets) == {"model", "shapes", "leaves"},
            "INVALID_PLAYBACK_BINDING", "Playback targets are incomplete")
    stable_id(targets.get("model"), "playback model target")
    shapes = unique_targets(targets.get("shapes"), limits["nodes"],
                            "INVALID_PLAYBACK_BINDING", "playback shape")
    leaves = unique_targets(targets.get("leaves"), min(limits["nodes"], 0x10000),
                            "INVALID_PLAYBACK_BINDING", "playback leaf")
    parameters = strict_keys(binding.get("parameters"), {"baseSceneTransform", "frameCount", "tickRateHz"},
                             "INVALID_PLAYBACK_BINDING", "playback parameters")
    require(set(parameters) == {"baseSceneTransform", "frameCount", "tickRateHz"},
            "INVALID_PLAYBACK_BINDING", "Playback parameters are incomplete")
    safe_style(parameters.get("baseSceneTransform"), "Playback base scene transform")
    frame_count = as_int(parameters.get("frameCount"), "FRAME_CARDINALITY_MISMATCH",
                         "playback frameCount", 1)
    require(frame_count <= limits["frames"], "FRAME_CARDINALITY_MISMATCH",
            "Playback frameCount is excessive")
    require(parameters.get("tickRateHz") == 30, "INVALID_PLAYBACK_BINDING",
            "Playback tickRateHz must be 30")

    data = strict_keys(state_channel.get("data"), {"packet", "leafFit"}, code,
                       "playback state data")
    require(set(data) == {"packet", "leafFit"}, code, "Playback state data is incomplete")
    packet = strict_keys(data.get("packet"), {
        "version", "layout", "shapeCount", "leafCount", "appearances", "timeline",
        "initial", "frameRows", "shapeChanges", "leafChanges", "transforms",
    }, code, "playback packet")
    require(set(packet) == {
        "version", "layout", "shapeCount", "leafCount", "appearances", "timeline",
        "initial", "frameRows", "shapeChanges", "leafChanges", "transforms",
    }, code, "Playback packet is incomplete")
    require(packet.get("version") == 0 and packet.get("layout") == "delta-component-streams@0",
            code, "Playback packet version or layout is unsupported")
    shape_count = as_int(packet.get("shapeCount"), "TARGET_CARDINALITY_MISMATCH",
                         "playback shapeCount")
    leaf_count = as_int(packet.get("leafCount"), "TARGET_CARDINALITY_MISMATCH",
                        "playback leafCount")
    require(shape_count <= limits["nodes"] and leaf_count <= min(limits["nodes"], 0x10000),
            "TARGET_CARDINALITY_MISMATCH", "Playback target count is excessive")
    require(len(shapes) == shape_count and len(leaves) == leaf_count,
            "TARGET_CARDINALITY_MISMATCH", "Playback targets do not match declared counts")
    require(leaf_count * frame_count <= limits["visibility_cells"],
            "VISIBILITY_ALLOCATION_LIMIT", "Playback visibility matrix is excessive")

    leaf_fit = data.get("leafFit")
    require(isinstance(leaf_fit, list) and len(leaf_fit) == leaf_count,
            "TARGET_CARDINALITY_MISMATCH", "Playback leafFit does not match leafCount")
    for index, fit in enumerate(leaf_fit):
        fit = strict_keys(fit, {"canonicalSize"}, code, f"playback leafFit {index}")
        require(set(fit) == {"canonicalSize"}
                and is_safe_int(fit.get("canonicalSize"), 1, 0xffff),
                code, f"Playback leafFit {index} is invalid")

    appearances = packet.get("appearances")
    require(isinstance(appearances, list) and 0 < len(appearances) <= limits["frames"],
            code, "Playback appearances are missing or excessive")
    appearance_ids = set()
    for index, appearance in enumerate(appearances):
        require(isinstance(appearance, list) and len(appearance) == 3,
                code, f"Playback appearance {index} is malformed")
        aid = stable_id(appearance[0], f"playback appearance {index} id")
        require(aid not in appearance_ids, code, f"Playback appearance {aid} is duplicated")
        appearance_ids.add(aid)
        require(finite_f32(appearance[1]) and appearance[1] > 0
                and finite_f32(appearance[2]), code,
                f"Playback appearance {index} values are invalid")

    transforms = strict_keys(packet.get("transforms"), {"count", "groups"}, code,
                             "playback transform table")
    require(set(transforms) == {"count", "groups"}, code,
            "Playback transform table is incomplete")
    transform_count = as_int(transforms.get("count"), "TRANSFORM_ALLOCATION_LIMIT",
                             "playback transform count", 1)
    require(transform_count <= limits["prepared_transforms"], "TRANSFORM_ALLOCATION_LIMIT",
            "Playback transform count is excessive")
    groups = transforms.get("groups")
    require(isinstance(groups, list) and len(groups) <= limits["nodes"],
            "TRANSFORM_ALLOCATION_LIMIT", "Playback transform groups are excessive")

    initial = strict_keys(packet.get("initial"),
                          {"sourceFrame", "appearance", "modelTransform", "shapes", "leaves"},
                          code, "playback initial state")
    require(set(initial) == {"sourceFrame", "appearance", "modelTransform", "shapes", "leaves"},
            code, "Playback initial state is incomplete")
    initial_source = as_int(initial.get("sourceFrame"), "FRAME_CARDINALITY_MISMATCH",
                            "playback initial sourceFrame", 1)
    require(initial_source <= frame_count, "FRAME_CARDINALITY_MISMATCH",
            "Playback initial source frame is invalid")
    initial_appearance = as_int(initial.get("appearance"), code,
                                "playback initial appearance")
    require(initial_appearance < len(appearances), code,
            "Playback initial appearance is invalid")
    initial_model = as_int(initial.get("modelTransform"), code,
                           "playback initial model transform")
    require(initial_model < transform_count, code,
            "Playback initial model transform is invalid")
    initial_shapes = strict_keys(initial.get("shapes"), {"count", "transforms", "visibility"},
                                 code, "playback initial shapes")
    require(set(initial_shapes) == {"count", "transforms", "visibility"}
            and initial_shapes.get("count") == shape_count,
            "TARGET_CARDINALITY_MISMATCH", "Playback initial shapes do not match shapeCount")
    initial_shape_transforms = cumulative_references(
        initial_shapes.get("transforms"), shape_count, code, "playback initial shape transforms")
    shape_visibility = integer_array(initial_shapes.get("visibility"), shape_count, code,
                                     "playback initial shape visibility", 0, 1)
    require(len(shape_visibility) == shape_count, "TARGET_CARDINALITY_MISMATCH",
            "Playback initial shape visibility does not match shapeCount")
    initial_leaves = strict_keys(initial.get("leaves"), {"count", "transforms"},
                                 code, "playback initial leaves")
    require(set(initial_leaves) == {"count", "transforms"}
            and initial_leaves.get("count") == leaf_count,
            "TARGET_CARDINALITY_MISMATCH", "Playback initial leaves do not match leafCount")
    initial_leaf_transforms = cumulative_references(
        initial_leaves.get("transforms"), leaf_count, code, "playback initial leaf transforms")
    require(all(index < transform_count
                for index in initial_shape_transforms + initial_leaf_transforms),
            code, "Playback initial state references a missing transform")

    timeline = strict_keys(packet.get("timeline"), {"introTicks", "loopTicks", "frames"},
                           code, "playback timeline")
    require(set(timeline) == {"introTicks", "loopTicks", "frames"}, code,
            "Playback timeline is incomplete")
    intro_ticks = as_int(timeline.get("introTicks"), "TIMELINE_LIMIT",
                         "playback introTicks")
    loop_ticks = as_int(timeline.get("loopTicks"), "TIMELINE_LIMIT",
                        "playback loopTicks", 1)
    timeline_frames = integer_array(timeline.get("frames"), limits["timeline_ticks"],
                                    "TIMELINE_LIMIT", "playback timeline frames", 1, frame_count)
    require(len(timeline_frames) == intro_ticks + loop_ticks and timeline_frames
            and timeline_frames[0] == initial_source,
            "TIMELINE_LIMIT", "Playback timeline coverage is invalid")

    shape_changes = strict_keys(packet.get("shapeChanges"),
                                {"sources", "transforms", "visibility"}, code,
                                "playback shape changes")
    leaf_changes = strict_keys(packet.get("leafChanges"), {"sources", "transforms"},
                               code, "playback leaf changes")
    require(set(shape_changes) == {"sources", "transforms", "visibility"}
            and set(leaf_changes) == {"sources", "transforms"}, code,
            "Playback change tables are incomplete")
    shape_sources = integer_array(shape_changes.get("sources"), limits["prepared_changes"],
                                  "STATE_CHANGE_LIMIT", "playback shape sources")
    shape_transforms = integer_array(shape_changes.get("transforms"), limits["prepared_changes"],
                                     "STATE_CHANGE_LIMIT", "playback shape transform deltas")
    shape_visibility_changes = integer_array(
        shape_changes.get("visibility"), limits["prepared_changes"],
        "STATE_CHANGE_LIMIT", "playback shape visibility", 0, 1)
    leaf_sources = integer_array(leaf_changes.get("sources"), limits["prepared_changes"],
                                 "STATE_CHANGE_LIMIT", "playback leaf sources")
    leaf_transforms = integer_array(leaf_changes.get("transforms"), limits["prepared_changes"],
                                    "STATE_CHANGE_LIMIT", "playback leaf transform deltas")
    require(len(shape_sources) == len(shape_transforms) == len(shape_visibility_changes)
            and len(leaf_sources) == len(leaf_transforms), "STATE_COLUMN_MISMATCH",
            "Playback change-table columns have unequal lengths")

    rows = packet.get("frameRows")
    require(isinstance(rows, list) and len(rows) == frame_count,
            "FRAME_CARDINALITY_MISMATCH", "Playback frame rows do not match frameCount")
    owners: list[str | None] = [None] * transform_count

    def claim(index: int, owner: str, label: str) -> None:
        require(is_safe_int(index, 0, transform_count - 1), code,
                f"{label} references a missing transform")
        old = owners[int(index)]
        require(old is None or old == owner
                or (old.startswith("shape:") and owner.startswith("shape:")),
                "TRANSFORM_GROUP_MISMATCH", f"{label} aliases incompatible owners")
        if old is None:
            owners[int(index)] = owner

    claim(initial_model, "model", "playback initial model")
    for index, transform in enumerate(initial_shape_transforms):
        claim(transform, f"shape:{index}", f"playback initial shape {index}")
    for index, transform in enumerate(initial_leaf_transforms):
        claim(transform, f"leaf:{index}", f"playback initial leaf {index}")
    shape_cursor = leaf_cursor = shape_transform = leaf_transform = 0
    for index, row in enumerate(rows):
        require(isinstance(row, list) and len(row) == 7
                and all(is_safe_int(value) for value in row) and int(row[0]) == index + 1,
                "INVALID_FRAME_ROW", f"Playback frame row {index} is malformed")
        row = [int(value) for value in row]
        require(0 <= row[1] < len(appearances), "INVALID_FRAME_ROW",
                f"Playback frame row {index} appearance is invalid")
        require(row[2] == -1 or 0 <= row[2] < transform_count, "INVALID_FRAME_ROW",
                f"Playback frame row {index} model transform is invalid")
        if row[2] != -1:
            claim(row[2], "model", f"playback frame row {index} model")
        require(row[3] == shape_cursor and row[4] >= 0
                and row[3] + row[4] <= len(shape_sources), "STATE_COLUMN_MISMATCH",
                f"Playback frame row {index} shape range is noncanonical")
        shape = 0
        for cursor in range(row[3], row[3] + row[4]):
            shape += shape_sources[cursor]
            shape_transform += shape_transforms[cursor]
            require(0 <= shape < shape_count, "STATE_COLUMN_MISMATCH",
                    f"Playback frame row {index} shape index is invalid")
            claim(shape_transform, f"shape:{shape}",
                  f"playback frame row {index} shape {shape}")
        shape_cursor += row[4]
        require(row[5] == leaf_cursor and row[6] >= 0
                and row[5] + row[6] <= len(leaf_sources), "STATE_COLUMN_MISMATCH",
                f"Playback frame row {index} leaf range is noncanonical")
        leaf = 0
        for cursor in range(row[5], row[5] + row[6]):
            leaf += leaf_sources[cursor]
            leaf_transform += leaf_transforms[cursor]
            require(0 <= leaf < leaf_count, "STATE_COLUMN_MISMATCH",
                    f"Playback frame row {index} leaf index is invalid")
            claim(leaf_transform, f"leaf:{leaf}",
                  f"playback frame row {index} leaf {leaf}")
        leaf_cursor += row[6]
    require(shape_cursor == len(shape_sources) and leaf_cursor == len(leaf_sources),
            "STATE_COLUMN_MISMATCH", "Playback change tables have unreferenced rows")
    require(all(owner is not None for owner in owners), "TRANSFORM_GROUP_MISMATCH",
            "Playback transform table has unowned rows")

    inferred: dict[str, list[int]] = {}
    for index, owner in enumerate(owners):
        inferred.setdefault(str(owner), []).append(index)
    require(len(groups) == len(inferred), "TRANSFORM_GROUP_MISMATCH",
            "Playback transform groups do not match inferred owners")
    for group_index, ((owner, indices), group) in enumerate(zip(inferred.items(), groups)):
        group = strict_keys(group, {"encoding", "empty", "scales", "columns"}, code,
                            f"playback transform group {group_index}")
        require(set(group) == {"encoding", "empty", "scales", "columns"}, code,
                f"Playback transform group {group_index} is incomplete")
        encoding = group.get("encoding")
        require(encoding in ("decimal-component-streams", "source-milli-fitted-leaf"),
                code, f"Playback transform group {group_index} encoding is unsupported")
        require(encoding != "source-milli-fitted-leaf" or owner.startswith("leaf:"),
                "TRANSFORM_GROUP_MISMATCH", "Playback fitted transform has a non-leaf owner")
        empty = integer_array(group.get("empty"), len(indices), code,
                              f"playback transform group {group_index} empty rows",
                              0, max(0, len(indices) - 1), True)
        require(all(empty[position - 1] < value
                    for position, value in enumerate(empty) if position > 0), code,
                f"Playback transform group {group_index} empty rows are unsorted")
        scales = integer_array(group.get("scales"), 12, code,
                               f"playback transform group {group_index} scales", 0)
        require(len(scales) == 12, code,
                f"Playback transform group {group_index} scales are invalid")
        require(encoding != "source-milli-fitted-leaf" or all(scale == 1000 for scale in scales),
                code, f"Playback fitted transform group {group_index} has invalid scales")
        columns = group.get("columns")
        present_count = len(indices) - len(empty)
        require(isinstance(columns, list) and len(columns) == 12, code,
                f"Playback transform group {group_index} must have 12 columns")
        for column_index, column in enumerate(columns):
            require(isinstance(column, list) and len(column) == present_count
                    and all(not isinstance(value, bool) and isinstance(value, (int, float))
                            and math.isfinite(value) for value in column), code,
                    f"Playback transform group {group_index} column {column_index} is invalid")
            if scales[column_index] > 0:
                current = 0
                for delta in column:
                    require(is_safe_int(delta), code,
                            f"Playback scaled column {column_index} contains a noninteger delta")
                    current += int(delta)
                    require(is_safe_int(current) and math.isfinite(current / scales[column_index]),
                            code, f"Playback scaled column {column_index} overflows")
    return packet


def validate_surface_contract(state_channel: dict, binding: dict,
                              playback_packet: dict, playback_binding: dict,
                              binding_inputs: dict[str, dict],
                              limits: dict[str, int]) -> dict:
    code = "INVALID_SURFACE_STATE"
    exact_array(binding.get("inputs"), ["time.source-frame"], "INVALID_SURFACE_BINDING",
                "Surface inputs are incomplete or noncanonical")
    source_frame_input = binding_inputs.get("time.source-frame", {})
    require(source_frame_input.get("type") == "uint" and "default" not in source_frame_input,
            "INVALID_SURFACE_BINDING",
            "Surface time.source-frame input must be uint without a package default")
    exact_array(binding.get("sinks"), ["style.backgroundPositionY", "style.visibility"],
                "INVALID_SURFACE_BINDING", "Surface sinks are incomplete or noncanonical")
    require("parameters" not in binding, "INVALID_SURFACE_BINDING",
            "Surface binding must not declare parameters")
    targets = strict_keys(binding.get("targets"), {"leaves"},
                          "INVALID_SURFACE_BINDING", "surface targets")
    require(set(targets) == {"leaves"}, "INVALID_SURFACE_BINDING",
            "Surface targets are incomplete")
    leaves = unique_targets(targets.get("leaves"), min(limits["nodes"], 0x10000),
                            "INVALID_SURFACE_BINDING", "surface leaf")
    playback_leaves = playback_binding["targets"]["leaves"]
    leaf_count = int(playback_packet["leafCount"])
    require(leaves == playback_leaves and len(leaves) == leaf_count,
            "TARGET_CARDINALITY_MISMATCH",
            "Surface leaves must exactly match playback leaves")

    data = strict_keys(state_channel.get("data"), {"packet"}, code, "surface state data")
    require(set(data) == {"packet"}, code, "Surface state data is incomplete")
    packet = strict_keys(data.get("packet"),
                         {"version", "frameCount", "surface", "transitions", "visibility"},
                         code, "surface packet")
    require(set(packet) == {"version", "frameCount", "surface", "transitions", "visibility"},
            code, "Surface packet is incomplete")
    frame_count = int(playback_binding["parameters"]["frameCount"])
    require(packet.get("version") == 0 and packet.get("frameCount") == frame_count,
            "FRAME_CARDINALITY_MISMATCH", "Surface version or frameCount is invalid")

    surface = strict_keys(packet.get("surface"), {"faces", "statePacking"},
                          code, "surface table")
    require(set(surface) == {"faces", "statePacking"}, code,
            "Surface table is incomplete")
    faces = surface.get("faces")
    require(isinstance(faces, list) and len(faces) == leaf_count,
            "TARGET_CARDINALITY_MISMATCH", "Surface faces do not match leafCount")
    packing = strict_keys(surface.get("statePacking"), {"stateCount", "sourceFrameDeltas"},
                          code, "surface state packing")
    require(set(packing) == {"stateCount", "sourceFrameDeltas"}, code,
            "Surface state packing is incomplete")
    state_count = as_int(packing.get("stateCount"), "SURFACE_STATE_LIMIT",
                         "surface stateCount")
    require(state_count <= limits["prepared_states"], "SURFACE_STATE_LIMIT",
            "Surface stateCount is excessive")
    source_deltas = integer_array(packing.get("sourceFrameDeltas"),
                                  limits["prepared_states"], "SURFACE_STATE_LIMIT",
                                  "surface source-frame deltas", 0, max(0, frame_count - 1))
    require(len(source_deltas) == state_count, "STATE_COLUMN_MISMATCH",
            "Surface source-frame deltas do not match stateCount")
    face_ids, state_offset = set(), 0
    source_frames_by_face: list[list[int]] = []
    for index, face in enumerate(faces):
        face = strict_keys(face, {"faceId", "sourceOrder", "stateOffset", "stateCount",
                                  "leafWidth", "leafHeight"}, code, f"surface face {index}")
        require(set(face) == {"faceId", "sourceOrder", "stateOffset", "stateCount",
                              "leafWidth", "leafHeight"}, code,
                f"Surface face {index} is incomplete")
        face_id = stable_id(face.get("faceId"), f"surface face {index} id")
        require(face_id not in face_ids and face.get("sourceOrder") == index,
                code, f"Surface face {index} identity or order is invalid")
        face_ids.add(face_id)
        local_count = as_int(face.get("stateCount"), "STATE_COLUMN_MISMATCH",
                             f"surface face {index} stateCount", 1)
        require(face.get("stateOffset") == state_offset
                and state_offset + local_count <= state_count,
                "STATE_COLUMN_MISMATCH",
                f"Surface face {index} state range is noncanonical")
        require(is_safe_int(face.get("leafWidth"), 1, 0xffff)
                and is_safe_int(face.get("leafHeight"), 1, 0xffff), code,
                f"Surface face {index} dimensions are invalid")
        source_frame = 0
        source_frames: list[int] = []
        for local in range(local_count):
            delta = source_deltas[state_offset + local]
            require(delta == 0 if local == 0 else delta > 0, code,
                    f"Surface face {index} source deltas are noncanonical")
            source_frame += delta
            require(source_frame < frame_count, code,
                    f"Surface face {index} state exceeds frameCount")
            source_frames.append(source_frame)
        source_frames_by_face.append(source_frames)
        state_offset += local_count
    require(state_offset == state_count, "STATE_COLUMN_MISMATCH",
            "Surface state table has unreferenced rows")

    transitions = strict_keys(packet.get("transitions"),
                               {"initialFrame", "sequential", "nonInteractiveJumps"},
                               code, "surface transitions")
    require(set(transitions) == {"initialFrame", "sequential", "nonInteractiveJumps"},
            code, "Surface transitions are incomplete")
    require(transitions.get("initialFrame") == 1
            and transitions.get("initialFrame") == playback_packet["initial"]["sourceFrame"],
            "FRAME_CARDINALITY_MISMATCH",
            "Surface initial frame must be frame 1 and match playback")
    sequential = strict_keys(transitions.get("sequential"),
                             {"offsetsBase64", "faceIndexDeltas", "stateIndexDeltas"},
                             code, "surface sequential transitions")
    require(set(sequential) == {"offsetsBase64", "faceIndexDeltas", "stateIndexDeltas"},
            code, "Surface sequential transitions are incomplete")
    face_deltas = integer_array(sequential.get("faceIndexDeltas"),
                                limits["prepared_changes"], "STATE_CHANGE_LIMIT",
                                "surface face-index deltas", 0,
                                max(0, leaf_count - 1))
    state_deltas = integer_array(sequential.get("stateIndexDeltas"),
                                 limits["prepared_changes"], "STATE_CHANGE_LIMIT",
                                 "surface state-index deltas", 0, 0xffff)
    require(len(face_deltas) == len(state_deltas), "STATE_COLUMN_MISMATCH",
            "Surface transition columns have unequal lengths")
    offsets = base64_integers(sequential.get("offsetsBase64"), 4, frame_count + 1,
                              code, "surface transition offsets")
    require(len(offsets) == frame_count + 1 and offsets[0] == 0
            and offsets[-1] == len(face_deltas)
            and all(offsets[index - 1] <= value
                    for index, value in enumerate(offsets) if index > 0),
            "STATE_COLUMN_MISMATCH", "Surface transition offsets are invalid")
    current_states = [0] * leaf_count
    lighting_segments: list[tuple[list[int], list[int]]] = []
    for frame in range(frame_count):
        face_index, previous_face = 0, -1
        segment_faces: list[int] = []
        segment_states: list[int] = []
        for cursor in range(offsets[frame], offsets[frame + 1]):
            face_index += face_deltas[cursor]
            require(0 <= face_index < len(faces) and face_index > previous_face,
                    code, f"Surface transition segment {frame} has invalid face ordering")
            current_states[face_index] += state_deltas[cursor]
            require(current_states[face_index] < faces[face_index]["stateCount"], code,
                    f"Surface transition segment {frame} exceeds face state count")
            segment_faces.append(face_index)
            segment_states.append(current_states[face_index])
            previous_face = face_index
        lighting_segments.append((segment_faces, segment_states))

    jumps = transitions.get("nonInteractiveJumps")
    require(isinstance(jumps, list) and len(jumps) <= frame_count, code,
            "Surface jumps are invalid or excessive")
    jump_pairs = set()
    lighting_jumps: dict[str, tuple[list[int], list[int]]] = {}
    for index, jump in enumerate(jumps):
        jump = strict_keys(jump,
                           {"fromFrame", "toFrame", "faceIndicesBase64", "stateIndicesBase64"},
                           code, f"surface jump {index}")
        require(set(jump) == {"fromFrame", "toFrame", "faceIndicesBase64", "stateIndicesBase64"},
                code, f"Surface jump {index} is incomplete")
        from_frame = as_int(jump.get("fromFrame"), code, f"surface jump {index} fromFrame", 1)
        to_frame = as_int(jump.get("toFrame"), code, f"surface jump {index} toFrame", 1)
        pair = f"{from_frame}>{to_frame}"
        require(from_frame <= frame_count and to_frame <= frame_count
                and from_frame != to_frame and pair not in jump_pairs,
                code, f"Surface jump {index} frames are invalid or duplicated")
        jump_pairs.add(pair)
        jump_faces = base64_integers(jump.get("faceIndicesBase64"), 2,
                                     leaf_count, code,
                                     f"surface jump {index} faces")
        jump_states = base64_integers(jump.get("stateIndicesBase64"), 2,
                                      leaf_count, code,
                                      f"surface jump {index} states")
        require(len(jump_faces) == len(jump_states)
                and all(face < len(faces)
                        and (cursor == 0 or jump_faces[cursor - 1] < face)
                        and jump_states[cursor] < faces[face]["stateCount"]
                        for cursor, face in enumerate(jump_faces)), code,
                f"Surface jump {index} rows are invalid")
        lighting_jumps[pair] = (jump_faces, jump_states)

    visibility = strict_keys(packet.get("visibility"),
                             {"initialFrame", "initialVisibleBitsBase64", "sequential",
                              "nonInteractiveJumps"}, code, "surface visibility")
    require(set(visibility) == {"initialFrame", "initialVisibleBitsBase64", "sequential",
                                "nonInteractiveJumps"}, code,
            "Surface visibility is incomplete")
    require(visibility.get("initialFrame") == transitions["initialFrame"],
            "FRAME_CARDINALITY_MISMATCH",
            "Surface visibility initial frame is invalid")
    initial_bits = base64_integers(visibility.get("initialVisibleBitsBase64"), 1,
                                   math.ceil(leaf_count / 8), code,
                                   "surface initial visibility bitset")
    require(len(initial_bits) == math.ceil(leaf_count / 8), code,
            "Surface initial visibility bitset is truncated")
    for index in range(leaf_count, len(initial_bits) * 8):
        require(((initial_bits[index >> 3] >> (index & 7)) & 1) == 0, code,
                "Surface visibility bitset has nonzero unused bits")
    visibility_sequential = strict_keys(visibility.get("sequential"),
                                        {"offsetsBase64", "faceIndicesBase64"}, code,
                                        "surface sequential visibility")
    require(set(visibility_sequential) == {"offsetsBase64", "faceIndicesBase64"}, code,
            "Surface sequential visibility is incomplete")
    visibility_offsets = base64_integers(visibility_sequential.get("offsetsBase64"), 4,
                                         frame_count + 1, code,
                                         "surface visibility offsets")
    visibility_faces = base64_integers(visibility_sequential.get("faceIndicesBase64"), 2,
                                       limits["prepared_changes"], code,
                                       "surface visibility faces")
    require(len(visibility_offsets) == frame_count + 1 and visibility_offsets[0] == 0
            and visibility_offsets[-1] == len(visibility_faces)
            and all(visibility_offsets[index - 1] <= value
                    for index, value in enumerate(visibility_offsets) if index > 0),
            "STATE_COLUMN_MISMATCH", "Surface visibility offsets are invalid")
    for frame in range(frame_count):
        for cursor in range(visibility_offsets[frame], visibility_offsets[frame + 1]):
            require(visibility_faces[cursor] < leaf_count
                    and (cursor == visibility_offsets[frame]
                         or visibility_faces[cursor - 1] < visibility_faces[cursor]),
                    code, f"Surface visibility segment {frame} is invalid")
    visibility_rows = bytearray(leaf_count * frame_count)
    for face_index in range(leaf_count):
        visibility_rows[face_index] = ((initial_bits[face_index >> 3]
                                        >> (face_index & 7)) & 1)
    for target_frame in range(2, frame_count + 1):
        previous_offset = (target_frame - 2) * leaf_count
        target_offset = (target_frame - 1) * leaf_count
        visibility_rows[target_offset:target_offset + leaf_count] = \
            visibility_rows[previous_offset:previous_offset + leaf_count]
        for cursor in range(visibility_offsets[target_frame - 1],
                            visibility_offsets[target_frame]):
            visibility_rows[target_offset + visibility_faces[cursor]] ^= 1
    if frame_count > 0:
        wrapped = bytearray(visibility_rows[(frame_count - 1) * leaf_count:])
        for cursor in range(visibility_offsets[0], visibility_offsets[1]):
            wrapped[visibility_faces[cursor]] ^= 1
        require(wrapped == visibility_rows[:leaf_count], "SURFACE_TRANSITION_MISMATCH",
                "Surface visibility wrap transition does not reproduce frame 1")
    visibility_jumps = visibility.get("nonInteractiveJumps")
    require(isinstance(visibility_jumps, list) and len(visibility_jumps) <= frame_count,
            code, "Surface visibility jumps are invalid or excessive")
    visibility_pairs = set()
    visibility_jump_rows: dict[str, list[int]] = {}
    for index, jump in enumerate(visibility_jumps):
        jump = strict_keys(jump, {"fromFrame", "toFrame", "faceIndicesBase64"},
                           code, f"surface visibility jump {index}")
        require(set(jump) == {"fromFrame", "toFrame", "faceIndicesBase64"}, code,
                f"Surface visibility jump {index} is incomplete")
        from_frame = as_int(jump.get("fromFrame"), code,
                            f"surface visibility jump {index} fromFrame", 1)
        to_frame = as_int(jump.get("toFrame"), code,
                          f"surface visibility jump {index} toFrame", 1)
        pair = f"{from_frame}>{to_frame}"
        require(from_frame <= frame_count and to_frame <= frame_count
                and from_frame != to_frame and pair not in visibility_pairs,
                code, f"Surface visibility jump {index} is invalid or duplicated")
        visibility_pairs.add(pair)
        jump_faces = base64_integers(jump.get("faceIndicesBase64"), 2,
                                     leaf_count, code,
                                     f"surface visibility jump {index} faces")
        require(all(face < leaf_count
                    and (cursor == 0 or jump_faces[cursor - 1] < face)
                    for cursor, face in enumerate(jump_faces)), code,
                f"Surface visibility jump {index} faces are invalid")
        visibility_jump_rows[pair] = jump_faces
    require(jump_pairs == visibility_pairs, code,
            "Surface lighting and visibility jump pairs differ")

    def state_at(source_frames: list[int], frame_index: int) -> int:
        lower, upper = 0, len(source_frames)
        while lower < upper:
            middle = lower + (upper - lower) // 2
            if source_frames[middle] <= frame_index:
                lower = middle + 1
            else:
                upper = middle
        return lower - 1

    def expected_transition(from_frame: int, to_frame: int) \
            -> tuple[list[int], list[int], list[int]]:
        from_offset = (from_frame - 1) * leaf_count
        to_offset = (to_frame - 1) * leaf_count
        changed_visibility: list[int] = []
        changed_faces: list[int] = []
        changed_states: list[int] = []
        for face_index in range(leaf_count):
            from_visible = visibility_rows[from_offset + face_index]
            to_visible = visibility_rows[to_offset + face_index]
            if from_visible != to_visible:
                changed_visibility.append(face_index)
            from_state = state_at(source_frames_by_face[face_index], from_frame - 1)
            to_state = state_at(source_frames_by_face[face_index], to_frame - 1)
            if to_visible == 1 and (from_visible == 0 or from_state != to_state):
                changed_faces.append(face_index)
                changed_states.append(to_state)
        return changed_visibility, changed_faces, changed_states

    for to_frame in range(1, frame_count + 1):
        from_frame = frame_count if to_frame == 1 else to_frame - 1
        expected_visibility, expected_faces, expected_states = \
            expected_transition(from_frame, to_frame)
        actual_faces, actual_states = lighting_segments[to_frame - 1]
        actual_visibility = visibility_faces[
            visibility_offsets[to_frame - 1]:visibility_offsets[to_frame]]
        require(actual_faces == expected_faces and actual_states == expected_states,
                "SURFACE_TRANSITION_MISMATCH",
                f"Surface lighting transition {from_frame}>{to_frame} is not closed")
        require(actual_visibility == expected_visibility,
                "SURFACE_TRANSITION_MISMATCH",
                f"Surface visibility transition {from_frame}>{to_frame} is not closed")
    for pair in jump_pairs:
        from_frame, to_frame = (int(value) for value in pair.split(">"))
        expected_visibility, expected_faces, expected_states = \
            expected_transition(from_frame, to_frame)
        actual_faces, actual_states = lighting_jumps[pair]
        require(actual_faces == expected_faces and actual_states == expected_states,
                "SURFACE_JUMP_MISMATCH",
                f"Surface lighting jump {pair} contradicts canonical target state")
        require(visibility_jump_rows[pair] == expected_visibility,
                "SURFACE_JUMP_MISMATCH",
                f"Surface visibility jump {pair} contradicts canonical target state")
    return packet


def validate_effects_contract(state_channel: dict, binding: dict,
                              binding_inputs: dict[str, dict],
                              playback_binding: dict | None,
                              limits: dict[str, int]) -> dict:
    code = "INVALID_EFFECTS_STATE"
    require(playback_binding is not None, "MISSING_POLYCSS_CHANNEL",
            "Prepared effects require executable playback")
    expected_inputs = ["interaction.grab-active", "interaction.grab-x",
                       "interaction.grab-y", "interaction.grab-z", "time.source-frame"]
    exact_array(binding.get("inputs"), expected_inputs, "INVALID_EFFECTS_BINDING",
                "Effect inputs are incomplete or noncanonical")
    for input_id, input_type, default in (
        ("interaction.grab-active", "boolean", False),
        ("interaction.grab-x", "float", 0),
        ("interaction.grab-y", "float", 0),
        ("interaction.grab-z", "float", 0),
    ):
        definition = binding_inputs.get(input_id, {})
        require(definition.get("type") == input_type and definition.get("default") == default,
                "INVALID_EFFECTS_BINDING",
                f"Effect input {input_id} has the wrong type or default")
    source_frame_input = binding_inputs.get("time.source-frame", {})
    require(source_frame_input.get("type") == "uint" and "default" not in source_frame_input,
            "INVALID_EFFECTS_BINDING",
            "Effect time.source-frame input must be uint without a package default")
    exact_array(binding.get("sinks"), ["style.backgroundPosition", "style.opacity",
                                      "style.transform", "style.visibility"],
                "INVALID_EFFECTS_BINDING", "Effect sinks are incomplete or noncanonical")
    parameters = strict_keys(binding.get("parameters"), {"frameCount"},
                             "INVALID_EFFECTS_BINDING", "effect parameters")
    require(set(parameters) == {"frameCount"}, "INVALID_EFFECTS_BINDING",
            "Effect parameters are incomplete")
    targets = strict_keys(binding.get("targets"), {"stars", "emitters"},
                          "INVALID_EFFECTS_BINDING", "effect targets")
    require(set(targets) == {"stars", "emitters"}, "INVALID_EFFECTS_BINDING",
            "Effect targets are incomplete")
    star_targets = unique_targets(targets.get("stars"), limits["nodes"],
                                  "INVALID_EFFECTS_BINDING", "effect star")
    emitter_targets = targets.get("emitters")
    require(isinstance(emitter_targets, list) and len(emitter_targets) <= limits["nodes"],
            "INVALID_EFFECTS_BINDING", "Effect emitter targets are invalid or excessive")

    data = strict_keys(state_channel.get("data"), {"packet"}, code,
                       "prepared effects state data")
    require(set(data) == {"packet"}, code, "Prepared effects state is incomplete")
    packet = strict_keys(data.get("packet"), {"version", "arithmetic", "frameCount",
                         "biases", "particle", "spawnStream", "stars", "emitters"},
                         code, "prepared effects packet")
    require(set(packet) == {"version", "arithmetic", "frameCount", "biases", "particle",
                            "spawnStream", "stars", "emitters"}, code,
            "Prepared effects packet is incomplete")
    require(packet.get("version") == 0
            and packet.get("arithmetic") == "ieee754-f32-per-operation", code,
            "Prepared effects version or arithmetic is unsupported")
    frame_count = as_int(packet.get("frameCount"), "EFFECT_STATE_LIMIT",
                         "effect frameCount", 1)
    require(frame_count <= limits["frames"], "EFFECT_STATE_LIMIT",
            "Effect frameCount is excessive")
    require(parameters.get("frameCount") == frame_count,
            "FRAME_CARDINALITY_MISMATCH", "Effect binding frameCount differs from packet")
    require(playback_binding["parameters"]["frameCount"] == frame_count,
            "FRAME_CARDINALITY_MISMATCH",
            "Effect and playback frame counts differ")

    biases = strict_keys(packet.get("biases"), {"continuous", "grab"}, code,
                         "effect biases")
    require(set(biases) == {"continuous", "grab"}, code, "Effect biases are incomplete")
    continuous_bias = finite_f32_array(biases.get("continuous"), 3, code,
                                       "continuous effect bias")
    grab_bias = finite_f32_array(biases.get("grab"), 3, code, "grab effect bias")
    particle = strict_keys(packet.get("particle"), {"damping", "gravityY", "sparkleFrameTable"},
                           code, "particle contract")
    require(set(particle) == {"damping", "gravityY", "sparkleFrameTable"}, code,
            "Particle contract is incomplete")
    require(finite_f32(particle.get("damping")) and 0 <= particle["damping"] <= 1
            and finite_f32(particle.get("gravityY")), code,
            "Particle damping or gravity is invalid")
    sparkle_frames = integer_array(particle.get("sparkleFrameTable"), 256, code,
                                   "particle sparkle frames", 0)
    require(bool(sparkle_frames), code, "Particle sparkle frame table is empty")
    spawn = strict_keys(packet.get("spawnStream"), {"count", "tuples"}, code,
                        "effect spawn stream")
    require(set(spawn) == {"count", "tuples"}, code, "Effect spawn stream is incomplete")
    spawn_count = as_int(spawn.get("count"), "EFFECT_STATE_LIMIT", "effect spawn count", 1)
    tuples = spawn.get("tuples")
    require(spawn_count <= limits["effect_spawn_tuples"] and isinstance(tuples, list)
            and len(tuples) == spawn_count, "EFFECT_STATE_LIMIT",
            "Effect spawn stream is invalid or excessive")
    for index, tuple_value in enumerate(tuples):
        values = finite_f32_array(tuple_value, 4, code, f"effect spawn tuple {index}")
        require(values[0] > 0 and math.trunc(values[0]) <= len(sparkle_frames), code,
                f"Effect spawn tuple {index} lifetime is invalid")
        for bias in (continuous_bias, grab_bias):
            require(all(finite_f32(values[component + 1] + bias[component])
                        for component in range(3)), code,
                    f"Effect spawn tuple {index} overflows with a declared bias")

    stars = packet.get("stars")
    emitters = packet.get("emitters")
    require(isinstance(stars, list) and len(stars) <= limits["nodes"],
            "EFFECT_STATE_LIMIT", "Effect stars are invalid or excessive")
    require(isinstance(emitters, list) and 0 < len(emitters) <= limits["nodes"],
            "EFFECT_STATE_LIMIT", "Effect emitters are invalid or excessive")
    require(len(stars) == len(star_targets) and len(emitters) == len(emitter_targets),
            "TARGET_CARDINALITY_MISMATCH", "Effect targets do not match state")
    total_particles = 0
    for index, emitter in enumerate(emitters):
        emitter = strict_keys(emitter,
                              {"mode", "sourceStar", "poolSize", "backgroundPositions"},
                              code, f"effect emitter {index}")
        mode = emitter.get("mode")
        require(mode in ("grab", "follow-star"), code,
                f"Effect emitter {index} mode is unsupported")
        if mode == "grab":
            require("sourceStar" not in emitter, code,
                    f"Grab emitter {index} must not declare sourceStar")
        else:
            require(is_safe_int(emitter.get("sourceStar"), 0, len(stars) - 1), code,
                    f"Effect emitter {index} sourceStar is invalid")
        pool_size = as_int(emitter.get("poolSize"), code,
                           f"effect emitter {index} poolSize", 1)
        total_particles += pool_size
        require(total_particles <= limits["effect_particles"], "EFFECT_PARTICLE_LIMIT",
                "Prepared effects have too many particles")
        positions = emitter.get("backgroundPositions")
        require(isinstance(positions, list) and 0 < len(positions) <= 256, code,
                f"Effect emitter {index} background positions are missing or excessive")
        for position in positions:
            safe_style(position, f"Effect emitter {index} background position")
        require(all(frame < len(positions) for frame in sparkle_frames), code,
                f"Effect emitter {index} lacks a referenced sparkle frame")
        pool_targets = unique_targets(emitter_targets[index], limits["effect_particles"],
                                      "INVALID_EFFECTS_BINDING",
                                      f"effect emitter {index} particle")
        require(len(pool_targets) == pool_size, "TARGET_CARDINALITY_MISMATCH",
                f"Effect emitter {index} targets do not match poolSize")

    for index, star in enumerate(stars):
        star = strict_keys(star, {"positions", "transforms", "frameIndices",
                                  "backgroundPositions"}, code, f"effect star {index}")
        require(set(star) == {"positions", "transforms", "frameIndices",
                              "backgroundPositions"}, code,
                f"Effect star {index} is incomplete")
        finite_f32_array(star.get("positions"), frame_count * 3, code,
                         f"effect star {index} positions")
        transforms = star.get("transforms")
        require(isinstance(transforms, list) and len(transforms) == frame_count,
                "FRAME_CARDINALITY_MISMATCH",
                f"Effect star {index} transforms do not match frameCount")
        for transform in transforms:
            safe_style(transform, f"Effect star {index} transform")
        positions = star.get("backgroundPositions")
        require(isinstance(positions, list) and 0 < len(positions) <= limits["frames"], code,
                f"Effect star {index} background positions are missing or excessive")
        for position in positions:
            safe_style(position, f"Effect star {index} background position")
        frames = integer_array(star.get("frameIndices"), frame_count,
                               "FRAME_CARDINALITY_MISMATCH",
                               f"effect star {index} frame indices", 0, len(positions) - 1)
        require(len(frames) == frame_count, "FRAME_CARDINALITY_MISMATCH",
                f"Effect star {index} frame indices do not match frameCount")

    maximum_lifetime = max(math.trunc(tuple_value[0]) for tuple_value in tuples)
    continuous_velocity = [max(abs(f32(tuple_value[component + 1]
                                             + continuous_bias[component]))
                               for tuple_value in tuples)
                           for component in range(3)]
    continuous_start = [0.0, 0.0, 0.0]
    for star in stars:
        for index, value in enumerate(star["positions"]):
            component = index % 3
            continuous_start[component] = max(continuous_start[component], abs(value))
    for component in range(3):
        gravity = (abs(particle["gravityY"]) * maximum_lifetime
                   * (maximum_lifetime + 1) / 2 if component == 1 else 0)
        bound = (continuous_start[component]
                 + continuous_velocity[component] * maximum_lifetime + gravity)
        require(finite_f32(bound), code,
                f"Prepared continuous effect component {component} can overflow")
    return packet


def validate_presentation_contract(state_channel: dict, binding: dict,
                                   binding_inputs: dict[str, dict]) -> dict:
    exact_array(binding.get("inputs"), ["viewport.height", "viewport.width"],
                "INVALID_PRESENTATION_BINDING",
                "Presentation inputs are incomplete or noncanonical")
    viewport_height = binding_inputs.get("viewport.height", {})
    viewport_width = binding_inputs.get("viewport.width", {})
    require(viewport_height.get("type") == "float"
            and viewport_width.get("type") == "float"
            and "default" not in viewport_height and "default" not in viewport_width,
            "INVALID_PRESENTATION_BINDING",
            "Presentation inputs must be float without package defaults")
    targets = strict_keys(binding.get("targets"),
                          {"camera", "cursorLayer", "cursorStates", "host"},
                          "INVALID_PRESENTATION_BINDING", "presentation targets")
    require({"camera", "host"}.issubset(targets)
            and targets.get("host") == "$host", "INVALID_PRESENTATION_BINDING",
            "Presentation targets are incomplete or invalid")
    stable_id(targets.get("camera"), "presentation camera target")
    has_cursor_layer = "cursorLayer" in targets
    has_cursor_states = "cursorStates" in targets
    require(has_cursor_layer == has_cursor_states, "INVALID_PRESENTATION_BINDING",
            "Presentation cursor layer and states must appear together")
    if has_cursor_layer:
        stable_id(targets.get("cursorLayer"), "presentation cursor layer target")
        cursor_states = strict_keys(targets.get("cursorStates"), {"open", "closed"},
                                    "INVALID_PRESENTATION_BINDING",
                                    "presentation cursor states")
        require(set(cursor_states) == {"open", "closed"}, "INVALID_PRESENTATION_BINDING",
                "Presentation cursor states are incomplete")
        opened = stable_id(cursor_states.get("open"), "presentation open cursor target")
        closed = stable_id(cursor_states.get("closed"), "presentation closed cursor target")
        require(opened != closed, "INVALID_PRESENTATION_BINDING",
                "Presentation cursor states must be distinct")
    parameters = strict_keys(binding.get("parameters"),
                             {"fitHeight", "fitWidth", "sourceHeight", "sourceWidth"},
                             "INVALID_PRESENTATION_BINDING", "presentation parameters")
    require(set(parameters) == {"fitHeight", "fitWidth", "sourceHeight", "sourceWidth"}
            and all(is_safe_int(parameters[key], 1) for key in parameters),
            "INVALID_PRESENTATION_BINDING", "Presentation dimensions are invalid")

    data = strict_keys(state_channel.get("data"), {"packet"},
                       "INVALID_PRESENTATION_STATE", "presentation state data")
    packet = strict_keys(data.get("packet"), {"version", "camera", "background"},
                         "INVALID_PRESENTATION_STATE", "presentation packet")
    require(set(data) == {"packet"} and {"version", "camera"}.issubset(packet)
            and packet.get("version") == 0, "INVALID_PRESENTATION_STATE",
            "Presentation state is incomplete or unsupported")
    camera = strict_keys(packet.get("camera"), {"baseSceneTransform", "fitHeight",
                         "fitWidth", "perspective", "sourceHeight", "sourceWidth"},
                         "INVALID_PRESENTATION_STATE", "presentation camera")
    require(set(camera) == {"baseSceneTransform", "fitHeight", "fitWidth", "perspective",
                            "sourceHeight", "sourceWidth"}, "INVALID_PRESENTATION_STATE",
            "Presentation camera is incomplete")
    safe_style(camera.get("baseSceneTransform"), "Presentation base scene transform")
    require(not isinstance(camera.get("perspective"), bool)
            and isinstance(camera.get("perspective"), (int, float))
            and math.isfinite(camera["perspective"]) and camera["perspective"] > 0
            and all(camera[key] == parameters[key]
                    for key in ("fitHeight", "fitWidth", "sourceHeight", "sourceWidth")),
            "INVALID_PRESENTATION_STATE",
            "Presentation camera values do not match parameters")
    background = packet.get("background")
    if "background" in packet:
        require(background is not None, "INVALID_PRESENTATION_STATE",
                "Presentation background must be an object when present")
        background = strict_keys(background,
                                 {"resource", "opacity", "position", "repeat", "size"},
                                 "INVALID_PRESENTATION_STATE", "presentation background")
        require(set(background) == {"resource", "opacity", "position", "repeat", "size"},
                "INVALID_PRESENTATION_STATE", "Presentation background is incomplete")
        resource_id(background.get("resource"), "presentation background resource")
        require(not isinstance(background.get("opacity"), bool)
                and isinstance(background.get("opacity"), (int, float))
                and math.isfinite(background["opacity"]) and 0 <= background["opacity"] <= 1,
                "INVALID_PRESENTATION_STATE", "Presentation background opacity is invalid")
        for key in ("position", "repeat", "size"):
            safe_style(background.get(key), f"Presentation background {key}")
    expected_sinks = []
    if background is not None:
        expected_sinks.extend([
            "host.style.backgroundColor", "host.style.backgroundImage",
            "host.style.backgroundPosition", "host.style.backgroundRepeat",
            "host.style.backgroundSize",
        ])
    expected_sinks.extend(["style.height", "style.left", "style.top", "style.transform"])
    if has_cursor_layer:
        expected_sinks.append("style.visibility")
    expected_sinks.append("style.width")
    exact_array(binding.get("sinks"), expected_sinks, "INVALID_PRESENTATION_BINDING",
                "Presentation sinks are incomplete or noncanonical")
    return packet


def validate_interaction_contract(state_channel: dict, binding: dict,
                                  binding_inputs: dict[str, dict],
                                  playback_binding: dict | None,
                                  presentation_binding: dict | None,
                                  limits: dict[str, int]) -> dict:
    state_code = "INVALID_INTERACTION_STATE"
    binding_code = "INVALID_INTERACTION_BINDING"
    expected_inputs = ["axis.x", "axis.y", "button.hold", "pointer.positioned",
                       "pointer.pressed", "pointer.x", "pointer.y"]
    exact_array(binding.get("inputs"), expected_inputs, binding_code,
                "Interaction inputs are incomplete or noncanonical")
    for input_id, input_type, default in (
        ("axis.x", "float", 0), ("axis.y", "float", 0),
        ("button.hold", "boolean", False),
        ("pointer.positioned", "boolean", False),
        ("pointer.pressed", "boolean", False),
    ):
        definition = binding_inputs.get(input_id, {})
        require(definition.get("type") == input_type and definition.get("default") == default,
                binding_code, f"Interaction input {input_id} has the wrong type or default")
    exact_array(binding.get("sinks"), ["style.transform", "style.visibility"],
                binding_code, "Interaction sinks are incomplete or noncanonical")
    targets = strict_keys(binding.get("targets"),
                          {"shapes", "leaves", "cursorLayer", "cursorStates"},
                          binding_code, "interaction targets")
    require(set(targets) == {"shapes", "leaves", "cursorLayer", "cursorStates"},
            binding_code, "Interaction targets are incomplete")
    shape_targets = unique_targets(targets.get("shapes"), limits["nodes"],
                                   binding_code, "interaction shape")
    leaf_targets = unique_targets(targets.get("leaves"), limits["nodes"],
                                  binding_code, "interaction leaf")
    if playback_binding is not None:
        require(shape_targets == playback_binding["targets"]["shapes"]
                and leaf_targets == playback_binding["targets"]["leaves"],
                "INTERACTION_TARGET_MISMATCH",
                "Interaction shape and leaf targets must exactly match playback")
    stable_id(targets.get("cursorLayer"), "interaction cursor layer")
    cursor_states = strict_keys(targets.get("cursorStates"), {"open", "closed"},
                                binding_code, "interaction cursor states")
    require(set(cursor_states) == {"open", "closed"}, binding_code,
            "Interaction cursor states are incomplete")
    opened = stable_id(cursor_states.get("open"), "interaction open cursor target")
    closed = stable_id(cursor_states.get("closed"), "interaction closed cursor target")
    require(opened != closed, binding_code, "Interaction cursor states must be distinct")
    parameters = strict_keys(binding.get("parameters"), {"initialFrame", "tickRateHz"},
                             binding_code, "interaction parameters")
    require(set(parameters) == {"initialFrame", "tickRateHz"}
            and parameters.get("tickRateHz") == 30, binding_code,
            "Interaction parameters are incomplete or unsupported")

    data = strict_keys(state_channel.get("data"), {"packet"}, state_code,
                       "interaction state data")
    packet = strict_keys(data.get("packet"), {"version", "arithmetic", "input",
                         "animator", "source", "triangle", "objects", "shapes",
                         "leaves", "controls"}, state_code, "interaction packet")
    require(set(data) == {"packet"}
            and set(packet) == {"version", "arithmetic", "input", "animator", "source",
                                "triangle", "objects", "shapes", "leaves", "controls"}
            and packet.get("version") == 0
            and packet.get("arithmetic") == "ieee754-f32-per-operation", state_code,
            "Interaction packet is incomplete or unsupported")

    input_contract = strict_keys(packet.get("input"), {
        "sourceWidth", "sourceHeight", "cursorBounds", "cursorInitial",
        "pointerQuantization", "stickRange", "stickDeadzone", "stickScale",
        "grabButton", "holdButton", "hitRadius", "cursorVisibleTicks", "mirrorX",
    }, state_code, "interaction input contract")
    require(set(input_contract) == {
        "sourceWidth", "sourceHeight", "cursorBounds", "cursorInitial",
        "pointerQuantization", "stickRange", "stickDeadzone", "stickScale",
        "grabButton", "holdButton", "hitRadius", "cursorVisibleTicks", "mirrorX",
    }, state_code, "Interaction input contract is incomplete")
    require(is_safe_int(input_contract.get("sourceWidth"), 1)
            and is_safe_int(input_contract.get("sourceHeight"), 1), state_code,
            "Interaction source viewport is invalid")
    if presentation_binding is not None:
        require(input_contract["sourceWidth"] == presentation_binding["parameters"]["sourceWidth"]
                and input_contract["sourceHeight"] == presentation_binding["parameters"]["sourceHeight"],
                "INTERACTION_VIEWPORT_MISMATCH",
                "Interaction source viewport must match static presentation")
    pointer_defaults = {
        "pointer.x": input_contract["sourceWidth"] / 2,
        "pointer.y": input_contract["sourceHeight"] / 2,
    }
    for input_id, default in pointer_defaults.items():
        definition = binding_inputs.get(input_id, {})
        require(definition.get("type") == "float" and definition.get("default") == default,
                binding_code,
                f"Interaction input {input_id} must use source-centre default {default}")
    bounds = finite_f32_array(input_contract.get("cursorBounds"), 4, state_code,
                              "interaction cursor bounds")
    require(bounds[0] <= bounds[1] and bounds[2] <= bounds[3], state_code,
            "Interaction cursor bounds are unordered")
    initial_cursor = finite_f32_array(input_contract.get("cursorInitial"), 2, state_code,
                                      "interaction initial cursor")
    require(initial_cursor == [pointer_defaults["pointer.x"], pointer_defaults["pointer.y"]],
            "INTERACTION_VIEWPORT_MISMATCH",
            "Interaction initial cursor must equal source-centre pointer defaults")
    require(bounds[0] <= initial_cursor[0] <= bounds[1]
            and bounds[2] <= initial_cursor[1] <= bounds[3], state_code,
            "Interaction initial cursor is outside its bounds")
    require(input_contract.get("pointerQuantization") == "trunc-toward-zero-then-clamp",
            state_code, "Interaction pointer quantization is unsupported")
    stick_range = finite_f32_array(input_contract.get("stickRange"), 2, state_code,
                                   "interaction stick range")
    require(stick_range[0] < 0 < stick_range[1], state_code,
            "Interaction stick range is invalid")
    require(finite_f32(input_contract.get("stickDeadzone"))
            and input_contract["stickDeadzone"] >= 0
            and finite_f32(input_contract.get("stickScale"))
            and input_contract["stickScale"] > 0, state_code,
            "Interaction stick scaling is invalid")
    grab_button, hold_button = input_contract.get("grabButton"), input_contract.get("holdButton")
    require(is_safe_int(grab_button, 1, 0xffff) and is_safe_int(hold_button, 1, 0xffff)
            and (int(grab_button) & int(hold_button)) == 0, state_code,
            "Interaction button masks are invalid")
    require(finite_f32(input_contract.get("hitRadius")) and input_contract["hitRadius"] > 0
            and is_safe_int(input_contract.get("cursorVisibleTicks"), 1)
            and finite_f32(input_contract.get("mirrorX")), state_code,
            "Interaction picking or cursor timing is invalid")

    animator_keys = {"initialState", "initialFrame", "introState", "dozeState",
                     "sleepState", "wakeState", "convergeState", "exitEyeState",
                     "eyeState", "dozeLoopCount", "dozeLoopStartFrame",
                     "dozeLoopEndFrame", "sleepEndFrame", "wakeStartFrame", "eyeFrame",
                     "convergeStillTicks", "eyeStillTicks"}
    animator = strict_keys(packet.get("animator"), animator_keys, state_code,
                           "interaction animator")
    require(set(animator) == animator_keys
            and all(is_safe_int(animator[key], 0) for key in animator_keys), state_code,
            "Interaction animator contains invalid integers")
    state_ids = [animator[key] for key in ("introState", "dozeState", "sleepState",
                                           "wakeState", "convergeState", "exitEyeState",
                                           "eyeState")]
    require(len(set(state_ids)) == len(state_ids) and animator["initialState"] in state_ids,
            state_code, "Interaction animator states are invalid")
    playback_frame_count = (playback_binding["parameters"]["frameCount"]
                            if playback_binding is not None else limits["frames"])
    require(animator["initialState"] == animator["eyeState"]
            and animator["initialFrame"] == animator["eyeFrame"]
            and 0 < animator["initialFrame"] <= playback_frame_count, state_code,
            "Interaction initial animator state is inconsistent")
    require(animator["dozeLoopCount"] > 0
            and 0 < animator["dozeLoopStartFrame"] < animator["dozeLoopEndFrame"] <= playback_frame_count
            and 0 < animator["sleepEndFrame"] <= playback_frame_count
            and 0 < animator["wakeStartFrame"] <= playback_frame_count
            and animator["convergeStillTicks"] > 0 and animator["eyeStillTicks"] > 0,
            state_code, "Interaction animator timing is invalid")
    require(parameters.get("initialFrame") == animator["initialFrame"], binding_code,
            "Interaction binding initialFrame differs from animator")

    source = strict_keys(packet.get("source"), {"cameraViewMatrix", "cameraWorldPosition",
                         "inverseCameraMatrix", "projection", "displacementMagnitude",
                         "eyeGain", "eyeMaximumOffset", "spring"}, state_code,
                         "interaction source")
    require(set(source) == {"cameraViewMatrix", "cameraWorldPosition", "inverseCameraMatrix",
                            "projection", "displacementMagnitude", "eyeGain",
                            "eyeMaximumOffset", "spring"}, state_code,
            "Interaction source contract is incomplete")
    camera_view = finite_f32_array(source.get("cameraViewMatrix"), 16, state_code,
                                   "interaction camera view matrix")
    camera_inverse = finite_f32_array(source.get("inverseCameraMatrix"), 16, state_code,
                                      "interaction inverse camera matrix")
    require(inverse_matrix_pair(camera_view, camera_inverse), state_code,
            "Interaction camera matrices are not a finite inverse pair")
    finite_f32_array(source.get("cameraWorldPosition"), 3, state_code,
                     "interaction camera world position")
    projection = strict_keys(source.get("projection"), {"scale", "origin"}, state_code,
                             "interaction projection")
    require(set(projection) == {"scale", "origin"}
            and finite_f32(projection.get("scale")) and projection["scale"] > 0,
            state_code, "Interaction projection is invalid")
    finite_f32_array(projection.get("origin"), 2, state_code,
                     "interaction projection origin")
    require(finite_f32(source.get("displacementMagnitude"))
            and source["displacementMagnitude"] > 0
            and finite_f32(source.get("eyeGain")) and source["eyeGain"] > 0
            and finite_f32(source.get("eyeMaximumOffset"))
            and source["eyeMaximumOffset"] >= 0, state_code,
            "Interaction displacement or eye values are invalid")
    spring_keys = {"cursorResistance", "grabbedFlag", "pickedResistance",
                   "releaseAcceleration", "snapOffsetL1", "snapVelocityL1", "velocityDecay"}
    spring = strict_keys(source.get("spring"), spring_keys, state_code,
                         "interaction spring")
    require(set(spring) == spring_keys
            and all(finite_f32(spring[key]) for key in spring_keys - {"grabbedFlag"})
            and 0 <= spring["cursorResistance"] <= 1
            and -1 <= spring["pickedResistance"] < 0
            and 0 < spring["releaseAcceleration"] <= 1
            and 0 < spring["velocityDecay"] < 1
            and spring["snapOffsetL1"] >= 0 and spring["snapVelocityL1"] >= 0
            and is_safe_int(spring.get("grabbedFlag"), 1), state_code,
            "Interaction spring constraints are invalid")
    grab_displacement_bounds = interaction_grab_displacement_bounds(input_contract, source)
    require(grab_displacement_bounds is not None, state_code,
            "Declared cursor displacement overflows interaction binary32 arithmetic")
    selected_grab_bounds = [interaction_f32(bound / -spring["pickedResistance"])
                            for bound in grab_displacement_bounds]
    require(all(math.isfinite(bound) for bound in selected_grab_bounds), state_code,
            "Declared selected-grab envelope overflows interaction binary32 arithmetic")

    triangle = strict_keys(packet.get("triangle"),
                           {"basisEpsilon", "primitive", "fallbackAmount", "sharedEdgeAmount"},
                           state_code, "interaction triangle kernel")
    require(set(triangle) == {"basisEpsilon", "primitive", "fallbackAmount",
                              "sharedEdgeAmount"}
            and triangle.get("basisEpsilon") == 1e-9
            and triangle.get("primitive") == "corner-bevel"
            and finite_f32(triangle.get("fallbackAmount"))
            and triangle["fallbackAmount"] >= 0
            and finite_f32(triangle.get("sharedEdgeAmount"))
            and triangle["sharedEdgeAmount"] >= 0, state_code,
            "Interaction triangle kernel is unsupported")

    objects = strict_keys(packet.get("objects"), {"rotationMatrices"}, state_code,
                          "interaction objects")
    rotations = objects.get("rotationMatrices")
    require(set(objects) == {"rotationMatrices"} and isinstance(rotations, list)
            and len(rotations) % 16 == 0
            and len(rotations) // 16 <= limits["interaction_objects"]
            and all(finite_f32(value) for value in rotations),
            "INTERACTION_STATE_LIMIT", "Interaction object matrices are invalid or excessive")
    object_count = len(rotations) // 16
    shapes = strict_keys(packet.get("shapes"), {"baseMatrices"}, state_code,
                         "interaction shapes")
    base_matrices = shapes.get("baseMatrices")
    require(set(shapes) == {"baseMatrices"} and isinstance(base_matrices, list)
            and len(base_matrices) == len(shape_targets) * 16
            and all(finite_f32(value) for value in base_matrices),
            "TARGET_CARDINALITY_MISMATCH",
            "Interaction shape matrices do not match targets")
    leaf_plans = packet.get("leaves")
    require(isinstance(leaf_plans, list) and len(leaf_plans) == len(leaf_targets)
            and len(leaf_plans) <= limits["nodes"], "TARGET_CARDINALITY_MISMATCH",
            "Interaction leaf plans do not match targets")
    for index, leaf in enumerate(leaf_plans):
        leaf = strict_keys(leaf, {"basis", "canonicalSize", "matrixDecimals",
                           "seamEdgeMask", "width", "height"}, state_code,
                           f"interaction leaf {index}")
        require(set(leaf) == {"basis", "canonicalSize", "matrixDecimals", "seamEdgeMask",
                              "width", "height"}
                and leaf.get("basis") in ([0, 1, 2], [1, 2, 0], [2, 0, 1])
                and is_safe_int(leaf.get("canonicalSize"), 1)
                and is_safe_int(leaf.get("matrixDecimals"), 0, 6)
                and is_safe_int(leaf.get("seamEdgeMask"), 0, 7)
                and is_safe_int(leaf.get("width"), 1)
                and is_safe_int(leaf.get("height"), 1), state_code,
                f"Interaction leaf {index} is invalid")

    controls = packet.get("controls")
    require(isinstance(controls, list) and 0 < len(controls) <= limits["interaction_controls"],
            "INTERACTION_STATE_LIMIT", "Interaction controls are missing or excessive")
    control_ids, control_roles = set(), set()
    total_vertices = total_weights = total_weight_references = total_leaf_rows = grab_controls = 0
    for control_index, control in enumerate(controls):
        control = strict_keys(control, {"id", "role", "mode", "sourceOrder",
                              "sourcePosition", "screenPosition", "cameraDistance",
                              "attachmentObjectIndices", "closure"}, state_code,
                              f"interaction control {control_index}")
        require(set(control) == {"id", "role", "mode", "sourceOrder", "sourcePosition",
                                 "screenPosition", "cameraDistance",
                                 "attachmentObjectIndices", "closure"}, state_code,
                f"Interaction control {control_index} is incomplete")
        control_id = stable_id(control.get("id"), f"interaction control {control_index} id")
        role = stable_id(control.get("role"), f"interaction control {control_index} role")
        require(control_id not in control_ids and role not in control_roles, state_code,
                "Interaction control ids and roles must be unique")
        control_ids.add(control_id); control_roles.add(role)
        mode = control.get("mode")
        require(control.get("sourceOrder") == control_index
                and mode in ("grab", "eye-follow"), state_code,
                f"Interaction control {control_index} mode or order is invalid")
        if mode == "grab":
            grab_controls += 1
        source_position = finite_f32_array(control.get("sourcePosition"), 3, state_code,
                                           f"interaction control {control_index} source position")
        finite_f32_array(control.get("screenPosition"), 2, state_code,
                         f"interaction control {control_index} screen position")
        require(finite_f32(control.get("cameraDistance")) and control["cameraDistance"] > 0,
                state_code, f"Interaction control {control_index} camera distance is invalid")
        attachments = integer_array(control.get("attachmentObjectIndices"),
                                    limits["interaction_objects"], state_code,
                                    f"interaction control {control_index} attachments", 0,
                                    max(0, object_count - 1), True)
        require(bool(attachments) and (mode != "eye-follow" or len(attachments) == 1),
                state_code, f"Interaction control {control_index} attachments are invalid")

        closure_keys = {"shapeIndices", "vertexRows", "vertexPositions",
                        "weightActiveFlags", "weightScalars", "weightLinearContributions",
                        "weightBaseTranslations", "leafIndices", "leafRows",
                        "safeVisibleLeafIndices", "rigidRootInverseMatrix"}
        closure = strict_keys(control.get("closure"), closure_keys, state_code,
                              f"interaction control {control_index} closure")
        require(set(closure) == closure_keys, state_code,
                f"Interaction control {control_index} closure is incomplete")
        shape_indices = integer_array(closure.get("shapeIndices"), len(shape_targets),
                                      state_code,
                                      f"interaction control {control_index} shape indices", 0,
                                      max(0, len(shape_targets) - 1), True)
        require(bool(shape_indices), state_code,
                f"Interaction control {control_index} has no shape closure")
        vertex_rows = closure.get("vertexRows")
        require(isinstance(vertex_rows, list) and len(vertex_rows) % 4 == 0,
                state_code, f"Interaction control {control_index} vertex rows are truncated")
        vertex_count = len(vertex_rows) // 4
        total_vertices += vertex_count
        vertex_positions = closure.get("vertexPositions")
        require(total_vertices <= limits["interaction_vertices"]
                and isinstance(vertex_positions, list)
                and len(vertex_positions) == vertex_count * 3
                and all(finite_f32(value) for value in vertex_positions),
                "INTERACTION_STATE_LIMIT",
                f"Interaction control {control_index} vertices are invalid or excessive")
        shape_set, maximum_weight = set(shape_indices), 0
        for row in range(vertex_count):
            offset = row * 4
            values = vertex_rows[offset:offset + 4]
            require(len(values) == 4 and values[0] in shape_set
                    and all(is_safe_int(value, 0) for value in values[1:]), state_code,
                    f"Interaction control {control_index} vertex row {row} is invalid")
            row_end = int(values[2]) + int(values[3])
            require(is_safe_int(row_end, 0), state_code,
                    f"Interaction control {control_index} weight range overflows")
            maximum_weight = max(maximum_weight, row_end)
            total_weight_references += int(values[3])
            require(total_weight_references <= limits["interaction_weight_references"],
                    "INTERACTION_STATE_LIMIT", "Interaction weight references are excessive")
        weight_scalars = closure.get("weightScalars")
        weight_flags = closure.get("weightActiveFlags")
        weight_linear = closure.get("weightLinearContributions")
        weight_base = closure.get("weightBaseTranslations")
        require(all(isinstance(value, list) for value in
                    (weight_scalars, weight_flags, weight_linear, weight_base)),
                "INTERACTION_STATE_LIMIT", "Interaction weight tables must be arrays")
        weight_count = len(weight_scalars)
        total_weights += weight_count
        require(total_weights <= limits["interaction_weights"]
                and maximum_weight <= weight_count
                and len(weight_flags) == weight_count
                and len(weight_linear) == weight_count * 3
                and len(weight_base) == weight_count * 3
                and all(finite_f32(value) for value in weight_scalars)
                and all(finite_f32(value) for value in weight_linear)
                and all(finite_f32(value) for value in weight_base)
                and all(value in (0, 1) and not isinstance(value, bool)
                        for value in weight_flags), "INTERACTION_STATE_LIMIT",
                f"Interaction control {control_index} weight tables are invalid or excessive")
        leaf_indices = integer_array(closure.get("leafIndices"), len(leaf_plans), state_code,
                                     f"interaction control {control_index} leaf indices", 0,
                                     max(0, len(leaf_plans) - 1), True)
        leaf_rows = closure.get("leafRows")
        require(isinstance(leaf_rows, list) and len(leaf_rows) == len(leaf_indices) * 4,
                state_code, f"Interaction control {control_index} leaf rows are mismatched")
        total_leaf_rows += len(leaf_indices)
        require(total_leaf_rows <= limits["interaction_leaf_rows"],
                "INTERACTION_STATE_LIMIT", "Interaction leaf rows are excessive")
        for row, leaf_index in enumerate(leaf_indices):
            values = leaf_rows[row * 4:row * 4 + 4]
            require(len(values) == 4 and all(is_safe_int(value, 0) for value in values)
                    and values[0] == leaf_index
                    and all(value < vertex_count for value in values[1:]), state_code,
                    f"Interaction control {control_index} leaf row {row} is invalid")
        safe_visible = integer_array(closure.get("safeVisibleLeafIndices"),
                                     len(leaf_indices), state_code,
                                     f"interaction control {control_index} safe-visible leaves",
                                     0, max(0, len(leaf_plans) - 1), True)
        require(all(index in set(leaf_indices) for index in safe_visible), state_code,
                f"Interaction control {control_index} safe-visible leaves escape closure")
        rigid_inverse = closure.get("rigidRootInverseMatrix")
        if mode == "eye-follow":
            finite_f32_array(rigid_inverse, 16, state_code,
                             f"interaction control {control_index} rigid inverse matrix")
            projected = interaction_projected_f32(source_position, source)
            require(projected is not None, state_code,
                    f"Interaction eye control {control_index} projection overflows")
            for cursor_x in (bounds[0], bounds[1]):
                for cursor_y in (bounds[2], bounds[3]):
                    eye_offset = [
                        interaction_mul_f32(
                            interaction_add_f32(cursor_x, -projected[0]), source["eyeGain"]),
                        interaction_mul_f32(
                            interaction_add_f32(projected[1], -cursor_y), source["eyeGain"]),
                        0.0,
                    ]
                    require(all(math.isfinite(component) for component in eye_offset)
                            and interaction_magnitude_f32(eye_offset), state_code,
                            f"Interaction eye control {control_index} offset overflows")
            camera = 0.0
            for component in (
                f32(f32(camera_view[2] * source_position[0])
                    + f32(camera_view[6] * source_position[1])),
                camera_view[10] * source_position[2], camera_view[14],
            ):
                camera = f32(camera + f32(component))
            require(math.isfinite(camera) and abs(camera) > 1e-6, state_code,
                    f"Interaction eye control {control_index} projects on camera plane")
        else:
            require(isinstance(rigid_inverse, list) and len(rigid_inverse) == 0, state_code,
                    f"Grab control {control_index} has a rigid inverse matrix")
            for component in range(3):
                require(math.isfinite(interaction_add_f32(
                            source_position[component], selected_grab_bounds[component]))
                        and math.isfinite(interaction_add_f32(
                            source_position[component], -selected_grab_bounds[component])),
                        state_code,
                        f"Interaction grab control {control_index} displacement envelope overflows")
    require(grab_controls > 0, state_code,
            "Prepared interaction needs at least one grab control")
    return packet


def validate_state_bindings(state: Any, bindings: Any, node_ids: set[str], limits: dict[str, int]) -> tuple[list[dict], list[dict]]:
    state = strict_keys(state, {"version", "channels"}, "INVALID_STATE", "STAT")
    require(as_int(state.get("version"), "UNSUPPORTED_STATE_SCHEMA", "STAT version") == 0,
            "UNSUPPORTED_STATE_SCHEMA", "STAT version must be zero")
    channels = state.get("channels")
    require(isinstance(channels, list) and len(channels) <= 128, "STATE_CHANNEL_LIMIT", "State channels invalid")
    state_map, previous = {}, ""
    for channel in channels:
        channel = strict_keys(channel, {"id", "codec", "data"}, "INVALID_STATE", "state channel")
        cid = stable_id(channel.get("id"), "state channel id")
        require(cid > previous and cid not in state_map, "STATE_CHANNEL_ORDER", "State channels not sorted")
        previous = cid
        require(channel.get("codec") in STATE_INTERPRETERS and "data" in channel,
                "UNSUPPORTED_STATE_CODEC", f"State codec for {cid} is unsupported")
        state_map[cid] = channel
    bindings = strict_keys(bindings, {"version", "inputs", "channels"}, "INVALID_BINDINGS", "BIND")
    require(as_int(bindings.get("version"), "UNSUPPORTED_BINDING_SCHEMA", "BIND version") == 0,
            "UNSUPPORTED_BINDING_SCHEMA", "BIND version must be zero")
    inputs, input_ids, input_map, previous = bindings.get("inputs"), set(), {}, ""
    require(isinstance(inputs, list) and len(inputs) <= limits["binding_inputs"],
            "BINDING_INPUT_LIMIT", "Binding inputs invalid or excessive")
    for item in inputs:
        item = strict_keys(item, {"id", "type", "default"}, "INVALID_BINDINGS", "binding input")
        iid = stable_id(item.get("id"), "binding input id")
        require(iid > previous and iid not in input_ids and item.get("type") in ("boolean", "float", "uint"),
                "INPUT_ORDER", "Binding inputs invalid or unsorted")
        if "default" in item:
            default = item["default"]
            valid_default = ((item["type"] == "boolean" and isinstance(default, bool))
                             or (item["type"] == "float" and not isinstance(default, bool)
                                 and isinstance(default, (int, float)) and math.isfinite(default))
                             or (item["type"] == "uint" and not isinstance(default, bool)
                                 and isinstance(default, (int, float)) and math.isfinite(default)
                                 and float(default).is_integer()
                                 and 0 <= default <= 9_007_199_254_740_991))
            require(valid_default, "INVALID_INPUT_DEFAULT", f"Binding input {iid} default is invalid")
        input_map[iid] = item
        previous, _ = iid, input_ids.add(iid)
    binding_channels = bindings.get("channels")
    require(isinstance(binding_channels, list) and len(binding_channels) <= 128,
            "BINDING_CHANNEL_LIMIT", "Binding channels invalid")
    bound, interpreters, used_inputs, previous = set(), set(), set(), ""
    for channel in binding_channels:
        channel = strict_keys(channel, {"id", "state", "interpreter", "status", "inputs", "targets", "sinks", "parameters"},
                              "INVALID_BINDINGS", "binding channel")
        cid = stable_id(channel.get("id"), "binding channel id")
        require(cid > previous, "BINDING_CHANNEL_ORDER", "Binding channels not sorted")
        previous = cid
        sid, interpreter = channel.get("state"), channel.get("interpreter")
        require(sid in state_map and STATE_INTERPRETERS[state_map[sid]["codec"]] == interpreter,
                "STATE_INTERPRETER_MISMATCH", f"Binding {cid} state/interpreter mismatch")
        require(sid not in bound and interpreter not in interpreters,
                "DUPLICATE_STATE_BINDING", f"Binding {cid} duplicates state/interpreter")
        bound.add(sid); interpreters.add(interpreter)
        require(channel.get("status") == "executable", "INVALID_BINDING_STATUS", "Binding status must be executable")
        channel_inputs = channel.get("inputs")
        require(isinstance(channel_inputs, list)
                and len(channel_inputs) <= limits["binding_inputs"]
                and all(isinstance(value, str) and value in input_ids for value in channel_inputs)
                and len(set(channel_inputs)) == len(channel_inputs),
                "MISSING_INPUT", f"Binding {cid} inputs invalid")
        used_inputs.update(channel_inputs)
        target_list: list[str] = []
        require(isinstance(channel.get("targets"), dict), "INVALID_TARGETS", f"Binding {cid} targets invalid")
        collect_targets(channel["targets"], target_list, len(node_ids) + 1,
                        f"Binding {cid} targets", limits["depth"])
        require((target_list or interpreter == "polycss-surface@0")
                and len(set(target_list)) == len(target_list)
                and all(target == "$host" or target in node_ids for target in target_list),
                "MISSING_TARGET_NODE", f"Binding {cid} targets invalid")
        sinks = channel.get("sinks")
        require(isinstance(sinks, list) and sinks and len(sinks) <= len(ALLOWED_SINKS)
                and all(isinstance(sink, str) and sink in ALLOWED_SINKS for sink in sinks)
                and len(set(sinks)) == len(sinks),
                "UNSUPPORTED_SINK", f"Binding {cid} sinks invalid")
    require(bound == set(state_map), "UNBOUND_STATE_CHANNEL", "A state channel is unbound")
    require(used_inputs == input_ids, "UNUSED_INPUT", "A binding input is declared but unused")
    # Independent codec-envelope/cardinality checks.
    by_codec = {channel["codec"]: channel for channel in channels}
    by_interpreter = {channel["interpreter"]: channel for channel in binding_channels}
    binding_contracts = {
        "polycss-effects@0": (
            ["interaction.grab-active", "interaction.grab-x", "interaction.grab-y", "interaction.grab-z", "time.source-frame"],
            ["style.backgroundPosition", "style.opacity", "style.transform", "style.visibility"],
            {"stars", "emitters"}, {"frameCount"}),
        "polycss-playback@0": (
            ["time.tick"], ["style.transform", "style.visibility"],
            {"model", "shapes", "leaves"}, {"baseSceneTransform", "frameCount", "tickRateHz"}),
        "polycss-pointer-grab@0": (
            ["axis.x", "axis.y", "button.hold", "pointer.positioned", "pointer.pressed", "pointer.x", "pointer.y"],
            ["style.transform", "style.visibility"],
            {"shapes", "leaves", "cursorLayer", "cursorStates"}, {"initialFrame", "tickRateHz"}),
        "polycss-surface@0": (
            ["time.source-frame"], ["style.backgroundPositionY", "style.visibility"],
            {"leaves"}, None),
    }
    for interpreter, (expected_inputs, expected_sinks, target_keys, parameter_keys) in binding_contracts.items():
        binding = by_interpreter.get(interpreter)
        if binding is None:
            continue
        require(binding["status"] == "executable" and binding["inputs"] == expected_inputs
                and binding["sinks"] == expected_sinks,
                "INVALID_CODEC_BINDING", f"{interpreter} input, sink, or status contract is invalid")
        targets = strict_keys(binding["targets"], target_keys, "INVALID_CODEC_BINDING", f"{interpreter} targets")
        require(set(targets) == target_keys, "INVALID_CODEC_BINDING", f"{interpreter} targets are incomplete")
        if parameter_keys is None:
            require("parameters" not in binding, "INVALID_CODEC_BINDING", f"{interpreter} has no parameters")
        else:
            parameters = strict_keys(binding.get("parameters"), parameter_keys, "INVALID_CODEC_BINDING", f"{interpreter} parameters")
            require(set(parameters) == parameter_keys, "INVALID_CODEC_BINDING", f"{interpreter} parameters are incomplete")

    playback_state = by_codec.get("polycss-playback-packed@0")
    surface_state = by_codec.get("polycss-surface-packed@0")
    playback_binding = by_interpreter.get("polycss-playback@0")
    surface_binding = by_interpreter.get("polycss-surface@0")
    require((playback_state is None) == (playback_binding is None),
            "MISSING_POLYCSS_CHANNEL", "Playback state and binding must appear together")
    require((surface_state is None) == (surface_binding is None),
            "MISSING_POLYCSS_CHANNEL", "Surface state and binding must appear together")
    playback_packet = None
    if playback_binding is not None:
        playback_packet = validate_playback_contract(
            playback_state, playback_binding, input_map, limits)
    if surface_binding is not None:
        require(playback_packet is not None, "MISSING_POLYCSS_CHANNEL",
                "Prepared surface requires executable playback")
        validate_surface_contract(surface_state, surface_binding, playback_packet,
                                  playback_binding, input_map, limits)
    if playback_packet is not None and playback_packet["leafCount"] > 0:
        require(surface_binding is not None, "MISSING_POLYCSS_CHANNEL",
                "Playback with leaf targets requires prepared surface state and binding")

    effects_state = by_codec.get("polycss-effects-prepared@0")
    effects_binding = by_interpreter.get("polycss-effects@0")
    if effects_state or effects_binding:
        require(effects_state is not None and effects_binding is not None,
                "MISSING_POLYCSS_CHANNEL",
                "Effects state and binding must appear together")
        require(playback_binding is not None, "MISSING_POLYCSS_CHANNEL",
                "Prepared effects require executable playback")
        validate_effects_contract(effects_state, effects_binding, input_map,
                                  playback_binding, limits)

    presentation_state = by_codec.get("static-presentation@0")
    presentation_binding = by_interpreter.get("static-presentation@0")
    if presentation_state or presentation_binding:
        require(presentation_state is not None and presentation_binding is not None,
                "MISSING_POLYCSS_CHANNEL",
                "Presentation state and binding must appear together")
        validate_presentation_contract(presentation_state, presentation_binding, input_map)

    interaction_state = by_codec.get("polycss-pointer-grab-prepared@0")
    interaction_binding = by_interpreter.get("polycss-pointer-grab@0")
    if interaction_state or interaction_binding:
        require(interaction_state is not None and interaction_binding is not None,
                "MISSING_POLYCSS_CHANNEL",
                "Interaction state and binding must appear together")
        require(playback_binding is not None and presentation_binding is not None
                and effects_binding is not None, "MISSING_POLYCSS_CHANNEL",
                "Prepared pointer interaction requires playback, presentation, and effects")
        validate_interaction_contract(interaction_state, interaction_binding, input_map,
                                      playback_binding, presentation_binding, limits)
        require(interaction_binding["parameters"]["tickRateHz"]
                == playback_binding["parameters"]["tickRateHz"],
                "INVALID_INTERACTION_BINDING",
                "Interaction and playback tick rates must match")

    def target_set(binding: dict) -> set[str]:
        values: list[str] = []
        collect_targets(binding["targets"], values, limits["nodes"] + 1,
                        f"{binding['interpreter']} targets", limits["depth"])
        return set(values)

    if effects_binding is not None:
        effect_targets = target_set(effects_binding)
        for other in binding_channels:
            if other is effects_binding:
                continue
            overlap = effect_targets.intersection(target_set(other))
            require(not overlap, "TARGET_OWNERSHIP_CONFLICT",
                    f"Effect targets overlap {other['interpreter']}: {sorted(overlap)[0] if overlap else ''}")
    if playback_binding is not None and presentation_binding is not None:
        playback_targets = target_set(playback_binding)
        overlap = {target for target in target_set(presentation_binding)
                   if target != "$host" and target in playback_targets}
        require(not overlap, "TARGET_OWNERSHIP_CONFLICT",
                f"Presentation targets overlap playback: {sorted(overlap)[0] if overlap else ''}")
    return channels, binding_channels


def css_number(value: Any) -> str:
    if isinstance(value, int):
        return str(value)
    return ecma_number(float(value))


def validate_initial_surface_closure(document: dict[str, Any], nodes: list[dict]) -> None:
    state = next((channel for channel in document["state"]["channels"]
                  if channel["codec"] == "polycss-surface-packed@0"), None)
    binding = next((channel for channel in document["bindings"]["channels"]
                    if channel["interpreter"] == "polycss-playback@0"), None)
    if state is None or binding is None:
        return
    packet = state["data"]["packet"]
    try:
        packed = base64.b64decode(packet["visibility"]["initialVisibleBitsBase64"],
                                  validate=True)
    except (binascii.Error, ValueError) as error:
        raise DomError("INVALID_SURFACE_STATE",
                       "Surface initial visibility is not valid base64") from error
    by_id = {node["id"]: node for node in nodes}
    target_frame = packet["transitions"]["initialFrame"] - 1
    packing = packet["surface"]["statePacking"]
    for index, target in enumerate(binding["targets"]["leaves"]):
        node = by_id[target]
        expected_visibility = ("visible"
                               if ((packed[index >> 3] >> (index & 7)) & 1) else "hidden")
        require(node.get("styles", {}).get("visibility") == expected_visibility,
                "SURFACE_TREE_MISMATCH",
                f"Surface leaf {index} initial visibility does not match TREE")
        face = packet["surface"]["faces"][index]
        source_frame = selected_frame = 0
        for local in range(int(face["stateCount"])):
            source_frame += packing["sourceFrameDeltas"][int(face["stateOffset"]) + local]
            if source_frame > target_frame:
                break
            selected_frame = source_frame
        actual = node.get("styles", {}).get("backgroundPositionY")
        if selected_frame == 0:
            matches = actual is None or actual in ("0", "0px", "0%")
        else:
            matches = actual == f"{-selected_frame * face['leafHeight']}px"
        require(matches, "SURFACE_TREE_MISMATCH",
                f"Surface leaf {index} initial atlas position does not match TREE")


def validate_presentation_closure(document: dict[str, Any], nodes: list[dict],
                                  resources: dict[str, dict]) -> None:
    state = next((channel for channel in document["state"]["channels"]
                  if channel["codec"] == "static-presentation@0"), None)
    binding = next((channel for channel in document["bindings"]["channels"]
                    if channel["interpreter"] == "static-presentation@0"), None)
    if state is None or binding is None:
        return
    packet = state["data"]["packet"]
    mount = document["tree"]["mount"]
    mount_styles = mount.get("styles", {})
    background = packet.get("background")
    resource_style = mount.get("resourceStyles", {}).get("backgroundImage")
    if background is not None:
        resource = resources.get(background["resource"])
        require(resource is not None and resource["kind"] == "image",
                "RESOURCE_ROLE_MISMATCH",
                "Presentation background must reference an image")
        require(isinstance(resource_style, dict)
                and resource_style.get("resource") == background["resource"]
                and resource_style.get("syntax") == "overlay-url"
                and resource_style.get("overlayOpacity") == background["opacity"],
                "PRESENTATION_TREE_MISMATCH",
                "Presentation background resource does not match TREE mount")
        require(mount_styles.get("backgroundPosition") == background["position"]
                and mount_styles.get("backgroundRepeat") == background["repeat"]
                and mount_styles.get("backgroundSize") == background["size"],
                "PRESENTATION_TREE_MISMATCH",
                "Presentation background styles do not match TREE mount")
    else:
        require(resource_style is None
                and all(key not in mount_styles
                        for key in ("backgroundPosition", "backgroundRepeat", "backgroundSize")),
                "PRESENTATION_TREE_MISMATCH",
                "Presentation without a background cannot declare TREE mount background bindings")
    by_id = {node["id"]: node for node in nodes}
    camera_node = by_id.get(binding["targets"]["camera"])
    camera = packet["camera"]
    camera_styles = camera_node.get("styles", {}) if camera_node else {}
    require(camera_styles.get("perspective") == f"{css_number(camera['perspective'])}px"
            and camera_styles.get("perspectiveOrigin")
            == f"{css_number(camera['sourceWidth'] / 2)}px {css_number(camera['sourceHeight'] / 2)}px"
            and camera_styles.get("position") == "relative"
            and camera_styles.get("width") == f"{css_number(camera['sourceWidth'])}px"
            and camera_styles.get("height") == f"{css_number(camera['sourceHeight'])}px"
            and "transformOrigin" not in camera_styles
            and "transformStyle" not in camera_styles,
            "PRESENTATION_TREE_MISMATCH",
            "Presentation camera does not match TREE styles")
    playback = next((channel for channel in document["bindings"]["channels"]
                     if channel["interpreter"] == "polycss-playback@0"), None)
    if playback is not None:
        require(playback["parameters"]["baseSceneTransform"] == camera["baseSceneTransform"]
                and by_id.get(playback["targets"]["model"], {}).get("styles", {}).get("transform")
                == camera["baseSceneTransform"], "PRESENTATION_TREE_MISMATCH",
                "Presentation transform does not match playback and TREE")
    interaction = next((channel for channel in document["bindings"]["channels"]
                        if channel["interpreter"] == "polycss-pointer-grab@0"), None)
    if interaction is not None:
        require("cursorLayer" in binding["targets"] and "cursorStates" in binding["targets"]
                and interaction["targets"]["cursorLayer"] == binding["targets"]["cursorLayer"]
                and interaction["targets"]["cursorStates"] == binding["targets"]["cursorStates"],
                "PRESENTATION_TREE_MISMATCH",
                "Presentation and interaction cursor targets differ")


CSS_WHITESPACE = "\t\n\f\r "
SAFE_CSS_FUNCTIONS = frozenset("""
abs acos asin atan atan2 blur brightness calc circle clamp color color-mix
conic-gradient contrast cos counter counters cubic-bezier drop-shadow ellipse exp
fit-content grayscale hsl hsla hwb hypot hue-rotate inset invert is lab lch
light-dark linear-gradient log matrix matrix3d max min minmax mod not nth-child
nth-last-child nth-last-of-type nth-of-type oklab oklch opacity path perspective
polygon pow radial-gradient rem repeat repeating-conic-gradient
repeating-linear-gradient repeating-radial-gradient rgb rgba rotate rotate3d
rotatex rotatey rotatez round saturate scale scale3d scalex scaley scalez sepia
sign sin skew skewx skewy sqrt steps tan translate translate3d translatex
translatey translatez url where
""".split())
SAFE_CSS_PROPERTIES = frozenset("""
-webkit-backface-visibility backface-visibility background background-clip
background-color background-image background-position-x background-position-y
background-repeat background-size border border-bottom-left-radius
border-bottom-right-radius border-color border-shape border-top-left-radius
border-top-right-radius box-sizing color contain content corner-bottom-left-shape
corner-bottom-right-shape corner-top-left-shape corner-top-right-shape cursor display font font-style font-weight height
image-rendering inset isolation left line-height margin max-width object-fit
object-position opacity overflow padding pointer-events position text-decoration
top touch-action transform transform-origin transform-style user-select
visibility width will-change z-index
""".split())


def trim_css_range(css: str, start: int, end: int) -> tuple[int, int]:
    while start < end and css[start] in CSS_WHITESPACE:
        start += 1
    while end > start and css[end - 1] in CSS_WHITESPACE:
        end -= 1
    return start, end


def split_css_top_level(css: str, start: int, end: int, delimiter: str,
                        code: str, label: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    item_start, quote, round_depth, square_depth = start, "", 0, 0
    for index in range(start, end):
        ch = css[index]
        if quote:
            require(ch not in "\n\r\f", code, f"{label} contains a newline in a string")
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'":
            quote = ch
        elif ch == "(":
            round_depth += 1
        elif ch == ")":
            round_depth -= 1
        elif ch == "[":
            square_depth += 1
        elif ch == "]":
            square_depth -= 1
        elif ch == delimiter and round_depth == square_depth == 0:
            ranges.append(trim_css_range(css, item_start, index))
            item_start = index + 1
        require(round_depth >= 0 and square_depth >= 0, code,
                f"{label} delimiters are unbalanced")
    require(not quote and round_depth == square_depth == 0, code,
            f"{label} is unterminated")
    ranges.append(trim_css_range(css, item_start, end))
    return ranges


def css_top_level_colon(css: str, start: int, end: int) -> int:
    quote, round_depth, square_depth = "", 0, 0
    for index in range(start, end):
        ch = css[index]
        if quote:
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'": quote = ch
        elif ch == "(": round_depth += 1
        elif ch == ")": round_depth -= 1
        elif ch == "[": square_depth += 1
        elif ch == "]": square_depth -= 1
        elif ch == ":" and round_depth == square_depth == 0: return index
    return -1


def parse_css_rules(css: str, limits: dict[str, int]) -> list[tuple[int, int, int, int]]:
    rules: list[tuple[int, int, int, int]] = []
    index = 0
    while index < len(css):
        while index < len(css) and css[index] in CSS_WHITESPACE:
            index += 1
        if index == len(css):
            break
        prelude_start, quote, round_depth, square_depth, opening = index, "", 0, 0, -1
        while index < len(css):
            ch = css[index]
            if quote:
                require(ch not in "\n\r\f", "MALFORMED_CSS", "Selector string contains a newline")
                if ch == quote: quote = ""
            elif ch in "\"'": quote = ch
            elif ch == "(": round_depth += 1
            elif ch == ")": round_depth -= 1
            elif ch == "[": square_depth += 1
            elif ch == "]": square_depth -= 1
            elif ch == "{" and round_depth == square_depth == 0:
                opening = index
                break
            elif ch in "};" and round_depth == square_depth == 0:
                raise DomError("MALFORMED_CSS", "Stylesheet has text outside a qualified rule")
            require(round_depth >= 0 and square_depth >= 0, "MALFORMED_CSS",
                    "Selector delimiters are unbalanced")
            index += 1
        require(opening >= 0 and not quote and round_depth == square_depth == 0,
                "MALFORMED_CSS", "Stylesheet selector is unterminated")
        prelude = trim_css_range(css, prelude_start, opening)
        require(prelude[0] < prelude[1], "MALFORMED_CSS", "Stylesheet selector is empty")
        body_start, index = opening + 1, opening + 1
        quote, round_depth, square_depth, closing = "", 0, 0, -1
        while index < len(css):
            ch = css[index]
            if quote:
                require(ch not in "\n\r\f", "MALFORMED_CSS", "Declaration string contains a newline")
                if ch == quote: quote = ""
            elif ch in "\"'": quote = ch
            elif ch == "(": round_depth += 1
            elif ch == ")": round_depth -= 1
            elif ch == "[": square_depth += 1
            elif ch == "]": square_depth -= 1
            elif ch == "{":
                raise DomError("UNSAFE_CSS_NESTING", "Nested CSS rules are forbidden")
            elif ch == "}" and round_depth == square_depth == 0:
                closing = index
                break
            require(round_depth >= 0 and square_depth >= 0, "MALFORMED_CSS",
                    "Declaration delimiters are unbalanced")
            index += 1
        require(closing >= 0 and not quote and round_depth == square_depth == 0,
                "MALFORMED_CSS", "Stylesheet declaration block is unterminated")
        rules.append((prelude[0], prelude[1], body_start, closing))
        require(len(rules) <= limits["css_rules"], "CSS_RULE_LIMIT", "Stylesheet has too many rules")
        index = closing + 1
    require(bool(rules), "MALFORMED_CSS", "Stylesheet must contain a qualified rule")
    return rules


def assert_scoped_selector(selector: str, scope: str) -> None:
    require(selector.startswith(scope), "CSS_SCOPE_ESCAPE", "Stylesheet selector escapes its scope")
    remainder = selector[len(scope):]
    if not remainder:
        return
    require(remainder[0] in CSS_WHITESPACE + ">+~.#[:|", "MALFORMED_CSS_SELECTOR",
            "Scoped selector has an invalid initial compound")
    quote, round_depth, square_depth, index = "", 0, 0, 0
    while index < len(remainder):
        ch = remainder[index]
        if quote:
            if ch == quote: quote = ""
            index += 1; continue
        if ch in "\"'": quote = ch
        elif ch == "(": round_depth += 1
        elif ch == ")": round_depth -= 1
        elif ch == "[": square_depth += 1
        elif ch == "]": square_depth -= 1
        if round_depth or square_depth:
            index += 1; continue
        require(ch not in "+~" and not (ch == "|" and index + 1 < len(remainder) and remainder[index + 1] == "|"),
                "CSS_SCOPE_ESCAPE", "Stylesheet selector can select a sibling outside its scope")
        if ch == ">":
            return
        if ch in CSS_WHITESPACE:
            while index + 1 < len(remainder) and remainder[index + 1] in CSS_WHITESPACE:
                index += 1
            following = remainder[index + 1:index + 3]
            require(not following.startswith(("+", "~", "||")), "CSS_SCOPE_ESCAPE",
                    "Stylesheet selector can select a sibling outside its scope")
            return
        index += 1


def matching_css_paren(css: str, opening: int, end: int) -> int:
    quote, depth = "", 1
    for index in range(opening + 1, end):
        ch = css[index]
        if quote:
            if ch == quote: quote = ""
            continue
        if ch in "\"'": quote = ch
        elif ch == "(": depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0: return index
    raise DomError("MALFORMED_CSS", "Stylesheet function is unterminated")


def css_url_token(css: str, opening: int, closing: int) -> str:
    start, end = trim_css_range(css, opening + 1, closing)
    require(start < end, "UNBOUND_CSS_URL", "Stylesheet URL is empty")
    quote = css[start]
    if quote in "\"'":
        require(end - start >= 2 and css[end - 1] == quote, "MALFORMED_CSS",
                "Stylesheet URL string is unterminated")
        token = css[start + 1:end - 1]
    else:
        token = css[start:end]
        require(re.search(r"[\s\"'()]", token) is None, "MALFORMED_CSS",
                "Stylesheet URL token is malformed")
    scheme = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", token)
    require(scheme is None or token.startswith("dom-asset:"), "UNSAFE_CSS",
            "Stylesheet URL may perform an external request")
    require(re.fullmatch(r"dom-asset:[a-z][a-z0-9._-]{0,63}", token) is not None,
            "UNBOUND_CSS_URL", f"Stylesheet URL {token} is not a logical asset token")
    return token


def scan_css_functions(css: str, start: int, end: int,
                       counters: dict[str, Any], limits: dict[str, int]) -> None:
    index, quote = start, ""
    while index < end:
        ch = css[index]
        if quote:
            if ch == quote: quote = ""
            index += 1; continue
        if ch in "\"'":
            quote = ch; index += 1; continue
        if re.match(r"[A-Za-z_-]", ch) is None:
            index += 1; continue
        cursor = index + 1
        while cursor < end and re.match(r"[A-Za-z0-9_-]", css[cursor]):
            cursor += 1
        if cursor >= end or css[cursor] != "(":
            index = cursor; continue
        name = css[index:cursor].lower()
        require(name in SAFE_CSS_FUNCTIONS, "UNSAFE_CSS_FUNCTION",
                f"Stylesheet function {name}() is forbidden")
        counters["functions"] += 1
        require(counters["functions"] <= limits["css_functions"], "CSS_FUNCTION_LIMIT",
                "Stylesheet has too many functions")
        if name == "url":
            closing = matching_css_paren(css, cursor, end)
            counters["urls"].append(css_url_token(css, cursor, closing))
            index = closing + 1
        else:
            index = cursor + 1


def validate_css(payload: bytes, binding: dict, resources: dict[str, dict], limits: dict[str, int]) -> None:
    require(len(payload) <= limits["css"], "CSS_SIZE_LIMIT", "CSS is too large")
    try:
        css = payload.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise DomError("MALFORMED_UTF8", f"Stylesheet is not UTF-8: {error}") from error
    require("\\" not in css, "UNSAFE_CSS_ESCAPE", "Stylesheet escapes are forbidden")
    require("/*" not in css and "*/" not in css, "UNSAFE_CSS_COMMENT", "Stylesheet comments are forbidden")
    require("@" not in css and "<!--" not in css and "-->" not in css,
            "UNSAFE_CSS", "Stylesheet at-rules and CDO/CDC tokens are forbidden")
    require(all(ord(ch) >= 0x20 or ch in "\t\n\f\r" for ch in css),
            "UNSAFE_CSS_CONTROL", "Stylesheet contains a forbidden control")
    counters: dict[str, Any] = {"functions": 0, "urls": [], "selectors": 0, "declarations": 0}
    scope = binding["scope"]
    for prelude_start, prelude_end, body_start, body_end in parse_css_rules(css, limits):
        for start, end in split_css_top_level(css, prelude_start, prelude_end, ",",
                                              "MALFORMED_CSS_SELECTOR", "Stylesheet selector list"):
            require(start < end, "MALFORMED_CSS_SELECTOR", "Stylesheet selector is empty")
            require(len(css[start:end].encode("utf-8")) <= limits["css_selector_bytes"],
                    "CSS_SELECTOR_LIMIT", "Stylesheet selector is too long")
            assert_scoped_selector(css[start:end], scope)
            counters["selectors"] += 1
            require(counters["selectors"] <= limits["css_selectors"], "CSS_SELECTOR_LIMIT",
                    "Stylesheet has too many selectors")
            scan_css_functions(css, start, end, counters, limits)
        for start, end in split_css_top_level(css, body_start, body_end, ";",
                                              "MALFORMED_CSS", "Stylesheet declaration list"):
            if start == end:
                continue
            colon = css_top_level_colon(css, start, end)
            require(colon > start, "MALFORMED_CSS", "Stylesheet declaration lacks a colon")
            property_start, property_end = trim_css_range(css, start, colon)
            value_start, value_end = trim_css_range(css, colon + 1, end)
            property_name = css[property_start:property_end]
            require(re.fullmatch(r"-?[A-Za-z][A-Za-z0-9-]*", property_name) is not None
                    and not property_name.startswith("--"), "UNSAFE_CSS_PROPERTY",
                    f"Stylesheet property {property_name} is invalid")
            require(property_name.lower() in SAFE_CSS_PROPERTIES, "UNSAFE_CSS_PROPERTY",
                    f"Stylesheet property {property_name} is forbidden or outside polycss-3d@0")
            require(value_start < value_end, "MALFORMED_CSS", "Stylesheet declaration value is empty")
            counters["declarations"] += 1
            require(counters["declarations"] <= limits["css_declarations"], "CSS_DECLARATION_LIMIT",
                    "Stylesheet has too many declarations")
            scan_css_functions(css, value_start, value_end, counters, limits)
    token_map = {entry["token"]: entry["resource"] for entry in binding["assetTokens"]}
    seen = set(counters["urls"])
    require(all(token in token_map for token in counters["urls"]), "UNBOUND_CSS_URL",
            "Stylesheet uses an undeclared logical asset token")
    require(seen == set(token_map), "UNUSED_CSS_TOKEN", "CSS token declarations and use differ")
    require(all(rid in resources and resources[rid]["kind"] == "image" for rid in token_map.values()),
            "MISSING_CSS_ASSET", "CSS asset role is invalid")


def image_dimensions(payload: bytes, media: str) -> tuple[int, int]:
    if media == "image/png":
        signature = b"\x89PNG\r\n\x1a\n"
        require(len(payload) >= 45 and payload.startswith(signature),
                "IMAGE_MEDIA_MISMATCH", "PNG signature invalid or truncated")
        offset, dimensions, palette, image_data, image_data_ended, ended = 8, None, False, False, False, False
        color_type = None
        valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
        while offset < len(payload):
            require(offset + 12 <= len(payload), "IMAGE_MEDIA_MISMATCH", "PNG chunk header truncated")
            length = int.from_bytes(payload[offset:offset + 4], "big")
            chunk_type = payload[offset + 4:offset + 8]
            start, end = offset + 8, offset + 8 + length
            require(end + 4 <= len(payload), "IMAGE_MEDIA_MISMATCH", "PNG chunk exceeds resource bytes")
            expected_crc = int.from_bytes(payload[end:end + 4], "big")
            require((binascii.crc32(payload[offset + 4:end]) & 0xFFFFFFFF) == expected_crc,
                    "IMAGE_MEDIA_MISMATCH", "PNG chunk CRC invalid")
            if dimensions is None:
                require(chunk_type == b"IHDR" and length == 13,
                        "IMAGE_MEDIA_MISMATCH", "PNG IHDR must be first and exactly 13 bytes")
                width, height = int.from_bytes(payload[start:start + 4], "big"), int.from_bytes(payload[start + 4:start + 8], "big")
                bit_depth, color_type = payload[start + 8], payload[start + 9]
                require(width > 0 and height > 0 and bit_depth in valid_depths.get(color_type, set()),
                        "IMAGE_MEDIA_MISMATCH", "PNG IHDR dimensions, color, or depth invalid")
                require(payload[start + 10] == 0 and payload[start + 11] == 0 and payload[start + 12] in (0, 1),
                        "IMAGE_MEDIA_MISMATCH", "PNG IHDR methods unsupported")
                dimensions = (width, height)
            elif chunk_type == b"IHDR":
                raise DomError("IMAGE_MEDIA_MISMATCH", "PNG contains duplicate IHDR")
            elif chunk_type == b"PLTE":
                require(not palette and not image_data and length > 0 and length % 3 == 0 and length <= 768,
                        "IMAGE_MEDIA_MISMATCH", "PNG palette invalid or out of order")
                palette = True
            elif chunk_type == b"IDAT":
                require(not image_data_ended and length > 0,
                        "IMAGE_MEDIA_MISMATCH", "PNG image-data chunks must be nonempty and consecutive")
                image_data = True
            elif chunk_type == b"IEND":
                require(length == 0 and image_data and end + 4 == len(payload),
                        "IMAGE_MEDIA_MISMATCH", "PNG IEND invalid or followed by trailing bytes")
                ended = True
            elif chunk_type in (b"acTL", b"fcTL", b"fdAT"):
                raise DomError("IMAGE_ANIMATION_UNSUPPORTED",
                               "Animated PNG resources are outside polycss-3d@0")
            else:
                if image_data:
                    image_data_ended = True
                require(not (0x41 <= chunk_type[0] <= 0x5A),
                        "IMAGE_MEDIA_MISMATCH", "PNG contains an unsupported critical chunk")
            offset = end + 4
            if ended:
                break
        require(ended and image_data and (color_type != 3 or palette),
                "IMAGE_MEDIA_MISMATCH", "PNG is missing image, palette, or end chunks")
        return dimensions

    require(media == "image/webp" and len(payload) >= 26 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP",
            "IMAGE_MEDIA_MISMATCH", "WebP header invalid or truncated")
    require(int.from_bytes(payload[4:8], "little") + 8 == len(payload), "IMAGE_MEDIA_MISMATCH", "WebP RIFF size invalid")
    offset, extended, primary = 12, None, None
    allowed_auxiliary = {b"ALPH", b"ICCP", b"EXIF", b"XMP "}
    while offset < len(payload):
        require(offset + 8 <= len(payload), "IMAGE_MEDIA_MISMATCH", "WebP chunk header truncated")
        kind = payload[offset:offset + 4]
        length = int.from_bytes(payload[offset + 4:offset + 8], "little")
        start, end = offset + 8, offset + 8 + length
        require(end + (length & 1) <= len(payload), "IMAGE_MEDIA_MISMATCH", "WebP chunk exceeds RIFF bytes")
        if length & 1:
            require(payload[end] == 0, "IMAGE_MEDIA_MISMATCH", "WebP padding byte must be zero")
        if kind == b"VP8X":
            require(offset == 12 and length == 10 and extended is None and primary is None,
                    "IMAGE_MEDIA_MISMATCH", "WebP VP8X is malformed or misplaced")
            flags = payload[start]
            require(flags & 0xC3 == 0 and payload[start + 1:start + 4] == b"\0\0\0",
                    "IMAGE_MEDIA_MISMATCH", "WebP VP8X reserved bits or animation unsupported")
            extended = (int.from_bytes(payload[start + 4:start + 7], "little") + 1,
                        int.from_bytes(payload[start + 7:start + 10], "little") + 1)
        elif kind == b"VP8L":
            require(primary is None and length >= 6 and payload[start] == 0x2F,
                    "IMAGE_MEDIA_MISMATCH", "WebP VP8L duplicated or malformed")
            bits = int.from_bytes(payload[start + 1:start + 5], "little")
            require(bits >> 29 == 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8L version unsupported")
            primary = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        elif kind == b"VP8 ":
            require(primary is None and length >= 11, "IMAGE_MEDIA_MISMATCH", "WebP VP8 duplicated or truncated")
            frame_tag = int.from_bytes(payload[start:start + 3], "little")
            partition = frame_tag >> 5
            require(frame_tag & 1 == 0 and frame_tag & 0x10 and partition > 0 and 10 + partition <= length,
                    "IMAGE_MEDIA_MISMATCH", "WebP VP8 frame tag invalid")
            require(payload[start + 3:start + 6] == b"\x9d\x01\x2a", "IMAGE_MEDIA_MISMATCH", "WebP VP8 key-frame header invalid")
            primary = (int.from_bytes(payload[start + 6:start + 8], "little") & 0x3FFF,
                       int.from_bytes(payload[start + 8:start + 10], "little") & 0x3FFF)
            require(primary[0] > 0 and primary[1] > 0, "IMAGE_MEDIA_MISMATCH", "WebP VP8 dimensions invalid")
        else:
            require(kind in allowed_auxiliary and extended is not None,
                    "IMAGE_MEDIA_MISMATCH", "WebP chunk unsupported or lacks VP8X")
        offset = end + (length & 1)
    require(offset == len(payload) and primary is not None,
            "IMAGE_MEDIA_MISMATCH", "WebP has no complete primary image bitstream")
    require(extended is None or extended == primary,
            "IMAGE_MEDIA_MISMATCH", "WebP VP8X and primary dimensions disagree")
    return extended or primary


def read_capped_file(path: Path, maximum: int, label: str,
                     expected: int | None = None, no_follow: bool = False) -> tuple[bytearray, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if no_follow:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        require(stat_module.S_ISREG(metadata.st_mode), "UNSAFE_FILE_TYPE",
                f"{label} is not a regular file")
        require(metadata.st_size >= 0, "FILE_LIMIT", f"{label} has an invalid size")
        if expected is not None:
            require(metadata.st_size == expected, "RESOURCE_SIZE_MISMATCH",
                    f"{label} size does not match its package record")
        require(metadata.st_size <= maximum, "FILE_LIMIT",
                f"{label} exceeds its byte limit")
        output = bytearray(metadata.st_size)
        view = memoryview(output)
        offset = 0
        with os.fdopen(os.dup(descriptor), "rb", buffering=0) as stream:
            while offset < metadata.st_size:
                count = stream.readinto(view[offset:])
                require(count > 0, "FILE_CHANGED_DURING_READ",
                        f"{label} changed while it was read")
                offset += count
            require(not stream.read(1), "FILE_CHANGED_DURING_READ",
                    f"{label} grew while it was read")
        final_metadata = os.fstat(descriptor)
        require((final_metadata.st_dev, final_metadata.st_ino, final_metadata.st_size,
                 final_metadata.st_mtime_ns, final_metadata.st_ctime_ns)
                == (metadata.st_dev, metadata.st_ino, metadata.st_size,
                    metadata.st_mtime_ns, metadata.st_ctime_ns),
                "FILE_CHANGED_DURING_READ", f"{label} metadata changed while it was read")
        return output, metadata
    finally:
        os.close(descriptor)


def read_dom(path: Path, require_resources: bool = True) -> dict[str, Any]:
    limits = dict(DEFAULT_LIMITS)
    data, _ = read_capped_file(path, limits["file"], "domformat package")
    encoding, json_bytes = parse_transport(bytes(data), limits)
    document = strict_keys(
        parse_json(json_bytes, "domformat JSON document"),
        set(DOCUMENT_FIELDS),
        "INVALID_DOCUMENT", "Decoded document",
    )
    document = {name: document.get(name) for name in DOCUMENT_FIELDS}
    validate_meta(document["meta"])
    records, resource_map = validate_resources(document["resources"], limits)
    nodes, node_ids = validate_tree(document["tree"], resource_map, limits)
    cssb = strict_keys(document["cssBinding"], {"version", "stylesheets"}, "INVALID_CSS_BINDING", "CSSB")
    require(as_int(cssb.get("version"), "UNSUPPORTED_CSS_BINDING_SCHEMA", "CSSB version") == 0,
            "UNSUPPORTED_CSS_BINDING_SCHEMA", "CSSB version must be zero")
    stylesheets = cssb.get("stylesheets")
    require(isinstance(stylesheets, list) and stylesheets, "INVALID_CSS_BINDING", "CSSB stylesheets invalid")
    css_ids = set()
    for binding in stylesheets:
        binding = strict_keys(binding, {"id", "resource", "scope", "assetTokens"}, "INVALID_CSS_BINDING", "stylesheet binding")
        bid, rid = resource_id(binding.get("id"), "stylesheet id"), resource_id(binding.get("resource"), "stylesheet resource")
        require(bid not in css_ids and rid in resource_map and resource_map[rid]["kind"] == "stylesheet",
                "MISSING_CSS_RESOURCE", "Stylesheet binding is invalid")
        css_ids.add(bid)
        scope_match = (re.fullmatch(r'\[data-([a-z0-9-]{1,64})="([A-Za-z0-9._-]{1,64})"\]', binding.get("scope"))
                       if isinstance(binding.get("scope"), str) else None)
        require(scope_match is not None,
                "INVALID_CSS_SCOPE", "Stylesheet scope invalid")
        require([f"data-{scope_match.group(1)}", scope_match.group(2)] in document["tree"]["mount"]["attributes"],
                "CSS_SCOPE_MISMATCH", "Stylesheet scope is not an exact TREE mount attribute")
        tokens = binding.get("assetTokens")
        require(isinstance(tokens, list) and len(tokens) <= limits["css_asset_tokens"],
                "CSS_TOKEN_LIMIT", "Stylesheet tokens invalid or excessive")
        token_names = set()
        for entry in tokens:
            entry = strict_keys(entry, {"token", "resource"}, "INVALID_CSS_BINDING", "asset token")
            require(isinstance(entry.get("token"), str) and re.fullmatch(r"dom-asset:[a-z][a-z0-9._-]{0,63}", entry["token"])
                    and entry["token"] not in token_names, "INVALID_CSS_TOKEN", "CSS token invalid")
            require(entry.get("resource") in resource_map and resource_map[entry["resource"]]["kind"] == "image",
                    "MISSING_CSS_ASSET", "CSS token image resource invalid")
            token_names.add(entry["token"])
    state_channels, binding_channels = validate_state_bindings(document["state"], document["bindings"], node_ids, limits)
    validate_initial_surface_closure(document, nodes)
    validate_presentation_closure(document, nodes, resource_map)
    interpreters = {channel["interpreter"] for channel in binding_channels}
    expected_capabilities = list(BASE_REQUIRED_CAPABILITIES)
    expected_capabilities.extend(capability for interpreter, capability in CAPABILITY_INTERPRETER_ORDER
                                 if interpreter in interpreters)
    require(document["meta"]["capabilities"] == expected_capabilities,
            "CAPABILITY_CLOSURE_MISMATCH", "META required capabilities do not match executable interpreters")
    expected_conformance = ["retained-tree"]
    expected_conformance.extend(role for interpreter, role in CONFORMANCE_INTERPRETER_ORDER
                                if interpreter in interpreters)
    require(document["meta"]["conformance"]["executable"] == expected_conformance
            and document["meta"]["conformance"]["declaredOnly"] == [],
            "CONFORMANCE_CLOSURE_MISMATCH", "META conformance does not match executable interpreters")
    if document["meta"].get("initialExperience") == "interaction":
        require("prepared-pointer-grab-interaction" in document["meta"]["capabilities"],
                "MISSING_INITIAL_EXPERIENCE", "Interaction initial experience lacks its capability")
        interaction = next((channel for channel in binding_channels
                            if channel["interpreter"] == "polycss-pointer-grab@0"), None)
        require(interaction is not None and interaction["status"] == "executable",
                "MISSING_INITIAL_EXPERIENCE", "Interaction initial experience lacks an executable binding")
    counts = document["meta"].get("counts")
    if counts is not None:
        if "nodes" in counts:
            require(as_int(counts["nodes"], "META_COUNT_MISMATCH", "META node count") == len(nodes),
                    "META_COUNT_MISMATCH", "META node count does not match TREE")
        playback = next((channel for channel in binding_channels
                         if channel["interpreter"] == "polycss-playback@0"), None)
        actual_counts = {"shapes": None, "leaves": None, "sourceFrames": None}
        if playback is not None:
            targets = playback["targets"]
            shapes, leaves = targets.get("shapes"), targets.get("leaves")
            require(isinstance(shapes, list) and isinstance(leaves, list),
                    "TARGET_CARDINALITY_MISMATCH", "Playback count targets must be arrays")
            parameters = playback["parameters"]
            frame_count = as_int(parameters.get("frameCount"), "INVALID_CODEC_BINDING",
                                 "polycss-playback@0 frameCount", 1)
            actual_counts = {
                "shapes": len(shapes),
                "leaves": len(leaves),
                "sourceFrames": frame_count,
            }
        for name, actual in actual_counts.items():
            if name in counts:
                require(actual is not None and as_int(counts[name], "META_COUNT_MISMATCH", f"META {name} count") == actual,
                        "META_COUNT_MISMATCH", f"META {name} count does not match playback")
    used_resources = set()
    for binding in stylesheets:
        used_resources.add(binding["resource"])
        used_resources.update(entry["resource"] for entry in binding["assetTokens"])
    used_resources.update(binding["resource"] for binding in document["tree"]["mount"].get("resourceStyles", {}).values())
    for node in nodes:
        used_resources.update(node.get("resourceAttributes", {}).values())
        used_resources.update(binding["resource"] for binding in node.get("resourceStyles", {}).values())
    presentation = next((channel for channel in state_channels if channel["codec"] == "static-presentation@0"), None)
    if presentation is not None and presentation["data"]["packet"].get("background") is not None:
        used_resources.add(presentation["data"]["packet"]["background"].get("resource"))
    require(used_resources == set(resource_map), "UNUSED_RESOURCE",
            "Every resource must be reachable from TREE, CSSB, or prepared presentation state")
    resource_bytes: dict[str, bytes] = {}
    if require_resources:
        lexical_base = path.parent.absolute()
        base = real_directory(lexical_base, "UNSAFE_RESOURCE_PATH",
                              "Resource directory")
        for record in records:
            relative = safe_path(record["path"], f"resource {record['id']} path")
            lexical_target = base / relative
            try:
                reject_symlink_components(base, relative, "UNSAFE_RESOURCE_PATH",
                                          f"Resource {record['id']} path")
                target = lexical_target.resolve(strict=True)
                require(target == base or base in target.parents, "UNSAFE_RESOURCE_PATH",
                        "Resource resolves outside package directory")
                expected = as_int(record["byteLength"], "RESOURCE_SIZE_MISMATCH", "resource size")
                payload, opened = read_capped_file(
                    lexical_target, min(expected, limits["resource"]),
                    f"resource {record['id']}", expected, True)
                final_target = lexical_target.resolve(strict=True)
                require(final_target == base or base in final_target.parents,
                        "UNSAFE_RESOURCE_PATH", "Resource moved outside package directory")
                final_metadata = os.stat(lexical_target)
                require(final_metadata.st_dev == opened.st_dev and final_metadata.st_ino == opened.st_ino,
                        "FILE_CHANGED_DURING_READ", f"Resource {record['id']} path changed while loading")
                resource_bytes[record["id"]] = payload
            except OSError as error:
                raise DomError("MISSING_EXTERNAL_RESOURCE", f"Cannot read resource {record['id']}: {error}") from error
    for record in records:
        payload = resource_bytes.get(record["id"])
        if payload is None:
            continue
        require(len(payload) == as_int(record["byteLength"], "RESOURCE_SIZE_MISMATCH", "resource size"),
                "RESOURCE_SIZE_MISMATCH", f"Resource {record['id']} size mismatch")
        require(hashlib.sha256(payload).hexdigest() == record["digest"]["value"],
                "RESOURCE_DIGEST_MISMATCH", f"Resource {record['id']} digest mismatch")
        if record["kind"] == "image":
            width, height = image_dimensions(payload, record["mediaType"])
            require(width == as_int(record["dimensions"]["width"], "IMAGE_DIMENSION_MISMATCH", "width")
                    and height == as_int(record["dimensions"]["height"], "IMAGE_DIMENSION_MISMATCH", "height"),
                    "IMAGE_DIMENSION_MISMATCH", f"Resource {record['id']} dimensions mismatch")
    for binding in stylesheets:
        payload = resource_bytes.get(binding["resource"])
        if payload is not None:
            validate_css(payload, binding, resource_map, limits)
    if require_resources:
        require(len(resource_bytes) == len(records), "MISSING_EXTERNAL_RESOURCE", "External resources missing")
    plan_rows = [[node["id"], int(node["parent"]), int(node["sibling"]), node["namespace"], node["name"]]
                 for node in nodes]
    binding_rows = [[channel["id"], channel["state"], channel["interpreter"], channel["targets"], channel["sinks"]]
                    for channel in binding_channels]
    return {
        "document": document,
        "transport": {
            "encoding": encoding,
            "decodedBytes": len(json_bytes),
        },
        "resourceBytes": resource_bytes,
        "summary": {
            "format": document["meta"]["format"],
            "profile": document["meta"]["profile"],
            "bytes": len(data),
            "nodes": len(nodes),
            "stateChannels": len(state_channels),
            "bindingChannels": len(binding_channels),
            "resources": len(records),
            "allResourcesVerified": len(resource_bytes) == len(records),
            "treePayloadSha256": hashlib.sha256(canonical_encode(document["tree"])).hexdigest(),
            "constructionPlanSha256": hashlib.sha256(canonical_encode(plan_rows)).hexdigest(),
            "bindingPlanSha256": hashlib.sha256(canonical_encode(binding_rows)).hexdigest(),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Independent domformat@0 reader")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("validate", "inspect"):
        sub = subparsers.add_parser(command)
        sub.add_argument("file", type=Path)
        sub.add_argument("--no-resources", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = read_dom(args.file, not args.no_resources)
        if args.command == "validate":
            summary = result["summary"]
            print(f"valid {summary['format']} {summary['profile']}; {summary['bytes']} bytes; "
                  f"{summary['nodes']} nodes; {summary['resources']} resources verified")
        else:
            print(json.dumps(result["summary"], indent=2, sort_keys=True))
        return 0
    except DomError as error:
        print(f"domformat-python: {error.code}: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"domformat-python: IO_ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
