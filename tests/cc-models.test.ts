import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Model discovery for the Claude Code adapter.
 *
 * CC declares its selectable models in `availableModels` within its own
 * settings hierarchy. pi-web previously hardcoded a three-entry list, so a user
 * whose ~/.claude/settings.json declared 14 models saw only 3 in the picker and
 * could never select Opus 5 / Sonnet 5 / Fable 5 at all. These tests pin the
 * discovery behaviour and the initial-model validation that goes with it.
 */

const { resolveCCModels, pickInitialCCModel } = await import("../server/agent/claude-code/models.js");

let originalHome: string | undefined;
let originalUseBedrock: string | undefined;
let homeDir = "";
let projectDir = "";

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  homeDir = await mkdtemp(join(tmpdir(), "pi-web-cc-models-home-"));
  projectDir = await mkdtemp(join(tmpdir(), "pi-web-cc-models-proj-"));
  process.env.HOME = homeDir;
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUseBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalUseBedrock;
  await rm(homeDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function writeSettings(dir: string, body: unknown, file = "settings.json") {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude", file), JSON.stringify(body), "utf-8");
}

describe("resolveCCModels — discovery from CC settings", () => {
  it("returns every model CC declares in availableModels, not a hardcoded subset", async () => {
    // The user's real-world config: 14 declared models with enforcement on.
    await writeSettings(homeDir, {
      availableModels: [
        "claude-opus-4-6[1m]", "claude-opus-4-6",
        "claude-opus-4-7[1m]", "claude-opus-4-7",
        "claude-opus-4-8[1m]", "claude-opus-4-8",
        "claude-opus-5[1m]", "claude-opus-5",
        "claude-sonnet-4-6", "claude-sonnet-4-6[1m]",
        "claude-sonnet-5", "claude-fable-5", "claude-fable-5[1m]",
        "claude-haiku-4-5",
      ],
      enforceAvailableModels: true,
    });

    const models = resolveCCModels(projectDir);
    expect(models).toHaveLength(14);

    const ids = models.map((m) => m.id);
    // The models that were previously unreachable from the picker entirely.
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("claude-fable-5");
  });

  it("passes aliases through verbatim so CC can apply its own modelOverrides", async () => {
    await writeSettings(homeDir, {
      availableModels: ["claude-opus-4-8"],
      modelOverrides: { "claude-opus-4-8": "global.anthropic.claude-opus-4-8" },
    });

    // pi-web must NOT substitute the override target: the CLI resolves the
    // alias itself, and forwarding the resolved id would bypass enforcement.
    expect(resolveCCModels(projectDir).map((m) => m.id)).toEqual(["claude-opus-4-8"]);
  });

  it("marks [1m] aliases as 1M-token context so the context meter is accurate", async () => {
    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8[1m]", "claude-opus-4-8"] });

    const [oneMillion, standard] = resolveCCModels(projectDir);
    expect(oneMillion.contextWindow).toBe(1_000_000);
    expect(standard.contextWindow).toBe(200_000);
  });

  it("derives human-readable names, including for region-prefixed and date-stamped ids", async () => {
    await writeSettings(homeDir, {
      availableModels: [
        "claude-opus-4-8",
        "claude-opus-4-8[1m]",
        "us.anthropic.claude-sonnet-4-5",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
      ],
    });

    expect(resolveCCModels(projectDir).map((m) => m.name)).toEqual([
      "Claude Opus 4.8",
      "Claude Opus 4.8 (1M)",
      "Claude Sonnet 4.5",
      // The date stamp is dropped rather than rendered as "4.5.20251001".
      "Claude Haiku 4.5",
    ]);
  });

  it("tags models with the provider matching CC's runtime so settings round-trip", async () => {
    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8"] });
    expect(resolveCCModels(projectDir)[0].provider).toBe("amazon-bedrock");

    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    expect(resolveCCModels(projectDir)[0].provider).toBe("anthropic");
  });

  it("lets a project-level allowlist replace the user-level one", async () => {
    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8", "claude-sonnet-5"] });
    await writeSettings(projectDir, { availableModels: ["claude-haiku-4-5"] });

    expect(resolveCCModels(projectDir).map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
  });

  it("de-duplicates repeated aliases", async () => {
    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8", "claude-opus-4-8"] });
    expect(resolveCCModels(projectDir)).toHaveLength(1);
  });

  it("falls back to built-in models when no settings file declares availableModels", () => {
    const models = resolveCCModels(projectDir);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "amazon-bedrock")).toBe(true);
  });

  it("falls back rather than throwing when a settings file is malformed", async () => {
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "settings.json"), "{ not valid json", "utf-8");

    expect(() => resolveCCModels(projectDir)).not.toThrow();
    expect(resolveCCModels(projectDir).length).toBeGreaterThan(0);
  });

  it("ignores a present-but-empty availableModels list", async () => {
    await writeSettings(homeDir, { availableModels: [] });
    // An empty allowlist would otherwise leave the picker with zero options.
    expect(resolveCCModels(projectDir).length).toBeGreaterThan(0);
  });

  it("re-reads settings on each call so edits appear without a restart", async () => {
    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8"] });
    expect(resolveCCModels(projectDir)).toHaveLength(1);

    await writeSettings(homeDir, { availableModels: ["claude-opus-4-8", "claude-opus-5"] });
    expect(resolveCCModels(projectDir)).toHaveLength(2);
  });
});

describe("pickInitialCCModel — validating the persisted default", () => {
  const available = [
    { provider: "amazon-bedrock", id: "claude-opus-4-8" },
    { provider: "amazon-bedrock", id: "claude-sonnet-5" },
  ];

  it("honours a requested model that CC actually offers", () => {
    const picked = pickInitialCCModel({ provider: "amazon-bedrock", id: "claude-sonnet-5" }, available);
    expect(picked.id).toBe("claude-sonnet-5");
  });

  it("discards a requested model CC does not offer", () => {
    // Regression: pi-web persists defaults.model globally, including picks made
    // in a pi session. An unavailable id previously became the active model and
    // was forwarded to `--model`, showing as selected despite never appearing
    // in the picker.
    const picked = pickInitialCCModel(
      { provider: "amazon-bedrock", id: "us.anthropic.claude-fable-5" },
      available,
    );
    expect(picked.id).toBe("claude-opus-4-8");
  });

  it("discards a requested model whose provider does not match", () => {
    const picked = pickInitialCCModel({ provider: "anthropic", id: "claude-opus-4-8" }, available);
    expect(picked.id).toBe("claude-opus-4-8");
    expect(picked.provider).toBe("amazon-bedrock");
  });

  it("defaults to the first available model when nothing is requested", () => {
    expect(pickInitialCCModel(undefined, available).id).toBe("claude-opus-4-8");
  });
});
