"use strict";

// Unit tests for the safe-for-work (SFW) mode module. The tests use a fake
// storage object, a fake document object, and a fake window object. No browser
// is used. Unit scope only.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const sfwMode = require("../web/sfw-mode.js");

const { STORAGE_KEY, readEnabled, writeEnabled, brandText, logoHref, apply, mountToggle } = sfwMode;

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function throwingStorage() {
  return {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
    removeItem() { throw new Error("storage blocked"); },
  };
}

function fakeElement(tagName) {
  return {
    tagName,
    attributes: {},
    dataset: {},
    textContent: "",
    children: [],
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, listener) {
      (this.listeners[type] = this.listeners[type] || []).push(listener);
    },
    dispatch(type, event) {
      for (const listener of this.listeners[type] || []) listener(event);
    },
  };
}

function fakeDoc() {
  const brandSpan = fakeElement("span");
  brandSpan.textContent = "cuck-code router";
  const brandH1 = fakeElement("h1");
  brandH1.textContent = "cuck-code";
  const icon = fakeElement("link");
  icon.attributes.rel = "icon";
  icon.href = "/favicon.svg";
  const logo = fakeElement("img");
  logo.attributes.src = "/favicon.svg";
  const doc = {
    title: "Pipelines - cuck-code router",
    documentElement: { dataset: {} },
    brands: [brandSpan, brandH1],
    icon,
    logo,
    created: [],
    createElement(tagName) {
      const el = fakeElement(tagName);
      this.created.push(el);
      return el;
    },
    createTextNode(text) { return { text }; },
    querySelectorAll(selector) {
      if (selector === "[data-brand]") return this.brands;
      if (selector === 'link[rel="icon"]') return [this.icon];
      if (selector === "img[data-brand-logo]") return [this.logo];
      return [];
    },
  };
  return doc;
}

function fakeWin() {
  return {
    listeners: {},
    addEventListener(type, listener) {
      (this.listeners[type] = this.listeners[type] || []).push(listener);
    },
    dispatch(type, event) {
      for (const listener of this.listeners[type] || []) listener(event);
    },
  };
}

test("STORAGE_KEY is cuck.sfw", () => {
  assert.equal(STORAGE_KEY, "cuck.sfw");
});

test("readEnabled returns true only for the stored value 1", () => {
  assert.equal(readEnabled(fakeStorage({ "cuck.sfw": "1" })), true);
  assert.equal(readEnabled(fakeStorage({ "cuck.sfw": "0" })), false);
  assert.equal(readEnabled(fakeStorage()), false);
  assert.equal(readEnabled(null), false);
  assert.equal(readEnabled(throwingStorage()), false);
});

test("writeEnabled sets 1 when enabled and removes the key when disabled", () => {
  const on = fakeStorage();
  writeEnabled(on, true);
  assert.equal(on.map.get("cuck.sfw"), "1");

  const off = fakeStorage({ "cuck.sfw": "1" });
  writeEnabled(off, false);
  assert.equal(off.map.has("cuck.sfw"), false);

  writeEnabled(null, true);
  writeEnabled(null, false);

  const blocked = throwingStorage();
  assert.doesNotThrow(() => writeEnabled(blocked, true));
  assert.doesNotThrow(() => writeEnabled(blocked, false));
});

test("brandText replaces each spelling of cuck when enabled", () => {
  assert.equal(brandText("cuck-code router", true), "duck-code router");
  assert.equal(brandText("Pipelines - cuck-code router", true), "Pipelines - duck-code router");
  assert.equal(brandText("Cuck", true), "Duck");
  assert.equal(brandText("CUCK", true), "DUCK");
});

test("brandText returns the text unchanged when disabled", () => {
  assert.equal(brandText("cuck-code router", false), "cuck-code router");
  assert.equal(brandText("Pipelines - cuck-code router", false), "Pipelines - cuck-code router");
  assert.equal(brandText("Cuck", false), "Cuck");
  assert.equal(brandText("CUCK", false), "CUCK");
});

test("logoHref points at the duck icon only when enabled", () => {
  assert.equal(logoHref(true), "/favicon-duck.svg");
  assert.equal(logoHref(false), "/favicon.svg");
});

test("apply brands the page when enabled and restores it exactly when disabled", () => {
  const doc = fakeDoc();
  const originalTitle = doc.title;
  const originalTexts = doc.brands.map((el) => el.textContent);

  apply(doc, true);
  assert.equal(doc.title, "Pipelines - duck-code router");
  assert.equal(doc.documentElement.dataset.brandTitle, originalTitle);
  assert.equal(doc.documentElement.dataset.sfw, "1");
  assert.equal(doc.brands[0].textContent, "duck-code router");
  assert.equal(doc.brands[1].textContent, "duck-code");
  assert.equal(doc.brands[0].dataset.brandOriginal, originalTexts[0]);
  assert.equal(doc.brands[1].dataset.brandOriginal, originalTexts[1]);
  assert.equal(doc.icon.href, "/favicon-duck.svg");
  assert.equal(doc.logo.getAttribute("src"), "/favicon-duck.svg");

  apply(doc, false);
  assert.equal(doc.title, originalTitle);
  assert.equal(doc.documentElement.dataset.sfw, "0");
  assert.equal(doc.brands[0].textContent, originalTexts[0]);
  assert.equal(doc.brands[1].textContent, originalTexts[1]);
  assert.equal(doc.icon.href, "/favicon.svg");
  assert.equal(doc.logo.getAttribute("src"), "/favicon.svg");
});

test("apply keeps working when the same document is switched on and off again", () => {
  const doc = fakeDoc();
  apply(doc, true);
  apply(doc, false);
  apply(doc, true);
  assert.equal(doc.title, "Pipelines - duck-code router");
  assert.equal(doc.brands[0].textContent, "duck-code router");
  apply(doc, false);
  assert.equal(doc.title, "Pipelines - cuck-code router");
  assert.equal(doc.brands[0].textContent, "cuck-code router");
});

test("mountToggle sets the checkbox from storage and applies the mode once", () => {
  const doc = fakeDoc();
  const container = fakeElement("div");
  const input = mountToggle(doc, container, fakeStorage({ "cuck.sfw": "1" }), null);
  assert.equal(input.checked, true);
  assert.equal(doc.title, "Pipelines - duck-code router");
  assert.equal(doc.documentElement.dataset.sfw, "1");

  const docOff = fakeDoc();
  const inputOff = mountToggle(docOff, fakeElement("div"), fakeStorage(), null);
  assert.equal(inputOff.checked, false);
  assert.equal(docOff.title, "Pipelines - cuck-code router");
  assert.equal(docOff.documentElement.dataset.sfw, "0");
});

test("mountToggle appends a label with the input and the text", () => {
  const doc = fakeDoc();
  const container = fakeElement("div");
  const input = mountToggle(doc, container, fakeStorage(), null);
  const label = container.children[0];
  assert.equal(label.tagName, "label");
  assert.equal(label.className, "sfwToggle");
  assert.equal(label.children[0], input);
  assert.equal(input.type, "checkbox");
  assert.equal(input.id, "sfwToggle");
  assert.equal(label.children[1].text, " Safe for work");
  assert.equal(doc.created[0].tagName, "label");
  assert.equal(input, doc.created[1]);
});

test("mountToggle writes storage and applies the mode on change", () => {
  const doc = fakeDoc();
  const storage = fakeStorage();
  const input = mountToggle(doc, fakeElement("div"), storage, null);

  input.checked = true;
  input.dispatch("change");
  assert.equal(storage.map.get("cuck.sfw"), "1");
  assert.equal(doc.title, "Pipelines - duck-code router");

  input.checked = false;
  input.dispatch("change");
  assert.equal(storage.map.has("cuck.sfw"), false);
  assert.equal(doc.title, "Pipelines - cuck-code router");
});

test("mountToggle follows a storage event from another tab", () => {
  const doc = fakeDoc();
  const storage = fakeStorage();
  const win = fakeWin();
  const input = mountToggle(doc, fakeElement("div"), storage, win);
  assert.equal(input.checked, false);

  storage.map.set("cuck.sfw", "1");
  win.dispatch("storage", { key: STORAGE_KEY });
  assert.equal(input.checked, true);
  assert.equal(doc.title, "Pipelines - duck-code router");

  storage.map.delete("cuck.sfw");
  win.dispatch("storage", { key: STORAGE_KEY });
  assert.equal(input.checked, false);
  assert.equal(doc.title, "Pipelines - cuck-code router");
});

test("mountToggle ignores a storage event for another key", () => {
  const doc = fakeDoc();
  const storage = fakeStorage();
  const win = fakeWin();
  const input = mountToggle(doc, fakeElement("div"), storage, win);
  storage.map.set("cuck.sfw", "1");
  win.dispatch("storage", { key: "other.key" });
  assert.equal(input.checked, false);
});