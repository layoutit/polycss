#!/usr/bin/env python3
"""Independent stdlib producer for the domformat@0 executable fixture.

This file intentionally imports no domformat implementation module and reads no
reference manifest or committed fixture.  It constructs one small retained-DOM
contract directly from the normative specification, computes its resources,
and writes canonical JSON with integrity-bound sibling files.

It is conformance evidence, not a public producer API.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import stat
import struct
import sys
import unicodedata
import zlib
from pathlib import Path
from typing import Any


FORMAT_ID = "domformat@0"
PROFILE_ID = "polycss-3d@0"
NAMESPACE = "http://www.w3.org/1999/xhtml"
SAFE_INTEGER = 9_007_199_254_740_991
RESOURCE_PATHS = {
    "independent-checker": "assets/independent-checker.png",
    "independent-css": "independent.css",
}


class ProducerError(Exception):
    """A deterministic producer precondition failed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProducerError(message)


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be")


def ecma_number(value: float) -> str:
    """ECMAScript-compatible shortest finite number spelling."""
    require(math.isfinite(value), "Canonical JSON numbers must be finite")
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
    require(bool(digits), "Canonical JSON number has no digits")
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


def canonical_json(value: Any, depth: int = 0) -> bytes:
    """Encode the deterministic writer form without using JavaScript code."""
    require(depth <= 256, "Canonical JSON nesting exceeds 256 levels")
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, int):
        require(abs(value) <= SAFE_INTEGER, "Canonical JSON integer is unsafe")
        return str(value).encode("ascii")
    if isinstance(value, float):
        return ecma_number(value).encode("ascii")
    if isinstance(value, str):
        require(all(not 0xD800 <= ord(character) <= 0xDFFF for character in value),
                "Canonical JSON string contains a surrogate")
        normalized = unicodedata.normalize("NFC", value)
        return json.dumps(normalized, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")
    if isinstance(value, list):
        return b"[" + b",".join(canonical_json(entry, depth + 1)
                                  for entry in value) + b"]"
    require(isinstance(value, dict), "Value is not JSON data")
    normalized: dict[str, Any] = {}
    for key, entry in value.items():
        require(isinstance(key, str), "Canonical JSON object key is not a string")
        normalized_key = unicodedata.normalize("NFC", key)
        require(normalized_key not in normalized,
                "Canonical JSON object keys collide after NFC normalization")
        normalized[normalized_key] = entry
    fields = []
    for key in sorted(normalized, key=utf16_sort_key):
        fields.append(canonical_json(key, depth + 1) + b":"
                      + canonical_json(normalized[key], depth + 1))
    return b"{" + b",".join(fields) + b"}"


def reverse_objects(value: Any) -> Any:
    if isinstance(value, list):
        return [reverse_objects(entry) for entry in value]
    if isinstance(value, dict):
        return {
            key: reverse_objects(value[key])
            for key in reversed(list(value.keys()))
        }
    return value


def ordinary_json(value: Any) -> bytes:
    """Produce deliberately noncanonical but equivalent reader-form JSON."""
    text = json.dumps(reverse_objects(value), ensure_ascii=False, allow_nan=False,
                      indent=2)
    text = text.replace('"version": 0', '"version": 0e0', 1)
    return (text + "\n").encode("utf-8")


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    require(len(kind) == 4, "PNG chunk type must be four bytes")
    checksum = binascii.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def checker_png() -> bytes:
    """Create an independently authored static 2x2 RGBA checker."""
    rows = [
        bytes((0, 245, 61, 90, 255, 14, 18, 31, 255)),
        bytes((0, 14, 18, 31, 255, 245, 61, 90, 255)),
    ]
    header = struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", header)
            + png_chunk(b"IDAT", zlib.compress(b"".join(rows), level=9))
            + png_chunk(b"IEND", b""))


def stylesheet() -> bytes:
    return (
        '[data-independent-producer="scene"] .model,'
        '[data-independent-producer="scene"] .shape{position:absolute;transform-style:preserve-3d;}'
        '[data-independent-producer="scene"] .leaf{position:absolute;display:block;'
        'background-image:url("dom-asset:independent-checker");image-rendering:pixelated;}'
        '[data-independent-producer="scene"] .cursor,'
        '[data-independent-producer="scene"] .effects{position:absolute;left:0;top:0;}'
    ).encode("utf-8")


def identity_matrix() -> list[int]:
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def little_endian_base64(values: list[int], width: int) -> str:
    output = bytearray()
    for value in values:
        require(0 <= value < 1 << (width * 8), "Integer does not fit prepared table")
        output.extend(value.to_bytes(width, "little"))
    return base64.b64encode(output).decode("ascii")


def node(index: int, stable_id: str, parent: int, sibling: int, name: str,
         *, classes: list[str] | None = None,
         attributes: dict[str, str] | None = None,
         styles: dict[str, str] | None = None,
         resource_attributes: dict[str, Any] | None = None,
         resource_styles: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "index": index,
        "id": stable_id,
        "parent": parent,
        "sibling": sibling,
        "namespace": NAMESPACE,
        "name": name,
        "classes": classes or [],
        "attributes": attributes or {},
        "styles": styles or {},
        "resourceAttributes": resource_attributes or {},
        "resourceStyles": resource_styles or {},
    }


def make_tree() -> dict[str, Any]:
    identity = "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)"
    image = {"backgroundImage": {
        "resource": "independent-checker",
        "syntax": "url",
    }}
    nodes = [
        node(0, "independent/camera", -1, 0, "div", classes=["camera"], styles={
            "height": "240px",
            "perspective": "400px",
            "perspectiveOrigin": "160px 120px",
            "position": "relative",
            "width": "320px",
        }),
        node(1, "independent/model", 0, 0, "div", classes=["model"], styles={
            "transform": "translate3d(0px, 0px, 0px)",
            "transformStyle": "preserve-3d",
        }),
        node(2, "independent/shape:grab", 1, 0, "div", classes=["shape"]),
        node(3, "independent/leaf:grab", 2, 0, "u", classes=["leaf"],
             attributes={"aria-hidden": "true"}, styles={
                 "backgroundPositionY": "0",
                 "height": "32px",
                 "transform": identity,
                 "visibility": "visible",
                 "width": "32px",
             }, resource_styles=image),
        node(4, "independent/shape:eye", 1, 1, "div", classes=["shape"]),
        node(5, "independent/leaf:eye", 4, 0, "u", classes=["leaf"],
             attributes={"aria-hidden": "true"}, styles={
                 "backgroundPositionY": "0",
                 "height": "32px",
                 "transform": identity,
                 "visibility": "visible",
                 "width": "32px",
             }, resource_styles=image),
        node(6, "independent/cursor", -1, 1, "div", classes=["cursor"]),
        node(7, "independent/cursor:open", 6, 0, "span",
             attributes={"aria-hidden": "true"},
             styles={"visibility": "hidden"}),
        node(8, "independent/cursor:closed", 6, 1, "span",
             attributes={"aria-hidden": "true"},
             styles={"visibility": "hidden"}),
        node(9, "independent/effects", -1, 2, "div", classes=["effects"]),
        node(10, "independent/effects/particle:0", 9, 0, "s",
             classes=["leaf"], attributes={"aria-hidden": "true"}, styles={
                 "backgroundPosition": "0px 0px",
                 "height": "2px",
                 "opacity": "0",
                 "transform": "translate3d(0px, 0px, 0px)",
                 "visibility": "hidden",
                 "width": "2px",
             }, resource_styles=image),
    ]
    return {
        "version": 0,
        "mount": {
            "behavior": "replace-children",
            "attributes": [["data-independent-producer", "scene"]],
            "styles": {
                "backgroundColor": "#090b13",
                "backgroundPosition": "center",
                "backgroundRepeat": "repeat",
                "backgroundSize": "8px 8px",
                "position": "relative",
            },
            "resourceStyles": {
                "backgroundImage": {
                    "resource": "independent-checker",
                    "syntax": "overlay-url",
                    "overlayOpacity": 0.25,
                },
            },
        },
        "nodes": nodes,
    }


def empty_transform_group() -> dict[str, Any]:
    return {
        "encoding": "decimal-component-streams",
        "empty": [0],
        "scales": [0] * 12,
        "columns": [[] for _ in range(12)],
    }


def fitted_leaf_group(translation_x: int | None = None) -> dict[str, Any]:
    columns = [[1000], [0], [0], [0], [1000], [0],
               [0], [0], [1000], [0], [0], [0]]
    if translation_x is not None:
        for column in columns:
            column.append(0)
        columns[9][1] = translation_x * 1000
    return {
        "encoding": "source-milli-fitted-leaf",
        "empty": [],
        "scales": [1000] * 12,
        "columns": columns,
    }


def playback_channel() -> dict[str, Any]:
    packet = {
        "version": 0,
        "layout": "delta-component-streams@0",
        "shapeCount": 2,
        "leafCount": 2,
        "appearances": [["default", 1, 0]],
        "timeline": {"introTicks": 0, "loopTicks": 8,
                     "frames": [1, 2, 3, 4, 5, 6, 7, 8]},
        "initial": {
            "sourceFrame": 1,
            "appearance": 0,
            "modelTransform": 0,
            "shapes": {"count": 2, "transforms": [1, 1],
                       "visibility": [1, 1]},
            "leaves": {"count": 2, "transforms": [3, 1]},
        },
        "frameRows": [
            [1, 0, -1, 0, 0, 0, 1],
            [2, 0, -1, 0, 0, 1, 1],
            *[[frame, 0, -1, 0, 0, 2, 0] for frame in range(3, 9)],
        ],
        "shapeChanges": {"sources": [], "transforms": [], "visibility": []},
        "leafChanges": {"sources": [0, 0], "transforms": [3, 2]},
        "transforms": {
            "count": 6,
            "groups": [empty_transform_group(), empty_transform_group(),
                       empty_transform_group(), fitted_leaf_group(16),
                       fitted_leaf_group()],
        },
    }
    return {
        "id": "playback",
        "codec": "polycss-playback-packed@0",
        "data": {"packet": packet,
                 "leafFit": [{"canonicalSize": 32}, {"canonicalSize": 32}]},
    }


def surface_channel() -> dict[str, Any]:
    empty_offsets = little_endian_base64([0] * 9, 4)
    lighting_offsets = little_endian_base64([0, 1, 2, 2, 2, 2, 2, 2, 2], 4)
    return {
        "id": "surface",
        "codec": "polycss-surface-packed@0",
        "data": {"packet": {
            "version": 0,
            "frameCount": 8,
            "surface": {
                "faces": [
                    {"faceId": "independent-face-grab", "sourceOrder": 0,
                     "stateOffset": 0, "stateCount": 2,
                     "leafWidth": 32, "leafHeight": 32},
                    {"faceId": "independent-face-eye", "sourceOrder": 1,
                     "stateOffset": 2, "stateCount": 1,
                     "leafWidth": 32, "leafHeight": 32},
                ],
                "statePacking": {"stateCount": 3,
                                 "sourceFrameDeltas": [0, 1, 0]},
            },
            "transitions": {
                "initialFrame": 1,
                "sequential": {
                    "offsetsBase64": lighting_offsets,
                    "faceIndexDeltas": [0, 0],
                    "stateIndexDeltas": [0, 1],
                },
                "nonInteractiveJumps": [],
            },
            "visibility": {
                "initialFrame": 1,
                "initialVisibleBitsBase64": "Aw==",
                "sequential": {
                    "offsetsBase64": empty_offsets,
                    "faceIndicesBase64": "",
                },
                "nonInteractiveJumps": [],
            },
        }},
    }


def effects_channel() -> dict[str, Any]:
    return {
        "id": "effects",
        "codec": "polycss-effects-prepared@0",
        "data": {"packet": {
            "version": 0,
            "arithmetic": "ieee754-f32-per-operation",
            "frameCount": 8,
            "biases": {"continuous": [0, 0, 0], "grab": [0, 0, 0]},
            "particle": {"damping": 0.5, "gravityY": -1,
                         "sparkleFrameTable": [0, 0]},
            "spawnStream": {"count": 1, "tuples": [[2, 0, 0, 0]]},
            "stars": [],
            "emitters": [{"mode": "grab", "poolSize": 1,
                          "backgroundPositions": ["0px 0px"]}],
        }},
    }


def presentation_channel() -> dict[str, Any]:
    return {
        "id": "presentation",
        "codec": "static-presentation@0",
        "data": {"packet": {
            "version": 0,
            "camera": {
                "baseSceneTransform": "translate3d(0px, 0px, 0px)",
                "fitHeight": 240,
                "fitWidth": 320,
                "perspective": 400,
                "sourceHeight": 240,
                "sourceWidth": 320,
            },
            "background": {
                "resource": "independent-checker",
                "opacity": 0.25,
                "position": "center",
                "repeat": "repeat",
                "size": "8px 8px",
            },
        }},
    }


def interaction_channel() -> dict[str, Any]:
    identity = identity_matrix()
    packet = {
        "version": 0,
        "arithmetic": "ieee754-f32-per-operation",
        "input": {
            "sourceWidth": 320,
            "sourceHeight": 240,
            "cursorBounds": [16, 272, 16, 208],
            "cursorInitial": [160, 120],
            "pointerQuantization": "trunc-toward-zero-then-clamp",
            "stickRange": [-128, 127],
            "stickDeadzone": 6,
            "stickScale": 0.1,
            "grabButton": 32768,
            "holdButton": 16,
            "hitRadius": 20,
            "cursorVisibleTicks": 300,
            "mirrorX": 320,
        },
        "animator": {
            "initialState": 7,
            "initialFrame": 3,
            "introState": 0,
            "dozeState": 2,
            "sleepState": 3,
            "wakeState": 4,
            "convergeState": 5,
            "exitEyeState": 6,
            "eyeState": 7,
            "dozeLoopCount": 2,
            "dozeLoopStartFrame": 4,
            "dozeLoopEndFrame": 6,
            "sleepEndFrame": 8,
            "wakeStartFrame": 1,
            "eyeFrame": 3,
            "convergeStillTicks": 2,
            "eyeStillTicks": 4,
        },
        "source": {
            "cameraViewMatrix": identity,
            "cameraWorldPosition": [0, 0, 0],
            "inverseCameraMatrix": identity,
            "projection": {"scale": 256, "origin": [160, 120]},
            "displacementMagnitude": 1,
            "eyeGain": 2,
            "eyeMaximumOffset": 30,
            "spring": {
                "cursorResistance": 0.20000000298023224,
                "grabbedFlag": 8192,
                "pickedResistance": -0.25,
                "releaseAcceleration": 0.5,
                "snapOffsetL1": 1,
                "snapVelocityL1": 1,
                "velocityDecay": 0.800000011920929,
            },
        },
        "triangle": {
            "basisEpsilon": 1e-9,
            "primitive": "corner-bevel",
            "fallbackAmount": 0,
            "sharedEdgeAmount": 0,
        },
        "objects": {"rotationMatrices": identity},
        "shapes": {"baseMatrices": identity + identity},
        "leaves": [
            {"basis": [0, 1, 2], "canonicalSize": 32,
             "matrixDecimals": 3, "seamEdgeMask": 0,
             "width": 32, "height": 32},
            {"basis": [0, 1, 2], "canonicalSize": 32,
             "matrixDecimals": 3, "seamEdgeMask": 0,
             "width": 32, "height": 32},
        ],
        "controls": [
            {
                "id": "independent-grab",
                "role": "triangle",
                "mode": "grab",
                "sourceOrder": 0,
                "sourcePosition": [0, 0, 0],
                "screenPosition": [160, 120],
                "cameraDistance": 100,
                "attachmentObjectIndices": [0],
                "closure": {
                    "shapeIndices": [0],
                    "vertexRows": [0, 0, 0, 1, 0, 1, 1, 1, 0, 2, 2, 1],
                    "vertexPositions": [0, 0, 0, 0, 0, 32, 32, 0, 0],
                    "weightActiveFlags": [1, 1, 1],
                    "weightScalars": [1, 1, 1],
                    "weightLinearContributions": [0] * 9,
                    "weightBaseTranslations": [0] * 9,
                    "leafIndices": [0],
                    "leafRows": [0, 0, 1, 2],
                    "safeVisibleLeafIndices": [0],
                    "rigidRootInverseMatrix": [],
                },
            },
            {
                "id": "independent-eye",
                "role": "eye",
                "mode": "eye-follow",
                "sourceOrder": 1,
                "sourcePosition": [0, 0, -100],
                "screenPosition": [160, 120],
                "cameraDistance": 100,
                "attachmentObjectIndices": [0],
                "closure": {
                    "shapeIndices": [1],
                    "vertexRows": [1, 0, 0, 0, 1, 1, 0, 0, 1, 2, 0, 0],
                    "vertexPositions": [0, 0, 0, 0, 0, 32, 32, 0, 0],
                    "weightActiveFlags": [],
                    "weightScalars": [],
                    "weightLinearContributions": [],
                    "weightBaseTranslations": [],
                    "leafIndices": [1],
                    "leafRows": [1, 0, 1, 2],
                    "safeVisibleLeafIndices": [],
                    "rigidRootInverseMatrix": identity,
                },
            },
        ],
    }
    return {
        "id": "interaction",
        "codec": "polycss-pointer-grab-prepared@0",
        "data": {"packet": packet},
    }


def make_state() -> dict[str, Any]:
    channels = [effects_channel(), interaction_channel(), playback_channel(),
                presentation_channel(), surface_channel()]
    channels.sort(key=lambda entry: entry["id"])
    return {"version": 0, "channels": channels}


def make_bindings() -> dict[str, Any]:
    inputs = [
        {"id": "axis.x", "type": "float", "default": 0},
        {"id": "axis.y", "type": "float", "default": 0},
        {"id": "button.hold", "type": "boolean", "default": False},
        {"id": "interaction.grab-active", "type": "boolean", "default": False},
        {"id": "interaction.grab-x", "type": "float", "default": 0},
        {"id": "interaction.grab-y", "type": "float", "default": 0},
        {"id": "interaction.grab-z", "type": "float", "default": 0},
        {"id": "pointer.positioned", "type": "boolean", "default": False},
        {"id": "pointer.pressed", "type": "boolean", "default": False},
        {"id": "pointer.x", "type": "float", "default": 160},
        {"id": "pointer.y", "type": "float", "default": 120},
        {"id": "time.source-frame", "type": "uint"},
        {"id": "time.tick", "type": "uint"},
        {"id": "viewport.height", "type": "float"},
        {"id": "viewport.width", "type": "float"},
    ]
    inputs.sort(key=lambda entry: entry["id"])
    shape_targets = ["independent/shape:grab", "independent/shape:eye"]
    leaf_targets = ["independent/leaf:grab", "independent/leaf:eye"]
    channels = [
        {
            "id": "effects",
            "state": "effects",
            "interpreter": "polycss-effects@0",
            "status": "executable",
            "inputs": ["interaction.grab-active", "interaction.grab-x",
                       "interaction.grab-y", "interaction.grab-z",
                       "time.source-frame"],
            "targets": {"stars": [],
                        "emitters": [["independent/effects/particle:0"]]},
            "sinks": ["style.backgroundPosition", "style.opacity",
                      "style.transform", "style.visibility"],
            "parameters": {"frameCount": 8},
        },
        {
            "id": "interaction",
            "state": "interaction",
            "interpreter": "polycss-pointer-grab@0",
            "status": "executable",
            "inputs": ["axis.x", "axis.y", "button.hold",
                       "pointer.positioned", "pointer.pressed", "pointer.x",
                       "pointer.y"],
            "targets": {
                "shapes": shape_targets,
                "leaves": leaf_targets,
                "cursorLayer": "independent/cursor",
                "cursorStates": {
                    "open": "independent/cursor:open",
                    "closed": "independent/cursor:closed",
                },
            },
            "sinks": ["style.transform", "style.visibility"],
            "parameters": {"initialFrame": 3, "tickRateHz": 30},
        },
        {
            "id": "playback",
            "state": "playback",
            "interpreter": "polycss-playback@0",
            "status": "executable",
            "inputs": ["time.tick"],
            "targets": {
                "model": "independent/model",
                "shapes": shape_targets,
                "leaves": leaf_targets,
            },
            "sinks": ["style.transform", "style.visibility"],
            "parameters": {
                "baseSceneTransform": "translate3d(0px, 0px, 0px)",
                "frameCount": 8,
                "tickRateHz": 30,
            },
        },
        {
            "id": "presentation",
            "state": "presentation",
            "interpreter": "static-presentation@0",
            "status": "executable",
            "inputs": ["viewport.height", "viewport.width"],
            "targets": {
                "host": "$host",
                "camera": "independent/camera",
                "cursorLayer": "independent/cursor",
                "cursorStates": {
                    "open": "independent/cursor:open",
                    "closed": "independent/cursor:closed",
                },
            },
            "sinks": [
                "host.style.backgroundColor",
                "host.style.backgroundImage",
                "host.style.backgroundPosition",
                "host.style.backgroundRepeat",
                "host.style.backgroundSize",
                "style.height",
                "style.left",
                "style.top",
                "style.transform",
                "style.visibility",
                "style.width",
            ],
            "parameters": {"fitHeight": 240, "fitWidth": 320,
                           "sourceHeight": 240, "sourceWidth": 320},
        },
        {
            "id": "surface",
            "state": "surface",
            "interpreter": "polycss-surface@0",
            "status": "executable",
            "inputs": ["time.source-frame"],
            "targets": {"leaves": leaf_targets},
            "sinks": ["style.backgroundPositionY", "style.visibility"],
        },
    ]
    channels.sort(key=lambda entry: entry["id"])
    return {"version": 0, "inputs": inputs, "channels": channels}


def resource_bytes() -> dict[str, bytes]:
    return {
        "independent-checker": checker_png(),
        "independent-css": stylesheet(),
    }


def resource_record(resource_id: str, payload: bytes) -> dict[str, Any]:
    image = resource_id == "independent-checker"
    record: dict[str, Any] = {
        "id": resource_id,
        "kind": "image" if image else "stylesheet",
        "mediaType": "image/png" if image else "text/css;charset=utf-8",
        "byteLength": len(payload),
        "digest": {"algorithm": "sha256",
                   "value": hashlib.sha256(payload).hexdigest()},
        "path": RESOURCE_PATHS[resource_id],
    }
    if image:
        record["dimensions"] = {"width": 2, "height": 2}
    return record


def make_document() -> tuple[dict[str, Any], dict[str, bytes]]:
    resources = resource_bytes()
    records = [resource_record(resource_id, resources[resource_id])
               for resource_id in sorted(resources)]
    document: dict[str, Any] = {
        "meta": {
            "format": FORMAT_ID,
            "profile": PROFILE_ID,
            "title": "Independent producer executable scene",
            "generator": {
                "name": "domformat-python-conformance",
                "version": "0.0.0",
            },
            "capabilities": [
                "css-semantic-closure",
                "deterministic-json",
                "explicit-retained-tree",
                "logical-assets",
                "prepared-particle-effects",
                "prepared-pointer-grab-interaction",
                "prepared-playback",
                "prepared-surface-lighting",
            ],
            "optionalCapabilities": ["independent-producer-proof"],
            "initialExperience": "interaction",
            "conformance": {
                "executable": [
                    "retained-tree",
                    "particle-effects",
                    "playback",
                    "pointer-grab-interaction",
                    "presentation",
                    "surface-lighting",
                ],
                "declaredOnly": [],
            },
            "counts": {"nodes": 11, "shapes": 2,
                       "leaves": 2, "sourceFrames": 8},
        },
        "tree": make_tree(),
        "cssBinding": {
            "version": 0,
            "stylesheets": [{
                "id": "independent-css",
                "resource": "independent-css",
                "scope": '[data-independent-producer="scene"]',
                "assetTokens": [{
                    "token": "dom-asset:independent-checker",
                    "resource": "independent-checker",
                }],
            }],
        },
        "state": make_state(),
        "bindings": make_bindings(),
        "resources": {"version": 0, "resources": records},
    }
    return document, resources


def encoded_document(ordinary: bool = False) -> tuple[bytes, dict[str, bytes]]:
    document, resources = make_document()
    json_bytes = ordinary_json(document) if ordinary else canonical_json(document)
    return json_bytes, resources


def ensure_real_directory(path: Path) -> Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ProducerError(f"Output directory is unavailable: {error}") from error
    require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode),
            "Output parent must be a real directory, not a symlink")
    return path.resolve(strict=True)


def preflight_resource_target(base: Path, relative: str) -> tuple[Path, list[Path]]:
    parts = relative.split("/")
    require(parts and all(part not in {"", ".", ".."} for part in parts),
            "Internal resource path is unsafe")
    current = base
    missing: list[Path] = []
    for part in parts[:-1]:
        current = current / part
        if current.exists() or current.is_symlink():
            metadata = current.lstat()
            require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode),
                    f"Resource output component {current} is unsafe")
        else:
            missing.append(current)
    target = current / parts[-1]
    require(not target.exists() and not target.is_symlink(),
            f"Refusing to overwrite resource {target}")
    return target, missing


def ensure_resource_directories(directories: set[Path]) -> list[Path]:
    created: list[Path] = []
    for directory in sorted(
            directories, key=lambda value: (len(value.parts), value.as_posix())):
        if directory.exists() or directory.is_symlink():
            metadata = directory.lstat()
            require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode),
                    f"Resource output component {directory} is unsafe")
            continue
        directory.mkdir()
        created.append(directory)
    return created


def write_new(path: Path, payload: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def write_document(output: Path, ordinary: bool) -> dict[str, Any]:
    base = ensure_real_directory(output.parent)
    require(output.parent.resolve(strict=True) == base,
            "Output path parent changed during resolution")
    require(output.name not in {"", ".", ".."}, "Model output name is invalid")
    document_target = base / output.name
    require(output.suffix == ".json", "Output must use the .json extension")
    require(not document_target.exists() and not document_target.is_symlink(),
            f"Refusing to overwrite JSON output {document_target}")
    document_bytes, resources = encoded_document(ordinary)
    resource_targets: dict[str, Path] = {}
    required_directories: set[Path] = set()
    for resource_id in sorted(resources):
        target, missing = preflight_resource_target(
            base, RESOURCE_PATHS[resource_id])
        resource_targets[resource_id] = target
        required_directories.update(missing)
    created: list[Path] = []
    created_directories: list[Path] = []
    try:
        created_directories = ensure_resource_directories(required_directories)
        for resource_id in sorted(resources):
            target, _missing = preflight_resource_target(
                base, RESOURCE_PATHS[resource_id])
            require(target == resource_targets[resource_id],
                    "Resource target changed after preflight")
            write_new(target, resources[resource_id])
            created.append(target)
        write_new(document_target, document_bytes)
        created.append(document_target)
    except Exception:
        for path in reversed(created):
            try:
                path.unlink()
            except OSError:
                pass
        for directory in reversed(created_directories):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise
    return {
        "format": FORMAT_ID,
        "profile": PROFILE_ID,
        "transport": "json",
        "jsonForm": "ordinary" if ordinary else "canonical",
        "bytes": len(document_bytes),
        "sha256": hashlib.sha256(document_bytes).hexdigest(),
        "nodes": 11,
        "resources": len(resources),
        "codecs": 5,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Write the independent domformat@0 conformance scene")
    parser.add_argument("output", type=Path,
                        help="new .json path; its parent directory must exist")
    parser.add_argument("--ordinary", action="store_true",
                        help="emit safe noncanonical reader-form JSON")
    args = parser.parse_args(argv)
    try:
        summary = write_document(args.output, args.ordinary)
        print(json.dumps(summary, sort_keys=True, separators=(",", ":")))
        return 0
    except (OSError, ProducerError) as error:
        print(f"domformat-producer: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
