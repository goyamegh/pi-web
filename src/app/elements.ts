export type AppElements = {
  messagesEl: HTMLDivElement;
  statusTitleEl: HTMLSpanElement;
  statusPathEl: HTMLSpanElement;
  connectionStatusEl: HTMLSpanElement;
  formEl: HTMLFormElement;
  promptEl: HTMLTextAreaElement;
  primaryButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  tokenOverlay: HTMLDivElement;
  tokenForm: HTMLFormElement;
  tokenInput: HTMLInputElement;
  sessionButton: HTMLButtonElement;
  expandButton: HTMLButtonElement;
  sessionDrawer: HTMLElement;
  sessionBackdrop: HTMLDivElement;
  sessionCloseButton: HTMLButtonElement;
  sessionNewButton: HTMLButtonElement;
  sessionListEl: HTMLDivElement;
  queueToggle: HTMLButtonElement;
  attachButton: HTMLButtonElement;
  imageInput: HTMLInputElement;
  attachmentsEl: HTMLDivElement;
  modelControl: HTMLDivElement;
  modelSettingsButton: HTMLButtonElement;
  modelSettingsLabel: HTMLSpanElement;
  modelSettingsThinking: HTMLSpanElement;
  modelSettingsPopover: HTMLDivElement;
  modelSelectEl: HTMLSelectElement;
  thinkingSelectEl: HTMLSelectElement;
  newSessionHeaderButton: HTMLButtonElement;
  gitButton: HTMLButtonElement;
  gitPanel: HTMLElement;
  emptyCwdChooserEl: HTMLDivElement;
  emptyCwdPathEl: HTMLDivElement;
  emptyCwdButton: HTMLButtonElement;
};

export function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required DOM node: ${selector}`);
  return element;
}

export function getAppElements(): AppElements {
  return {
    messagesEl: requiredElement<HTMLDivElement>("#messages"),
    statusTitleEl: requiredElement<HTMLSpanElement>("#statusTitle"),
    statusPathEl: requiredElement<HTMLSpanElement>("#statusPath"),
    connectionStatusEl: requiredElement<HTMLSpanElement>("#connectionStatus"),
    formEl: requiredElement<HTMLFormElement>("#promptForm"),
    promptEl: requiredElement<HTMLTextAreaElement>("#prompt"),
    primaryButton: requiredElement<HTMLButtonElement>("#primaryButton"),
    stopButton: requiredElement<HTMLButtonElement>("#stopButton"),
    tokenOverlay: requiredElement<HTMLDivElement>("#tokenOverlay"),
    tokenForm: requiredElement<HTMLFormElement>("#tokenForm"),
    tokenInput: requiredElement<HTMLInputElement>("#tokenInput"),
    sessionButton: requiredElement<HTMLButtonElement>("#sessionButton"),
    expandButton: requiredElement<HTMLButtonElement>("#expandButton"),
    sessionDrawer: requiredElement<HTMLElement>("#sessionDrawer"),
    sessionBackdrop: requiredElement<HTMLDivElement>("#sessionBackdrop"),
    sessionCloseButton: requiredElement<HTMLButtonElement>("#sessionCloseButton"),
    sessionNewButton: requiredElement<HTMLButtonElement>("#sessionNewButton"),
    sessionListEl: requiredElement<HTMLDivElement>("#sessionList"),
    queueToggle: requiredElement<HTMLButtonElement>("#queueToggle"),
    attachButton: requiredElement<HTMLButtonElement>("#attachButton"),
    imageInput: requiredElement<HTMLInputElement>("#imageInput"),
    attachmentsEl: requiredElement<HTMLDivElement>("#attachments"),
    modelControl: requiredElement<HTMLDivElement>("#modelControl"),
    modelSettingsButton: requiredElement<HTMLButtonElement>("#modelSettingsButton"),
    modelSettingsLabel: requiredElement<HTMLSpanElement>("#modelSettingsLabel"),
    modelSettingsThinking: requiredElement<HTMLSpanElement>("#modelSettingsThinking"),
    modelSettingsPopover: requiredElement<HTMLDivElement>("#modelSettingsPopover"),
    modelSelectEl: requiredElement<HTMLSelectElement>("#modelSelect"),
    thinkingSelectEl: requiredElement<HTMLSelectElement>("#thinkingSelect"),
    newSessionHeaderButton: requiredElement<HTMLButtonElement>("#newSessionHeaderButton"),
    gitButton: requiredElement<HTMLButtonElement>("#gitButton"),
    gitPanel: requiredElement<HTMLElement>("#gitPanel"),
    emptyCwdChooserEl: requiredElement<HTMLDivElement>("#emptyCwdChooser"),
    emptyCwdPathEl: requiredElement<HTMLDivElement>("#emptyCwdChooser .emptyCwdPath"),
    emptyCwdButton: requiredElement<HTMLButtonElement>("#emptyCwdChooser .emptyCwdButton"),
  };
}

export function syncAppHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

export function initAppHeightSync() {
  syncAppHeight();
  window.addEventListener("resize", syncAppHeight);
  window.visualViewport?.addEventListener("resize", syncAppHeight);
  window.visualViewport?.addEventListener("scroll", syncAppHeight);
}
