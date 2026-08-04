# domformat@0 specification set

Status: experimental private-alpha contract. The `@0` identifiers are
deliberately unstable; incompatible changes are allowed until a later version
is declared stable.

The normative documents are:

- [`domformat-0.md`](./domformat-0.md): JSON transport, deterministic writer
  form, semantic sections, sibling resources, and resource integrity;
- [`polycss-3d-0.md`](./polycss-3d-0.md): retained XHTML construction plan,
  scoped CSS closure, prepared state channels, bindings, and DOM sinks;
- [`security.md`](./security.md): mandatory rejection rules and default resource
  limits;
- [`codecs/`](./codecs/): executable prepared-state codec/interpreter contracts.

The conformance corpus, independent Python producer and reader, and isolated
executable profile viewer are described in `conformance/README.md`.

`TREE`, `CSSB`, `STAT`, `BIND`, and logical `RCRD` identities express the
retained-DOM execution contract. The only physical form is a `.json` document
plus digest-bound external sibling resource files.

`domformat@0` permits data and fixed, trusted interpreters only. A package never
supplies JavaScript, WebAssembly, custom elements, event handlers,
package-declared network URLs, or a general expression language. Hosted sibling
files remain same-origin, document-relative, digest-bound closure resources. The
profile lifecycle is strictly `validate → construct → bind → initialize →
publish → destroy`.
