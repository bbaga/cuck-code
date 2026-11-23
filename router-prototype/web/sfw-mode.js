(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.sfwMode = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const STORAGE_KEY = "cuck.sfw";

  function readEnabled(storage) {
    if (!storage) return false;
    try {
      return storage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeEnabled(storage, enabled) {
    if (!storage) return;
    try {
      if (enabled) storage.setItem(STORAGE_KEY, "1");
      else storage.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be full or blocked. The mode stays on for this page only.
    }
  }

  function brandText(text, enabled) {
    if (!enabled) return text;
    return String(text)
      .replace(/cuck/g, "duck")
      .replace(/Cuck/g, "Duck")
      .replace(/CUCK/g, "DUCK");
  }

  function logoHref(enabled) {
    return enabled ? "/favicon-duck.svg" : "/favicon.svg";
  }

  function apply(doc, enabled) {
    // The first call keeps the original title so a later "off" call restores it.
    const root = doc.documentElement;
    if (root.dataset.brandTitle === undefined) root.dataset.brandTitle = doc.title;
    doc.title = brandText(root.dataset.brandTitle, enabled);

    for (const el of doc.querySelectorAll("[data-brand]")) {
      if (el.dataset.brandOriginal === undefined) {
        el.dataset.brandOriginal = el.textContent;
      }
      el.textContent = brandText(el.dataset.brandOriginal, enabled);
    }
    for (const link of doc.querySelectorAll('link[rel="icon"]')) {
      link.href = logoHref(enabled);
    }
    for (const img of doc.querySelectorAll("img[data-brand-logo]")) {
      img.setAttribute("src", logoHref(enabled));
    }
    root.dataset.sfw = enabled ? "1" : "0";
  }

  function mountToggle(doc, container, storage, win) {
    const label = doc.createElement("label");
    label.className = "sfwToggle";
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.id = "sfwToggle";
    label.appendChild(input);
    label.appendChild(doc.createTextNode(" Safe for work"));
    container.appendChild(label);

    input.checked = readEnabled(storage);
    apply(doc, input.checked);

    input.addEventListener("change", () => {
      writeEnabled(storage, input.checked);
      apply(doc, input.checked);
    });

    if (win) {
      win.addEventListener("storage", (event) => {
        if (event.key !== STORAGE_KEY) return;
        input.checked = readEnabled(storage);
        apply(doc, input.checked);
      });
    }

    return input;
  }

  return { STORAGE_KEY, readEnabled, writeEnabled, brandText, logoHref, apply, mountToggle };
});
