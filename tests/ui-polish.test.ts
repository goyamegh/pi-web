import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createContextMeter } from "../src/composer/contextMeter.js";
import type { AppElements } from "../src/app/elements.js";
import type { AppState } from "../src/app/types.js";

class MockElement {
  className = "";
  textContent = "";
  title = "";
  hidden = false;
  attributes = new Map<string, string>();
  style = { values: new Map<string, string>(), setProperty: (key: string, value: string) => this.style.values.set(key, value) };
  children: unknown[] = [];
  append(...nodes: unknown[]) { this.children.push(...nodes); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener() {}
}

globalThis.document = {
  createElement: () => new MockElement(),
  addEventListener: () => undefined,
} as unknown as Document;

function mockContextMeter(compacting: boolean) {
  const contextMeterEl = new MockElement();
  const contextMeterLabelEl = new MockElement();
  const contextMeterPopoverEl = new MockElement();
  const controller = createContextMeter({
    state: { isCompacting: compacting } as AppState,
    elements: {
      contextMeterEl,
      contextMeterLabelEl,
      contextMeterPopoverEl,
    } as unknown as AppElements,
  });
  return { controller, contextMeterEl, contextMeterLabelEl };
}

describe("context meter compaction polish", () => {
  it("shows a compacting label and class while compaction is running", () => {
    const { controller, contextMeterEl, contextMeterLabelEl } = mockContextMeter(true);

    controller.update({ contextUsage: { tokens: 82_000, contextWindow: 100_000 } });

    expect(contextMeterEl.className).toContain("compacting");
    expect(contextMeterEl.title).toBe("Compacting context…");
    expect(contextMeterEl.attributes.get("aria-label")).toBe("Compacting context…");
    expect(contextMeterLabelEl.textContent).toBe("compacting");
  });

  it("uses the normal ctx percentage label when not compacting", () => {
    const { controller, contextMeterEl, contextMeterLabelEl } = mockContextMeter(false);

    controller.update({ contextUsage: { tokens: 82_000, contextWindow: 100_000 } });

    expect(contextMeterEl.className).toBe("contextMeter warning");
    expect(contextMeterLabelEl.textContent).toBe("ctx 82%");
  });
});

describe("slash command compact styling", () => {
  const css = readFileSync(new URL("../src/styles/composer.css", import.meta.url), "utf8");

  it("keeps slash command rows compact", () => {
    expect(css).toContain("max-height: min(280px, 42vh)");
    expect(css).toContain("min-height: 30px");
    expect(css).toContain("padding: 5px 8px");
  });

  it("hides slash command descriptions until the active or hovered row", () => {
    expect(css).toContain(".slashCommandDescription {\n  display: none;");
    expect(css).toContain(".slashCommandItem.active .slashCommandDescription,\n.slashCommandItem:hover .slashCommandDescription { display: block; }");
  });

  it("animates the context meter while compacting with reduced-motion support", () => {
    expect(css).toContain(".contextMeter.compacting .contextMeterFill");
    expect(css).toContain("animation: contextMeterPulse 1.25s ease-in-out infinite");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
