import type { ApiClient } from "../app/api.js";
import type { AppElements } from "../app/elements.js";
import { clearToken, saveToken } from "../app/types.js";
import type { AppState, ImageAttachment } from "../app/types.js";
import { setIcon } from "../app/icons.js";

export type ComposerController = {
  init: () => void;
  renderAttachments: () => void;
  setPromptText: (text: string) => void;
  updatePrimaryAction: () => void;
  updateQueueToggle: () => void;
};

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      const data = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      resolve({ type: "image", data, mimeType: file.type, name: file.name });
    });
    reader.addEventListener("error", () => reject(reader.error || new Error(`Could not read ${file.name}`)));
    reader.readAsDataURL(file);
  });
}

export function createComposer(options: {
  state: AppState;
  elements: AppElements;
  api: ApiClient;
  addMessage: (role: "user" | "system", text: string, extraClass?: string, images?: any[]) => void;
  updateMeta: (data: any) => void;
  updateThinkingOptions: (levels?: string[]) => void;
  refreshModels: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshState: () => Promise<void>;
  beginStreamFollow?: () => void;
  endStreamFollow?: () => void;
}): ComposerController {
  const { state, elements, api, addMessage, updateMeta, updateThinkingOptions, refreshModels, refreshMessages, refreshState, beginStreamFollow, endStreamFollow } = options;

  function updatePrimaryAction() {
    const hasInput = !!elements.promptEl.value.trim() || state.attachedImages.length > 0;
    elements.primaryButton.disabled = !hasInput;
    elements.stopButton.style.display = state.isStreaming ? "" : "none";
  }

  function updateQueueToggle() {
    const isSteer = state.queueMode === "steer";
    elements.queueToggle.setAttribute("aria-pressed", String(isSteer));
    elements.queueToggle.title = isSteer ? "Queue mode: steer while running" : "Queue mode: follow up after running";
    elements.queueToggle.setAttribute("aria-label", elements.queueToggle.title);
    setIcon(elements.queueToggle, isSteer ? "route" : "corner-down-right");
  }

  function setPromptText(text: string) {
    elements.promptEl.value = text;
    updatePrimaryAction();
    elements.promptEl.focus();
  }

  function renderAttachments() {
    elements.attachmentsEl.textContent = "";
    elements.attachmentsEl.hidden = state.attachedImages.length === 0;
    state.attachedImages.forEach((image, index) => {
      const chip = document.createElement("div");
      chip.className = "attachmentChip";

      const preview = document.createElement("img");
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      preview.alt = "";

      const name = document.createElement("span");
      name.textContent = image.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "removeAttachment";
      remove.title = `Remove ${image.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        state.attachedImages.splice(index, 1);
        renderAttachments();
        updatePrimaryAction();
      });
      setIcon(remove, "x");

      chip.append(preview, name, remove);
      elements.attachmentsEl.append(chip);
    });
  }

  async function runSlashCommand(command: string) {
    const name = command.trim().replace(/^\/+/, "").split(/\s+/, 1)[0]?.toLowerCase();
    if (name === "logout") {
      state.token = "";
      clearToken();
      elements.tokenInput.value = "";
      elements.tokenOverlay.hidden = false;
      elements.tokenInput.focus();
      return;
    }
    const res = await fetch("/api/command", {
      method: "POST",
      headers: api.headers(),
      body: JSON.stringify({ command }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok || data.ok === false) throw new Error(data.error || text);
    if (data.state) {
      updateMeta(data.state);
      state.isStreaming = Boolean(data.state.isStreaming);
      updatePrimaryAction();
      if (data.state.thinkingLevels) updateThinkingOptions(data.state.thinkingLevels);
    }
    await refreshModels();
    if (name === "new" || name === "new-chat" || name === "clear") await refreshMessages();
    if (data.message) addMessage("system", data.message);
  }

  function init() {
    elements.formEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.isStreaming && !elements.promptEl.value.trim() && state.attachedImages.length === 0) return;

      const message = elements.promptEl.value.trim();
      const images = state.attachedImages.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
      if (!message && images.length === 0) return;

      if (message.startsWith("/") && images.length === 0) {
        elements.promptEl.value = "";
        updatePrimaryAction();
        addMessage("system", `› ${message}`);
        try {
          await runSlashCommand(message);
        } catch (error) {
          addMessage("system", error instanceof Error ? error.message : String(error), "error");
        } finally {
          elements.promptEl.focus();
        }
        return;
      }

      elements.promptEl.value = "";
      state.attachedImages = [];
      renderAttachments();
      updatePrimaryAction();
      beginStreamFollow?.();
      addMessage("user", message || "", "", images.map((img) => ({ data: img.data, mimeType: img.mimeType })));

      try {
        const res = await fetch("/api/prompt", {
          method: "POST",
          headers: api.headers(),
          body: JSON.stringify({ sessionId: state.currentSessionId, message, mode: state.queueMode, images }),
        });
        if (!res.ok) throw new Error(await res.text());
      } catch (error) {
        endStreamFollow?.();
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      } finally {
        elements.promptEl.focus();
      }
    });

    elements.promptEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        elements.formEl.requestSubmit();
      }
    });

    elements.promptEl.addEventListener("input", updatePrimaryAction);

    elements.attachButton.addEventListener("click", () => elements.imageInput.click());

    elements.imageInput.addEventListener("change", async () => {
      const files = Array.from(elements.imageInput.files || []).filter((file) => file.type.startsWith("image/"));
      elements.imageInput.value = "";
      try {
        const images = await Promise.all(files.map(fileToImageAttachment));
        state.attachedImages.push(...images);
        renderAttachments();
        updatePrimaryAction();
      } catch (error) {
        addMessage("system", error instanceof Error ? error.message : String(error), "error");
      }
    });

    elements.stopButton.addEventListener("click", async () => {
      await fetch("/api/abort", { method: "POST", headers: api.headers(), body: JSON.stringify({ sessionId: state.currentSessionId }) });
    });

    elements.queueToggle.addEventListener("click", () => {
      state.queueMode = state.queueMode === "steer" ? "followUp" : "steer";
      updateQueueToggle();
    });

    elements.tokenForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = elements.tokenInput.value.trim();
      if (!val) return;
      state.token = val;
      saveToken(state.token);
      elements.tokenOverlay.hidden = true;
      refreshState().catch((error) => addMessage("system", error instanceof Error ? error.message : String(error), "error"));
    });

    elements.expandButton.addEventListener("click", () => {
      state.editorExpanded = !state.editorExpanded;
      elements.formEl.classList.toggle("expanded", state.editorExpanded);
      setIcon(elements.expandButton, state.editorExpanded ? "minimize-2" : "maximize-2");
      elements.expandButton.title = state.editorExpanded ? "Collapse editor" : "Expand editor";
      elements.expandButton.setAttribute("aria-label", elements.expandButton.title);
      elements.promptEl.focus();
    });
  }

  return {
    init,
    renderAttachments,
    setPromptText,
    updatePrimaryAction,
    updateQueueToggle,
  };
}
