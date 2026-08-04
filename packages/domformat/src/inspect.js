import { sha256Hex } from "./hash.js";

function stateDetails(channel) {
  const packet = channel.data?.packet;
  if (channel.codec === "polycss-effects-prepared@0" && packet) {
    return {
      frames: packet.frameCount,
      stars: packet.stars.length,
      emitters: packet.emitters.length,
      particles: packet.emitters.reduce((sum, emitter) => sum + emitter.poolSize, 0),
      spawnTuples: packet.spawnStream.count,
    };
  }
  if (channel.codec === "polycss-pointer-grab-prepared@0" && packet) {
    return {
      controls: packet.controls.length,
      grabControls: packet.controls.filter((control) => control.mode === "grab").length,
      eyeFollowControls: packet.controls.filter((control) => control.mode === "eye-follow").length,
      leafPlans: packet.leaves.length,
      sparseVertices: packet.controls.reduce((sum, control) => sum + control.closure.vertexRows.length / 4, 0),
      sparseWeights: packet.controls.reduce((sum, control) => sum + control.closure.weightScalars.length, 0),
      sparseLeafRows: packet.controls.reduce((sum, control) => sum + control.closure.leafRows.length / 4, 0),
    };
  }
  if (channel.codec === "polycss-playback-packed@0" && packet) {
    return {
      frames: packet.frameRows.length,
      shapes: packet.shapeCount,
      leaves: packet.leafCount,
      transforms: packet.transforms.count,
    };
  }
  return undefined;
}

function targetCount(value) {
  if (typeof value === "string") return value === "$host" ? 0 : 1;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + targetCount(entry), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, entry) => sum + targetCount(entry), 0);
  return 0;
}

export function inspection(result) {
  const { document, externalMissing = [] } = result;
  const { transport } = result;
  const nodes = document.tree.nodes;
  const tags = Object.fromEntries([...new Set(nodes.map((node) => node.name))].sort().map((tag) => [tag, nodes.filter((node) => node.name === tag).length]));
  const resources = document.resources.resources.map((record) => ({
    id: record.id,
    kind: record.kind,
    mediaType: record.mediaType,
    bytes: record.byteLength,
    dimensions: record.dimensions,
    digest: record.digest.value,
    path: record.path,
    verified: !externalMissing.includes(record.id),
  }));
  return {
    format: document.meta.format,
    profile: document.meta.profile,
    title: document.meta.title,
    fileBytes: transport.totalLength,
    fileSha256: sha256Hex(transport.bytes),
    transport: {
      encoding: transport.encoding,
      decodedBytes: transport.decodedLength,
    },
    tree: {
      nodes: nodes.length,
      roots: nodes.filter((node) => node.parent === -1).length,
      tags,
      stableIds: nodes.length,
    },
    state: {
      channels: document.state.channels.map((channel) => ({
        id: channel.id,
        codec: channel.codec,
        ...(stateDetails(channel) ? { details: stateDetails(channel) } : {}),
      })),
    },
    bindings: document.bindings.channels.map(({ id, interpreter, status, inputs, targets, sinks, parameters }) => ({
      id,
      interpreter,
      status,
      inputs,
      targetCount: targetCount(targets),
      sinks,
      ...(parameters ? { parameters } : {}),
    })),
    resources,
    allResourcesVerified: externalMissing.length === 0,
  };
}

export function formatInspection(value) {
  const lines = [
    `${value.format} / ${value.profile}`,
    `${value.title}`,
    `${value.fileBytes.toLocaleString("en-US")} bytes, sha256 ${value.fileSha256}`,
    `${value.tree.nodes.toLocaleString("en-US")} stable nodes; tags ${Object.entries(value.tree.tags).map(([tag, count]) => `${tag}:${count}`).join(", ")}`,
    `transport: ${value.transport.encoding} ${value.fileBytes} bytes`,
    `state: ${value.state.channels.map((channel) => `${channel.id}=${channel.codec}${channel.details ? ` ${JSON.stringify(channel.details)}` : ""}`).join(", ")}`,
    `bindings: ${value.bindings.map((binding) => `${binding.id}=${binding.interpreter}/${binding.status} targets:${binding.targetCount}`).join(", ")}`,
    `resources: ${value.resources.length} (${value.allResourcesVerified ? "all verified" : "external bytes not loaded"})`,
  ];
  return `${lines.join("\n")}\n`;
}
