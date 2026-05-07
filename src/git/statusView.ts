import type { GitFileStatus } from "./types.js";

const groups: Array<[string, (file: GitFileStatus) => boolean]> = [
  ["Conflicted", (f) => f.label === "conflicted"],
  ["Staged", (f) => f.staged && f.label !== "conflicted"],
  ["Modified", (f) => !f.staged && f.label === "modified"],
  ["Untracked", (f) => f.label === "untracked"],
  ["Other", (f) => !f.staged && !["modified", "untracked", "conflicted"].includes(f.label)],
];

function code(file: GitFileStatus) {
  if (file.label === "untracked") return "??";
  return `${file.indexStatus || " "}${file.worktreeStatus || " "}`.trim() || file.label[0].toUpperCase();
}

export function renderStatusView(options: {
  container: HTMLElement;
  files: GitFileStatus[];
  selectedPath?: string;
  onSelectFile: (file: GitFileStatus) => void;
}) {
  const { container, files, selectedPath, onSelectFile } = options;
  container.textContent = "";
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "Working tree clean.";
    container.append(empty);
    return;
  }

  const rendered = new Set<GitFileStatus>();
  for (const [title, predicate] of groups) {
    const items = files.filter((file) => predicate(file) && !rendered.has(file));
    if (!items.length) continue;
    items.forEach((item) => rendered.add(item));

    const section = document.createElement("section");
    section.className = "gitStatusGroup";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);

    for (const file of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `gitFileItem${file.path === selectedPath ? " selected" : ""}`;
      const badge = document.createElement("span");
      badge.className = `gitStatusBadge ${file.label}`;
      badge.textContent = code(file);
      const name = document.createElement("span");
      name.className = "gitFilePath";
      name.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      button.append(badge, name);
      button.addEventListener("click", () => onSelectFile(file));
      section.append(button);
    }
    container.append(section);
  }
}
