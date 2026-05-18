import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PiWebModelSetting = {
  provider: string;
  id: string;
};

export type PiWebSettings = {
  version: 1;
  appearance: {
    density: "comfortable" | "compact";
    navPinned: boolean;
  };
  composer: {
    queueMode: "steer" | "followUp";
    expanded: boolean;
  };
  defaults: {
    model?: PiWebModelSetting;
    thinkingLevel?: string;
  };
};

export type PiWebSettingsPatch = Partial<{
  appearance: Partial<{
    density: unknown;
    navPinned: unknown;
  }>;
  composer: Partial<{
    queueMode: unknown;
    expanded: unknown;
  }>;
  defaults: Partial<{
    model: unknown;
    thinkingLevel: unknown;
  }>;
}>;

export const defaultPiWebSettings: PiWebSettings = {
  version: 1,
  appearance: {
    density: "comfortable",
    navPinned: false,
  },
  composer: {
    queueMode: "steer",
    expanded: false,
  },
  defaults: {
    model: { provider: "amazon-bedrock", id: "us.anthropic.claude-opus-4-7" },
    thinkingLevel: "high",
  },
};

function cloneSettings(value: PiWebSettings): PiWebSettings {
  return JSON.parse(JSON.stringify(value)) as PiWebSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModel(value: unknown) {
  if (!isRecord(value)) return undefined;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return provider && id ? { provider, id } : undefined;
}

export function normalizeSettings(value: unknown): PiWebSettings {
  const settings = cloneSettings(defaultPiWebSettings);
  if (!isRecord(value)) return settings;

  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  if (appearance?.density === "compact" || appearance?.density === "comfortable") {
    settings.appearance.density = appearance.density;
  }
  if (typeof appearance?.navPinned === "boolean") settings.appearance.navPinned = appearance.navPinned;

  const composer = isRecord(value.composer) ? value.composer : undefined;
  if (composer?.queueMode === "followUp" || composer?.queueMode === "steer") {
    settings.composer.queueMode = composer.queueMode;
  }
  if (typeof composer?.expanded === "boolean") settings.composer.expanded = composer.expanded;

  const defaults = isRecord(value.defaults) ? value.defaults : undefined;
  const model = normalizeModel(defaults?.model);
  if (model) settings.defaults.model = model;
  if (typeof defaults?.thinkingLevel === "string" && defaults.thinkingLevel.trim()) {
    settings.defaults.thinkingLevel = defaults.thinkingLevel.trim();
  }

  return settings;
}

export function applySettingsPatch(current: PiWebSettings, patch: unknown): PiWebSettings {
  if (!isRecord(patch)) return cloneSettings(current);
  const next = cloneSettings(current);

  if (isRecord(patch.appearance)) {
    if (patch.appearance.density === "comfortable" || patch.appearance.density === "compact") {
      next.appearance.density = patch.appearance.density;
    }
    if (typeof patch.appearance.navPinned === "boolean") next.appearance.navPinned = patch.appearance.navPinned;
  }

  if (isRecord(patch.composer)) {
    if (patch.composer.queueMode === "steer" || patch.composer.queueMode === "followUp") {
      next.composer.queueMode = patch.composer.queueMode;
    }
    if (typeof patch.composer.expanded === "boolean") next.composer.expanded = patch.composer.expanded;
  }

  if (isRecord(patch.defaults)) {
    if ("model" in patch.defaults) {
      const model = normalizeModel(patch.defaults.model);
      if (model) next.defaults.model = model;
      else delete next.defaults.model;
    }
    if ("thinkingLevel" in patch.defaults) {
      if (typeof patch.defaults.thinkingLevel === "string" && patch.defaults.thinkingLevel.trim()) {
        next.defaults.thinkingLevel = patch.defaults.thinkingLevel.trim();
      } else {
        delete next.defaults.thinkingLevel;
      }
    }
  }

  return normalizeSettings(next);
}

export function createSettingsStore(file: string) {
  let cached: PiWebSettings | undefined;

  async function read() {
    if (cached) return cloneSettings(cached);
    try {
      cached = normalizeSettings(JSON.parse(await readFile(file, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not read pi-web settings at ${file}:`, error);
      }
      cached = cloneSettings(defaultPiWebSettings);
    }
    return cloneSettings(cached);
  }

  async function write(settings: PiWebSettings) {
    cached = normalizeSettings(settings);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cached, null, 2)}\n`, "utf-8");
    await rename(tmp, file);
    return cloneSettings(cached);
  }

  async function patch(value: unknown) {
    return write(applySettingsPatch(await read(), value));
  }

  return { file, read, write, patch };
}
