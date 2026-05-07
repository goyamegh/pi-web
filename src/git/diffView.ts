import { Columns2, createElement, Rows2 } from "lucide";
import { renderUnifiedPatch, setDiffLayout } from "../components/diff.js";
import type { GitFileStatus } from "./types.js";

function mobileDefaultStacked() {
  return window.matchMedia("(max-width: 700px)").matches;
}

export function renderUnifiedDiff(diff: string) {
  const wrapper = document.createElement("div");
  const toolbar = document.createElement("div");
  toolbar.className = "diffToolbar gitDiffToolbar";
  const label = document.createElement("span");
  const fileCount = (diff.match(/^diff --git /gm) || []).length;
  label.textContent = `${fileCount || 1} file${fileCount === 1 ? "" : "s"}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diffLayoutToggle";

  let stacked = mobileDefaultStacked();
  const patch = renderUnifiedPatch(diff, { stacked });
  const updateToggle = () => {
    toggle.replaceChildren(createElement(stacked ? Columns2 : Rows2, { "aria-hidden": "true" }));
    const text = stacked ? "Switch to side-by-side diff view" : "Switch to top/bottom diff view";
    toggle.title = text;
    toggle.setAttribute("aria-label", text);
  };
  toggle.addEventListener("click", () => {
    stacked = !stacked;
    setDiffLayout(patch, stacked);
    updateToggle();
  });
  updateToggle();
  toolbar.append(label, toggle);
  wrapper.append(toolbar, patch);
  return wrapper;
}

export function renderDiffView(options: {
  container: HTMLElement;
  file?: GitFileStatus;
  diff?: string;
  loading?: boolean;
  onBack?: () => void;
}) {
  const { container, file, diff, loading, onBack } = options;
  container.textContent = "";
  const header = document.createElement("div");
  header.className = "gitDetailHeader";
  if (onBack) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "gitBackButton";
    back.textContent = "← Back";
    back.addEventListener("click", onBack);
    header.append(back);
  }
  const title = document.createElement("h3");
  title.textContent = file ? file.path : "Diff";
  header.append(title);
  container.append(header);

  if (!file) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Select a file to view its diff.";
    container.append(empty);
    return;
  }
  if (loading) {
    const el = document.createElement("div");
    el.className = "gitEmpty";
    el.textContent = "Loading diff…";
    container.append(el);
    return;
  }
  if (!diff) {
    const el = document.createElement("div");
    el.className = "gitEmpty";
    el.textContent = "No diff available.";
    container.append(el);
    return;
  }

  container.append(renderUnifiedDiff(diff));
}
