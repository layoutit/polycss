import { invariant } from "./errors.js";

const CSS_SCOPE = /^\[data-([a-z0-9-]{1,64})="([A-Za-z0-9._-]{1,64})"\]$/u;
const CSS_TOKEN = /^dom-asset:[a-z][a-z0-9._-]{0,63}$/u;
const IDENT_START = /[A-Za-z_-]/u;
const IDENT_CONTINUE = /[A-Za-z0-9_-]/u;
const PROPERTY = /^-?[A-Za-z][A-Za-z0-9-]*$/u;
const WHITESPACE = /[\t\n\f\r ]/u;
const UTF8 = new TextEncoder();

// polycss-3d@0 deliberately accepts only functions whose arguments cannot
// independently become a network request or invoke a host-provided worklet.
// URL is handled separately and accepts only a declared dom-asset token.
const SAFE_FUNCTIONS = new Set([
  "abs", "acos", "asin", "atan", "atan2",
  "blur", "brightness",
  "calc", "circle", "clamp", "color", "color-mix", "conic-gradient", "contrast", "cos", "counter", "counters", "cubic-bezier",
  "drop-shadow",
  "ellipse", "exp",
  "fit-content",
  "grayscale",
  "hsl", "hsla", "hwb", "hypot", "hue-rotate",
  "inset", "invert", "is",
  "lab", "lch", "light-dark", "linear-gradient", "log",
  "matrix", "matrix3d", "max", "min", "minmax", "mod",
  "not", "nth-child", "nth-last-child", "nth-last-of-type", "nth-of-type",
  "oklab", "oklch", "opacity",
  "path", "perspective", "polygon", "pow",
  "radial-gradient", "rem", "repeat", "repeating-conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "rgb", "rgba", "rotate", "rotate3d", "rotatex", "rotatey", "rotatez", "round",
  "saturate", "scale", "scale3d", "scalex", "scaley", "scalez", "sepia", "sign", "sin", "skew", "skewx", "skewy", "sqrt", "steps",
  "tan", "translate", "translate3d", "translatex", "translatey", "translatez",
  "url",
  "where",
]);
const SAFE_PROPERTIES = new Set([
  "-webkit-backface-visibility",
  "backface-visibility",
  "background", "background-clip", "background-color", "background-image", "background-position-x", "background-position-y", "background-repeat", "background-size",
  "border", "border-bottom-left-radius", "border-bottom-right-radius", "border-color", "border-shape", "border-top-left-radius", "border-top-right-radius",
  "box-sizing",
  "color", "contain", "content", "corner-bottom-left-shape", "corner-bottom-right-shape", "corner-top-left-shape", "corner-top-right-shape", "cursor",
  "display",
  "font", "font-style", "font-weight",
  "height",
  "image-rendering", "inset", "isolation",
  "left", "line-height",
  "margin", "max-width",
  "object-fit", "object-position", "opacity", "overflow",
  "padding", "pointer-events", "position",
  "text-decoration", "top", "touch-action", "transform", "transform-origin", "transform-style",
  "user-select",
  "visibility",
  "width", "will-change",
  "z-index",
]);

function isWhitespace(character) {
  return character !== undefined && WHITESPACE.test(character);
}

function trimRange(css, start, end) {
  while (start < end && isWhitespace(css[start])) start += 1;
  while (end > start && isWhitespace(css[end - 1])) end -= 1;
  return { start, end };
}

function assertAlphaCharacters(css) {
  invariant(!css.includes("\\"), "UNSAFE_CSS_ESCAPE", "Stylesheet escapes are forbidden by polycss-3d@0.");
  invariant(!css.includes("/*") && !css.includes("*/"), "UNSAFE_CSS_COMMENT", "Stylesheet comments are forbidden by polycss-3d@0.");
  invariant(!css.includes("@"), "UNSAFE_CSS", "Stylesheet at-rules are forbidden by polycss-3d@0.");
  invariant(!css.includes("<!--") && !css.includes("-->"), "UNSAFE_CSS", "Stylesheet CDO/CDC tokens are forbidden.");
  for (let index = 0; index < css.length; index += 1) {
    const code = css.charCodeAt(index);
    invariant(code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d, "UNSAFE_CSS_CONTROL", "Stylesheet contains a forbidden control character.");
  }
}

function splitTopLevel(css, start, end, delimiter, code, label) {
  const ranges = [];
  let itemStart = start;
  let quote = "";
  let round = 0;
  let square = 0;
  for (let index = start; index < end; index += 1) {
    const character = css[index];
    if (quote) {
      invariant(character !== "\n" && character !== "\r" && character !== "\f", code, `${label} contains a newline in a string.`);
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === delimiter && round === 0 && square === 0) {
      ranges.push(trimRange(css, itemStart, index));
      itemStart = index + 1;
    }
    invariant(round >= 0 && square >= 0, code, `${label} delimiters are unbalanced.`);
  }
  invariant(!quote && round === 0 && square === 0, code, `${label} is unterminated.`);
  ranges.push(trimRange(css, itemStart, end));
  return ranges;
}

function topLevelColon(css, start, end) {
  let quote = "";
  let round = 0;
  let square = 0;
  for (let index = start; index < end; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === ":" && round === 0 && square === 0) return index;
  }
  return -1;
}

function parseRules(css, limits) {
  const rules = [];
  let index = 0;
  while (index < css.length) {
    while (index < css.length && isWhitespace(css[index])) index += 1;
    if (index === css.length) break;
    const preludeStart = index;
    let quote = "";
    let round = 0;
    let square = 0;
    let open = -1;
    for (; index < css.length; index += 1) {
      const character = css[index];
      if (quote) {
        invariant(character !== "\n" && character !== "\r" && character !== "\f", "MALFORMED_CSS", "Selector contains a newline in a string.");
        if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'") quote = character;
      else if (character === "(") round += 1;
      else if (character === ")") round -= 1;
      else if (character === "[") square += 1;
      else if (character === "]") square -= 1;
      else if (character === "{" && round === 0 && square === 0) {
        open = index;
        break;
      } else if ((character === "}" || character === ";") && round === 0 && square === 0) {
        invariant(false, "MALFORMED_CSS", "Stylesheet contains text outside a qualified rule.");
      }
      invariant(round >= 0 && square >= 0, "MALFORMED_CSS", "Selector delimiters are unbalanced.");
    }
    invariant(open >= 0 && !quote && round === 0 && square === 0, "MALFORMED_CSS", "Stylesheet selector is unterminated.");
    const prelude = trimRange(css, preludeStart, open);
    invariant(prelude.start < prelude.end, "MALFORMED_CSS", "Stylesheet rule has an empty selector.");

    const bodyStart = open + 1;
    index = bodyStart;
    quote = "";
    round = 0;
    square = 0;
    let close = -1;
    for (; index < css.length; index += 1) {
      const character = css[index];
      if (quote) {
        invariant(character !== "\n" && character !== "\r" && character !== "\f", "MALFORMED_CSS", "Declaration contains a newline in a string.");
        if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'") quote = character;
      else if (character === "(") round += 1;
      else if (character === ")") round -= 1;
      else if (character === "[") square += 1;
      else if (character === "]") square -= 1;
      else if (character === "{") invariant(false, "UNSAFE_CSS_NESTING", "Nested CSS rules are forbidden by polycss-3d@0.");
      else if (character === "}" && round === 0 && square === 0) {
        close = index;
        break;
      }
      invariant(round >= 0 && square >= 0, "MALFORMED_CSS", "Declaration delimiters are unbalanced.");
    }
    invariant(close >= 0 && !quote && round === 0 && square === 0, "MALFORMED_CSS", "Stylesheet declaration block is unterminated.");
    rules.push({ preludeStart: prelude.start, preludeEnd: prelude.end, bodyStart, bodyEnd: close });
    invariant(rules.length <= limits.maxCssRules, "CSS_RULE_LIMIT", `Stylesheet exceeds ${limits.maxCssRules} rules.`);
    index = close + 1;
  }
  invariant(rules.length > 0, "MALFORMED_CSS", "Stylesheet must contain at least one rule.");
  return rules;
}

function assertScopedSelector(selector, scope) {
  invariant(selector.startsWith(scope), "CSS_SCOPE_ESCAPE", `Selector ${selector} escapes declared scope ${scope}.`);
  const remainder = selector.slice(scope.length);
  if (remainder === "") return;
  const first = remainder[0];
  invariant(isWhitespace(first) || first === ">" || first === "+" || first === "~" || first === "." || first === "#" || first === "[" || first === ":" || first === "|", "MALFORMED_CSS_SELECTOR", `Selector ${selector} has an invalid scoped compound.`);
  let quote = "";
  let round = 0;
  let square = 0;
  for (let index = 0; index < remainder.length; index += 1) {
    const character = remainder[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    if (round !== 0 || square !== 0) continue;
    if (character === "+" || character === "~" || (character === "|" && remainder[index + 1] === "|")) {
      invariant(false, "CSS_SCOPE_ESCAPE", `Selector ${selector} selects a sibling outside its declared scope.`);
    }
    if (character === ">") return;
    if (isWhitespace(character)) {
      while (index + 1 < remainder.length && isWhitespace(remainder[index + 1])) index += 1;
      const next = remainder[index + 1];
      invariant(next !== "+" && next !== "~" && !(next === "|" && remainder[index + 2] === "|"), "CSS_SCOPE_ESCAPE", `Selector ${selector} selects a sibling outside its declared scope.`);
      return;
    }
  }
}

function matchingParen(css, open, end) {
  let quote = "";
  let depth = 1;
  for (let index = open + 1; index < end; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  invariant(false, "MALFORMED_CSS", "Stylesheet function is unterminated.");
}

function urlToken(css, open, close) {
  const range = trimRange(css, open + 1, close);
  invariant(range.start < range.end, "UNBOUND_CSS_URL", "Stylesheet URL is empty.");
  let token;
  const quote = css[range.start];
  if (quote === "\"" || quote === "'") {
    invariant(css[range.end - 1] === quote && range.end - range.start >= 2, "MALFORMED_CSS", "Stylesheet URL string is unterminated.");
    token = css.slice(range.start + 1, range.end - 1);
  } else {
    token = css.slice(range.start, range.end);
    invariant(!/[\s"'()]/u.test(token), "MALFORMED_CSS", "Stylesheet URL token is malformed.");
  }
  invariant(!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(token) || token.startsWith("dom-asset:"), "UNSAFE_CSS", `Stylesheet URL ${token} may perform an external request.`);
  invariant(CSS_TOKEN.test(token), "UNBOUND_CSS_URL", `Stylesheet URL ${token} is not a logical asset token.`);
  return token;
}

function scanFunctions(css, start, end, state) {
  let quote = "";
  for (let index = start; index < end; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (!IDENT_START.test(character)) continue;
    let cursor = index + 1;
    while (cursor < end && IDENT_CONTINUE.test(css[cursor])) cursor += 1;
    if (css[cursor] !== "(") {
      index = cursor - 1;
      continue;
    }
    const name = css.slice(index, cursor).toLowerCase();
    invariant(SAFE_FUNCTIONS.has(name), "UNSAFE_CSS_FUNCTION", `Stylesheet function ${name}() is forbidden by polycss-3d@0.`);
    state.functions += 1;
    invariant(state.functions <= state.limits.maxCssFunctions, "CSS_FUNCTION_LIMIT", `Stylesheet exceeds ${state.limits.maxCssFunctions} functions.`);
    if (name === "url") {
      const close = matchingParen(css, cursor, end);
      const token = urlToken(css, cursor, close);
      state.urls.push({ start: index, end: close + 1, token });
      index = close;
    } else {
      index = cursor - 1;
    }
  }
}

export function cssScopeAttribute(scope) {
  const match = typeof scope === "string" ? CSS_SCOPE.exec(scope) : null;
  invariant(match, "INVALID_CSS_SCOPE", "Stylesheet scope must be a safe data-attribute selector.");
  return Object.freeze({ name: `data-${match[1]}`, value: match[2] });
}

export function analyzeCss(css, binding, limits) {
  assertAlphaCharacters(css);
  cssScopeAttribute(binding.scope);
  const rules = parseRules(css, limits);
  const state = { functions: 0, limits, urls: [], scopeSpans: [], selectors: 0, declarations: 0 };
  for (const rule of rules) {
    const selectors = splitTopLevel(css, rule.preludeStart, rule.preludeEnd, ",", "MALFORMED_CSS_SELECTOR", "Stylesheet selector list");
    for (const range of selectors) {
      invariant(range.start < range.end, "MALFORMED_CSS_SELECTOR", "Stylesheet selector list contains an empty selector.");
      const selector = css.slice(range.start, range.end);
      invariant(UTF8.encode(selector).length <= limits.maxCssSelectorBytes, "CSS_SELECTOR_LIMIT", `Stylesheet selector exceeds ${limits.maxCssSelectorBytes} bytes.`);
      assertScopedSelector(selector, binding.scope);
      state.scopeSpans.push({ start: range.start, end: range.start + binding.scope.length });
      state.selectors += 1;
      invariant(state.selectors <= limits.maxCssSelectors, "CSS_SELECTOR_LIMIT", `Stylesheet exceeds ${limits.maxCssSelectors} selectors.`);
      scanFunctions(css, range.start, range.end, state);
    }
    const declarations = splitTopLevel(css, rule.bodyStart, rule.bodyEnd, ";", "MALFORMED_CSS", "Stylesheet declaration list");
    for (const range of declarations) {
      if (range.start === range.end) continue;
      const colon = topLevelColon(css, range.start, range.end);
      invariant(colon > range.start, "MALFORMED_CSS", "Stylesheet declaration is missing a property/value separator.");
      const propertyRange = trimRange(css, range.start, colon);
      const valueRange = trimRange(css, colon + 1, range.end);
      const property = css.slice(propertyRange.start, propertyRange.end);
      invariant(PROPERTY.test(property) && !property.startsWith("--"), "UNSAFE_CSS_PROPERTY", `Stylesheet property ${property} is invalid or unsupported.`);
      const lower = property.toLowerCase();
      invariant(SAFE_PROPERTIES.has(lower), "UNSAFE_CSS_PROPERTY", `Stylesheet property ${property} is forbidden or outside polycss-3d@0.`);
      invariant(valueRange.start < valueRange.end, "MALFORMED_CSS", `Stylesheet property ${property} has an empty value.`);
      state.declarations += 1;
      invariant(state.declarations <= limits.maxCssDeclarations, "CSS_DECLARATION_LIMIT", `Stylesheet exceeds ${limits.maxCssDeclarations} declarations.`);
      scanFunctions(css, valueRange.start, valueRange.end, state);
    }
  }
  return Object.freeze({
    declarations: state.declarations,
    functions: state.functions,
    rules: rules.length,
    scopeSpans: Object.freeze(state.scopeSpans),
    selectors: state.selectors,
    urls: Object.freeze(state.urls),
  });
}

export function validateCssClosure(css, binding, resources, limits) {
  const analysis = analyzeCss(css, binding, limits);
  const tokenMap = new Map(binding.assetTokens.map((entry) => [entry.token, entry.resource]));
  const seen = new Set();
  for (const url of analysis.urls) {
    invariant(tokenMap.has(url.token), "UNBOUND_CSS_URL", `Stylesheet ${binding.id} URL ${url.token} is not declared.`);
    seen.add(url.token);
  }
  for (const [token, resource] of tokenMap) {
    invariant(resources.has(resource), "MISSING_CSS_ASSET", `CSS token ${token} references missing resource ${resource}.`);
    invariant(seen.has(token), "UNUSED_CSS_TOKEN", `CSS token ${token} is declared but absent from the stylesheet.`);
  }
  return analysis;
}

export function rewriteCss(css, binding, urls, options, limits) {
  const analysis = analyzeCss(css, binding, limits);
  const tokenMap = new Map(binding.assetTokens.map((entry) => [entry.token, entry.resource]));
  const scope = options?.scope ?? binding.scope;
  cssScopeAttribute(scope);
  const replacements = analysis.scopeSpans.map((span) => ({ ...span, value: scope }));
  for (const url of analysis.urls) {
    const resource = tokenMap.get(url.token);
    invariant(resource, "UNBOUND_CSS_URL", `Stylesheet URL ${url.token} is not declared.`);
    const resolved = urls.get(resource);
    invariant(typeof resolved === "string" && resolved.length > 0, "MISSING_RESOURCE_URL", `No resolved URL exists for CSS resource ${resource}.`);
    replacements.push({ start: url.start, end: url.end, value: `url(${JSON.stringify(resolved)})` });
  }
  replacements.sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let output = "";
  for (const replacement of replacements) {
    invariant(replacement.start >= cursor, "CSS_REWRITE_OVERLAP", "Stylesheet rewrite spans overlap.");
    output += css.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return output + css.slice(cursor);
}
