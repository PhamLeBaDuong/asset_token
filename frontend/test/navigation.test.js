import { test } from "node:test";
import assert from "node:assert/strict";
import { mountNavigation } from "../src/navigation.js";

test("navigation handles deep links, clicks, and back navigation without changing form state", () => {
  const panels = ["wallet", "assets", "funding", "transfers", "activity", "metadata"].map((page) => ({ dataset: { page }, hidden: false }));
  const links = panels.map(({ dataset }) => ({
    dataset: { pageLink: dataset.page }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { this[type] = handler; }
  }));
  const events = {}, form = { value: "unsaved campaign details" };
  const window = { location: { hash: "#funding" }, addEventListener(type, handler) { events[type] = handler; } };
  const document = { querySelectorAll: (selector) => selector === "[data-page]" ? panels : links };
  const nav = mountNavigation({ document, window });
  assert.deepEqual(panels.filter((panel) => !panel.hidden).map((panel) => panel.dataset.page), ["funding"]);
  assert.equal(links[2].attributes["aria-current"], "page");
  links[1].click({ preventDefault() {} });
  assert.equal(panels[1].hidden, false);
  assert.equal(panels[2].hidden, true);
  assert.equal(form.value, "unsaved campaign details");
  window.location.hash = "#funding";
  events.hashchange();
  assert.equal(panels[2].hidden, false);
  nav.navigate("unknown");
  assert.equal(panels[0].hidden, false);
  assert.equal(panels.filter((panel) => !panel.hidden).length, 1);
});
