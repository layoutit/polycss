# @layoutit/polycss-domformat

`@layoutit/polycss-domformat` is PolyCSS's private, producer-neutral reference
implementation of the experimental `domformat@0` retained-DOM contract. It
stores one canonical UTF-8 JSON document plus integrity-bound sibling resource
files. There is no `.dom` packet, archive, gzip transport, embedded payload, or
alternate packaging mode.

The package is source-only ESM, has no runtime dependencies, and does not
depend on Morph or PolyCSS renderer internals. It is `private: true` and
MIT-licensed; it is tested and built in the workspace but excluded from public
versioning and publication.

## CLI

```sh
domformat encode manifest.json --output model.json
domformat inspect model.json --json
domformat validate model.json
domformat decode model.json --output decoded
```

`encode` writes every declared resource beneath the output document directory,
then publishes `model.json` last. Existing targets and symlinked path
components are rejected. `decode` writes the six semantic sections and verified
resources into a new directory.

## Node API

```js
import {
  buildDom,
  readDom,
  readDomFile,
  validateDocument,
  DomFormatError,
} from "@layoutit/polycss-domformat";
```

These are the complete Node exports. `buildDom` consumes the closed writer
manifest and returns canonical JSON bytes plus sibling-resource bytes keyed by
their relative paths. `readDom` validates supplied bytes and a logical-id
resource map. `readDomFile` loads and verifies paths relative to the JSON
document directory.

Producers must emit the writer manifest natively. Parsing, preparation,
lowering, source provenance, and product adapters remain in producer packages;
domformat contains no producer-specific or legacy conversion layer.

PolyCSS's first producer follows that boundary: website-owned tooling lowers
all 304 Gallery presets through shared preset, loader, camera, animation, and
renderer paths into canonical JSON plus digest-bound CSS and image siblings
under the website's public assets. The website catalog binds that corpus to its
exact Playwright Chromium strategy environment; it is not a browser-neutral
leaf-strategy claim. Neither that producer nor its generated corpus is shipped
in this package.

## Browser API

```js
import {
  readDomBrowser,
  readDomBrowserUrl,
  mountDom,
} from "@layoutit/polycss-domformat/browser";

const result = await readDomBrowserUrl("/models/example.json", { signal });
const runtime = await mountDom(result, host, { signal });
```

These are the complete browser exports. URL loading fetches the JSON document
and its digest-bound, document-relative, same-origin sibling files with
credentials omitted and redirects rejected. Direct byte loading requires a
logical-id `externalResources` map or a trusted `loadExternalResource` callback.

Mounting follows:

```text
validate → construct → bind → initialize → publish → destroy
```

Partial failures roll back DOM, style elements, listeners, observers, object
URLs, and host mutations. `destroy()` is idempotent. The runtime controller is
closed to `lifecycle`, `mode`, `sourceFrame`, `seek`, `setMode`, and `destroy`.

## Contract and security

The top-level JSON object has exactly six members: `meta`, `tree`,
`cssBinding`, `state`, `bindings`, and `resources`. Resource records declare a
safe relative `path`, exact byte length, SHA-256 digest, media type, and image
dimensions where applicable. Paths are case-portable and cannot alias or form
file/directory prefixes. Unknown fields and undeclared files fail closed.

The format excludes executable package code, generic expressions, arbitrary
network resources, custom interpreters, arbitrary HTML, ZIP/container formats,
compatibility aliases, and browser-generated identity. CSS is parsed against a
closed semantic subset, scoped to a viewer-owned instance, and rewritten only
for validated asset tokens.

The normative specifications, independent Python and JavaScript
implementations, fixtures, viewers, and certification tests remain
repository-side and are intentionally absent from the install tarball. See the
[domformat source directory](https://github.com/LayoutitStudio/polycss/tree/main/packages/domformat)
for that material.

## Release gate

From the PolyCSS workspace:

```sh
pnpm --filter @layoutit/polycss-domformat test:release
```

The gate runs Node tests, independent conformance corpora, real-browser mounts
and visual comparisons, exact tarball allowlisting, byte-identical packing,
clean-install API/CLI checks, and deterministic independent-producer checks.
