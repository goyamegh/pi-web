import type { GitCommit } from "./types.js";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function renderGraphView(options: {
  container: HTMLElement;
  commits: GitCommit[];
  selectedHash?: string;
  onSelectCommit: (commit: GitCommit) => void;
}) {
  const { container, commits, selectedHash, onSelectCommit } = options;
  container.textContent = "";
  if (!commits.length) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "No commits found.";
    container.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "gitCommitList";
  for (const commit of commits) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gitCommitItem${commit.hash === selectedHash ? " selected" : ""}`;
    const rail = document.createElement("span");
    rail.className = "gitCommitRail";
    const dot = document.createElement("span");
    dot.className = "gitCommitDot";
    rail.append(dot);

    const body = document.createElement("span");
    body.className = "gitCommitBody";
    const subject = document.createElement("span");
    subject.className = "gitCommitSubject";
    subject.textContent = commit.subject;
    const meta = document.createElement("span");
    meta.className = "gitCommitMeta";
    meta.textContent = `${commit.shortHash} · ${commit.author} · ${formatDate(commit.date)}`;
    body.append(subject);
    if (commit.refs.length) {
      const refs = document.createElement("span");
      refs.className = "gitCommitRefs";
      refs.textContent = commit.refs.join(" ");
      body.append(refs);
    }
    body.append(meta);
    button.append(rail, body);
    button.addEventListener("click", () => onSelectCommit(commit));
    list.append(button);
  }
  container.append(list);
}
