import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { iconElement } from "../app/icons.js";
import type { AppState } from "../app/types.js";

export type ModelSettings = {
  init: () => void;
  updateSummary: () => void;
  updateThinkingOptions: (levels?: string[]) => void;
  populateModelSelect: (models: any[], activeKey: string) => void;
  refreshModels: () => Promise<void>;
};

export function modelKey(model: any): string {
  return model ? `${model.provider}/${model.id}` : "";
}

export function modelLabel(model: any): string {
  const name = model?.name && model.name !== model.id ? ` (${model.name})` : "";
  return `${model.provider}/${model.id}${name}`;
}

export function createModelSettings(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  updateMeta: (data: any) => void;
  addMessage: (role: "system", text: string, extraClass?: string) => void;
}): ModelSettings {
  const { state, elements, api, updateMeta, addMessage } = options;

  function updateSummary() {
    const level = elements.thinkingSelectEl.value || state.currentThinkingLevel || "off";
    const modelText = state.currentModelDisplay || state.currentModelKey || "No model";
    // Composer footer label shows `<agent> · <model>` so the active agent is
    // visible without opening the popover.
    const label = `${state.currentAgent} · ${modelText}`;
    elements.modelSettingsLabel.textContent = label;
    elements.modelSettingsThinking.textContent = "";
    elements.modelSettingsThinking.append(iconElement("brain"), document.createTextNode(level));
    elements.modelSettingsButton.dataset.thinkingLevel = level;
    elements.modelSettingsButton.dataset.agent = state.currentAgent;
    elements.modelSettingsButton.title = `${label} · reasoning: ${level}`;
    elements.modelSettingsButton.setAttribute("aria-label", `Agent ${state.currentAgent}, model ${modelText}, reasoning ${level}`);
    // Reflect the active agent in the popover dropdown.
    if (elements.agentSelectEl.value !== state.currentAgent && state.currentAgent !== "mock") {
      elements.agentSelectEl.value = state.currentAgent;
    }
    updateAgentLockState();
  }

  /**
   * The agent dropdown is editable only while the current session has zero
   * user messages. Once the user has sent their first prompt the underlying
   * transcript is committed to that agent's on-disk format and changing the
   * agent would orphan the conversation; mirroring how cwd locks today.
   */
  function updateAgentLockState() {
    const userMessages = state.stats?.userMessages ?? 0;
    const locked = userMessages > 0;
    elements.agentSelectEl.disabled = locked;
    elements.agentLockedHint.hidden = !locked;
  }

  /**
   * Switch the active session's agent by creating a brand-new session with
   * the chosen kind. Only invokable while the dropdown is unlocked (zero user
   * messages); the server enforces the same precondition.
   */
  async function setAgentFromControl() {
    const next = elements.agentSelectEl.value;
    if (next !== "pi" && next !== "claude-code") return;
    if (next === state.currentAgent) return;
    elements.agentSelectEl.disabled = true;
    try {
      const res = await fetch("/api/sessions/new", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ agent: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      updateMeta(data);
      await refreshModels();
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
      // Roll the dropdown back to whatever the server actually has.
      if (state.currentAgent !== "mock") elements.agentSelectEl.value = state.currentAgent;
    } finally {
      updateAgentLockState();
    }
  }

  function setModelSettingsOpen(open: boolean) {
    elements.modelSettingsPopover.hidden = !open;
    elements.modelSettingsButton.setAttribute("aria-expanded", String(open));
  }

  function updateThinkingOptions(levels: string[] = [state.currentThinkingLevel]) {
    const options = levels.length ? levels : [state.currentThinkingLevel];
    elements.thinkingSelectEl.textContent = "";
    for (const level of options) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      elements.thinkingSelectEl.append(option);
    }
    elements.thinkingSelectEl.value = options.includes(state.currentThinkingLevel) ? state.currentThinkingLevel : options[0] || "off";
    updateSummary();
  }

  function populateModelSelect(models: any[], activeKey: string) {
    elements.modelSelectEl.textContent = "";
    for (const model of models) {
      if (!model) continue;
      const option = document.createElement("option");
      option.value = modelKey(model);
      option.textContent = modelLabel(model);
      elements.modelSelectEl.append(option);
    }
    elements.modelSelectEl.value = activeKey;
    if (!elements.modelSelectEl.value && activeKey) {
      const option = document.createElement("option");
      option.value = activeKey;
      option.textContent = activeKey;
      elements.modelSelectEl.prepend(option);
      elements.modelSelectEl.value = activeKey;
    }
  }

  async function refreshModels() {
    const res = await fetch("/api/models", { headers: api.headers() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    updateMeta({ cwd: data.cwd || "", model: data.current, thinkingLevel: data.thinkingLevel });
    populateModelSelect(data.models || [], state.currentModelKey);
    updateThinkingOptions(data.thinkingLevels || [state.currentThinkingLevel]);
  }

  async function setModelFromControls() {
    const [provider, ...idParts] = elements.modelSelectEl.value.split("/");
    const id = idParts.join("/");
    if (!provider || !id) return;

    elements.modelSelectEl.disabled = true;
    elements.thinkingSelectEl.disabled = true;
    elements.modelSettingsButton.disabled = true;
    try {
      const res = await fetch("/api/model", {
        method: "POST",
        headers: api.headers(),
        body: JSON.stringify({ provider, id, thinkingLevel: elements.thinkingSelectEl.value }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      updateMeta(data);
      updateThinkingOptions(data.thinkingLevels || [data.thinkingLevel]);
      await refreshModels();
    } catch (error) {
      addMessage("system", error instanceof Error ? error.message : String(error), "error");
      await refreshModels().catch(() => undefined);
    } finally {
      elements.modelSelectEl.disabled = false;
      elements.thinkingSelectEl.disabled = false;
      elements.modelSettingsButton.disabled = false;
    }
  }

  function init() {
    elements.modelSettingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setModelSettingsOpen(elements.modelSettingsPopover.hidden);
    });
    elements.modelSettingsPopover.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", (event) => {
      if (!elements.modelSettingsPopover.hidden && !elements.modelControl.contains(event.target as Node)) setModelSettingsOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.modelSettingsPopover.hidden) setModelSettingsOpen(false);
    });
    elements.agentSelectEl.addEventListener("change", () => {
      void setAgentFromControl();
    });
    elements.modelSelectEl.addEventListener("change", () => {
      const selected = elements.modelSelectEl.selectedOptions[0]?.textContent;
      if (selected) state.currentModelDisplay = selected;
      updateSummary();
      setModelFromControls();
    });
    elements.thinkingSelectEl.addEventListener("change", () => {
      state.currentThinkingLevel = elements.thinkingSelectEl.value;
      updateSummary();
      setModelFromControls();
    });
  }

  return {
    init,
    updateSummary,
    updateThinkingOptions,
    populateModelSelect,
    refreshModels,
  };
}
