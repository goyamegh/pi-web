import { Columns2, createElement, Rows2 } from "lucide";
import { diffHunkLineCount, renderDiffHunks, setDiffLayout } from "./diff.js";

function normalizeEditHunks(edits: unknown) {
  if (!Array.isArray(edits)) return [];
  return edits
    .filter((hunk): hunk is Record<string, unknown> => !!hunk && typeof hunk === "object")
    .map((hunk) => ({ oldText: hunk.oldText, newText: hunk.newText }));
}

function updateLayoutToggle(button: HTMLButtonElement, stacked: boolean) {
  button.replaceChildren(createElement(stacked ? Columns2 : Rows2, { "aria-hidden": "true" }));
  const label = stacked ? "Switch to side-by-side diff view" : "Switch to top/bottom diff view";
  button.setAttribute("aria-label", label);
  button.title = label;
}

export function renderEditDiff(card: HTMLDivElement, args: Record<string, unknown>) {
  const edits = normalizeEditHunks(args.edits);
  if (edits.length === 0) return;

  const toolbar = document.createElement("div");
  toolbar.className = "diffToolbar";
  const label = document.createElement("span");
  label.textContent = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  const layout = document.createElement("button");
  layout.type = "button";
  layout.className = "diffLayoutToggle";

  const container = renderDiffHunks(edits);
  let stacked = false;
  updateLayoutToggle(layout, stacked);
  layout.addEventListener("click", () => {
    stacked = !stacked;
    setDiffLayout(container, stacked);
    updateLayoutToggle(layout, stacked);
  });
  toolbar.append(label, layout);

  const collapsible = diffHunkLineCount(edits) > 20;
  if (collapsible) container.classList.add("collapsed");
  card.append(toolbar, container);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "messageToggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      const isCollapsed = container.classList.toggle("collapsed");
      toggle.textContent = isCollapsed ? "Show more" : "Show less";
    });
    card.append(toggle);
  }
}
