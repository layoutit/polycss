export class FakeElement {
  constructor(ownerDocument, name = "div", namespaceURI = "http://www.w3.org/1999/xhtml") {
    this.ownerDocument = ownerDocument;
    this.localName = name;
    this.namespaceURI = namespaceURI;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    const styleTarget = {};
    this.style = new Proxy(styleTarget, {
      set: (target, property, value) => {
        target[property] = value;
        ownerDocument?.writes?.push(Object.freeze({ element: this, property: String(property), value: String(value) }));
        return true;
      },
    });
    this.dataset = {};
    this.classes = [];
    this.classList = { add: (...tokens) => { this.classes.push(...tokens); } };
    this.listeners = new Map();
    this.clientWidth = 320;
    this.clientHeight = 240;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const child of children) this.appendChild(child);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { this.listeners.set(`${name}:${this.listeners.size}`, listener); }
  removeEventListener(name, listener) {
    for (const [key, value] of this.listeners) if (key.startsWith(`${name}:`) && value === listener) this.listeners.delete(key);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  closest() { return null; }
  focus(options) { this.focusOptions = options; }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
}

export function fakeBrowserDocument() {
  const urls = { created: [], revoked: [] };
  const observers = [];
  const bitmaps = [];
  const namespaced = [];
  const writes = [];
  const raf = new Map();
  let rafSequence = 1;
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(value) { this.observed.push(value); }
    disconnect() { this.disconnected = true; }
  }
  const windowListeners = new Map();
  const win = {
    Blob,
    URL: {
      createObjectURL() {
        const value = `blob:fake-${urls.created.length}`;
        urls.created.push(value);
        return value;
      },
      revokeObjectURL(value) { urls.revoked.push(value); },
    },
    performance: { now: () => 1 },
    Element: FakeElement,
    HTMLInputElement: class extends FakeElement {},
    HTMLTextAreaElement: class extends FakeElement {},
    HTMLSelectElement: class extends FakeElement {},
    ResizeObserver: FakeResizeObserver,
    async createImageBitmap() {
      const bitmap = { width: 2, height: 2, closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap);
      return bitmap;
    },
    requestAnimationFrame(callback) {
      const id = rafSequence++;
      raf.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { raf.delete(id); },
    listeners: windowListeners,
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, new Set());
      windowListeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { windowListeners.get(name)?.delete(listener); },
  };
  const document = {
    defaultView: win,
    writes,
    createElement(name) { return new FakeElement(document, name); },
    createElementNS(namespace, name) {
      const element = new FakeElement(document, name, namespace);
      namespaced.push(element);
      return element;
    },
  };
  document.head = new FakeElement(document, "head");
  const frame = (timestamp) => {
    const callbacks = [...raf.values()];
    raf.clear();
    for (const callback of callbacks) callback(timestamp);
    return callbacks.length;
  };
  return { document, win, urls, observers, bitmaps, namespaced, writes, raf, frame };
}

export function dispatch(element, name, values = {}) {
  let prevented = false;
  const event = {
    target: element,
    isPrimary: true,
    preventDefault() { prevented = true; },
    ...values,
  };
  for (const [key, listener] of element.listeners) if (key.startsWith(`${name}:`)) listener(event);
  return Object.freeze({ event, get prevented() { return prevented; } });
}
