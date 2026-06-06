import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { setIcon } from "../app/icons.js";
import { defaultPiWebSettings, normalizeMarkerColor, sessionMarkerColors, type AppState, type PiWebModelSetting, type PiWebSettings } from "../app/types.js";

export type SettingsController = {
  init: () => void;
  refreshSettings: () => Promise<void>;
  applySettings: (settings: PiWebSettings) => void;
};

function cloneSettings(settings: PiWebSettings): PiWebSettings {
  return JSON.parse(JSON.stringify(settings)) as PiWebSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSettings(value: unknown): PiWebSettings {
  const settings = cloneSettings(defaultPiWebSettings);
  if (!isRecord(value)) return settings;

  const appearance = isRecord(value.appearance) ? value.appearance : undefined;
  if (appearance?.density === "compact" || appearance?.density === "comfortable") settings.appearance.density = appearance.density;

  const composer = isRecord(value.composer) ? value.composer : undefined;
  if (composer?.queueMode === "steer" || composer?.queueMode === "followUp") settings.composer.queueMode = composer.queueMode;
  if (typeof composer?.expanded === "boolean") settings.composer.expanded = composer.expanded;

  const defaults = isRecord(value.defaults) ? value.defaults : undefined;
  const model = isRecord(defaults?.model) ? defaults.model : undefined;
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (provider && id) settings.defaults.model = { provider, id };
  if (typeof defaults?.thinkingLevel === "string" && defaults.thinkingLevel.trim()) settings.defaults.thinkingLevel = defaults.thinkingLevel.trim();
  const sessionBucketColor = normalizeMarkerColor(defaults?.sessionBucketColor);
  if (sessionBucketColor) settings.defaults.sessionBucketColor = sessionBucketColor;

  return settings;
}

function settingsLabel(settings: PiWebSettings) {
  const model = settings.defaults.model;
  if (!model && !settings.defaults.thinkingLevel) return "No default model saved";
  return [
    model ? `${model.provider}/${model.id}` : "Current pi default model",
    settings.defaults.thinkingLevel ? `reasoning ${settings.defaults.thinkingLevel}` : undefined,
  ].filter(Boolean).join(" · ");
}

function splitModelKey(key: string): PiWebModelSetting | undefined {
  const slashIndex = key.indexOf("/");
  if (slashIndex <= 0) return undefined;
  const provider = key.slice(0, slashIndex);
  const id = key.slice(slashIndex + 1);
  return provider && id ? { provider, id } : undefined;
}

function populateBucketColorSelect(select: HTMLSelectElement) {
  if (select.options.length > 0) return;
  select.append(new Option("No default bucket", ""));
  for (const color of sessionMarkerColors) select.append(new Option(color.label, color.id));
}

export function createSettings(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): SettingsController {
  const { state, elements, api, addMessage } = options;

  function updateQueueToggle() {
    const isSteer = state.queueMode === "steer";
    elements.queueToggle.setAttribute("aria-pressed", String(isSteer));
    elements.queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
    elements.queueToggle.setAttribute("aria-label", elements.queueToggle.title);
    setIcon(elements.queueToggle, isSteer ? "route" : "corner-down-right");
  }

  function updateExpandedComposer() {
    elements.formEl.classList.toggle("expanded", state.editorExpanded);
    setIcon(elements.expandButton, state.editorExpanded ? "minimize-2" : "maximize-2");
    elements.expandButton.title = state.editorExpanded ? "Collapse editor" : "Expand editor";
    elements.expandButton.setAttribute("aria-label", elements.expandButton.title);
  }

  function applySettings(rawSettings: PiWebSettings) {
    const settings = normalizeSettings(rawSettings);
    state.settings = settings;
    state.queueMode = settings.composer.queueMode;
    state.editorExpanded = settings.composer.expanded;

    document.documentElement.dataset.density = settings.appearance.density;
    elements.settingDensitySelect.value = settings.appearance.density;
    elements.settingQueueModeSelect.value = settings.composer.queueMode;
    elements.settingComposerExpandedCheckbox.checked = settings.composer.expanded;
    elements.settingDefaultBucketColorSelect.value = settings.defaults.sessionBucketColor || "";
    elements.settingModelDefaultsValue.textContent = settingsLabel(settings);

    updateQueueToggle();
    updateExpandedComposer();
  }

  function setSettingsStatus(message: string, isError = false) {
    elements.settingsStatusEl.textContent = message;
    elements.settingsStatusEl.classList.toggle("error", isError);
  }

  async function patchSettings(patch: unknown) {
    setSettingsStatus("Saving…");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: api.headers(),
      body: JSON.stringify(patch),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new Error(data.error || text);
    applySettings(data.settings);
    setSettingsStatus("Saved");
  }

  async function refreshSettings() {
    const res = await fetch("/api/settings", { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    applySettings(data.settings);
  }

  function openSettings() {
    elements.settingsBackdrop.hidden = false;
    elements.settingsPanel.hidden = false;
    setSettingsStatus("");
    elements.settingsCloseButton.focus();
  }

  function closeSettings() {
    elements.settingsPanel.hidden = true;
    elements.settingsBackdrop.hidden = true;
    elements.settingsButton.focus();
  }

  function init() {
    populateBucketColorSelect(elements.settingDefaultBucketColorSelect);
    applySettings(state.settings);

    elements.settingsButton.addEventListener("click", openSettings);
    elements.settingsCloseButton.addEventListener("click", closeSettings);
    elements.settingsBackdrop.addEventListener("click", closeSettings);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.settingsPanel.hidden) closeSettings();
    });

    elements.settingDensitySelect.addEventListener("change", () => {
      patchSettings({ appearance: { density: elements.settingDensitySelect.value } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingQueueModeSelect.addEventListener("change", () => {
      patchSettings({ composer: { queueMode: elements.settingQueueModeSelect.value } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingComposerExpandedCheckbox.addEventListener("change", () => {
      patchSettings({ composer: { expanded: elements.settingComposerExpandedCheckbox.checked } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingDefaultBucketColorSelect.addEventListener("change", () => {
      patchSettings({ defaults: { sessionBucketColor: elements.settingDefaultBucketColorSelect.value || null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingSaveModelDefaultsButton.addEventListener("click", () => {
      const model = splitModelKey(state.currentModelKey);
      if (!model) {
        setSettingsStatus("No current model to save", true);
        return;
      }
      patchSettings({ defaults: { model, thinkingLevel: state.currentThinkingLevel || null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });

    elements.settingClearModelDefaultsButton.addEventListener("click", () => {
      patchSettings({ defaults: { model: null, thinkingLevel: null } }).catch((error) => {
        setSettingsStatus(error instanceof Error ? error.message : String(error), true);
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      });
    });
  }

  return { init, refreshSettings, applySettings };
}
