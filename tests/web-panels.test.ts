import { describe, expect, it } from "vitest";
import { CLOSE_PANEL_ACTION, normalizePanels } from "../src/extensions/webPanels.js";

describe("web panel descriptors (browser side)", () => {
  it("parses the chrome option: only \"none\" hides the host title bar; everything else keeps it", () => {
    const entries = normalizePanels([
      { key: "bare", title: "Bare", chrome: "none" },
      { key: "plain", title: "Plain" },
      { key: "explicit", title: "Explicit", chrome: "default" },
      { key: "junk", title: "Junk", chrome: "NONE" },
      { key: "junk2", title: "Junk 2", chrome: true },
      { key: "bare", title: "Duplicate key is dropped", chrome: "none" },
      null,
      { title: "no key" },
    ]);
    expect(entries.map((entry) => [entry.key, entry.chrome])).toEqual([
      ["bare", "none"], ["plain", "default"], ["explicit", "default"], ["junk", "default"], ["junk2", "default"],
    ]);
    expect(entries[0]).toEqual({ key: "bare", title: "Bare", label: "Bare", icon: "square-pen", chrome: "none" });
    expect(normalizePanels(undefined)).toEqual([]);
    expect(normalizePanels({ key: "not-an-array" })).toEqual([]);
  });

  it("reserves the close-panel action name the panel markup uses", () => {
    expect(CLOSE_PANEL_ACTION).toBe("close-panel");
  });
});
