import { createElement, GitPullRequestArrow } from "lucide";
import type { GitFileStatus, GitRepo, GitStatusResponse } from "./types.js";

function code(file: GitFileStatus) {
  if (file.label === "untracked") return "U";
  if (file.label === "modified") return "M";
  if (file.label === "added") return "A";
  if (file.label === "deleted") return "D";
  if (file.label === "renamed") return "R";
  if (file.label === "conflicted") return "!";
  return `${file.indexStatus || " "}${file.worktreeStatus || " "}`.trim() || file.label[0].toUpperCase();
}

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: GitFileStatus;
};

function buildTree(files: GitFileStatus[]) {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const [index, part] of parts.entries()) {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.file = file;
  }
  return root;
}

function sortedChildren(node: TreeNode) {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function repoDisplayPath(repo: GitRepo) {
  return repo.path === "." ? "." : repo.path;
}

function repoCounts(repo: GitRepo, status?: GitStatusResponse) {
  return {
    branch: status?.branch || repo.branch || "detached",
    upstream: status?.upstream || repo.upstream,
    ahead: status?.ahead ?? repo.ahead,
    behind: status?.behind ?? repo.behind,
    dirtyCount: status?.files.length ?? repo.dirtyCount,
  };
}

function appendRepoMeta(container: HTMLElement, repo: GitRepo, status?: GitStatusResponse) {
  const counts = repoCounts(repo, status);
  const values = [
    counts.branch,
    counts.upstream ? `⇄ ${counts.upstream}` : "",
    `↑${counts.ahead}`,
    `↓${counts.behind}`,
    counts.dirtyCount ? `${counts.dirtyCount} changed` : "clean",
  ].filter(Boolean);
  for (const value of values) {
    const item = document.createElement("span");
    item.className = "gitRepoMetaBadge";
    item.textContent = value;
    container.append(item);
  }
}

function shouldShowRebase(repo: GitRepo, status?: GitStatusResponse) {
  const counts = repoCounts(repo, status);
  return Boolean(counts.upstream && counts.behind > 0);
}

function createRebaseButton(repo: GitRepo, status: GitStatusResponse | undefined, syncingRepo: string | undefined, onRebase: (repo: GitRepo) => void) {
  if (!shouldShowRebase(repo, status)) return undefined;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gitRebaseButton";
  button.title = "Fetch and rebase onto upstream";
  button.setAttribute("aria-label", `Fetch and rebase ${repoDisplayPath(repo)} onto upstream`);
  button.disabled = syncingRepo === repo.path;
  button.append(createElement(GitPullRequestArrow, { "aria-hidden": "true" }));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onRebase(repo);
  });
  return button;
}

function renderTreeNode(options: {
  container: HTMLElement;
  node: TreeNode;
  repo: GitRepo;
  selectedPath?: string;
  selectedRepoPath?: string;
  onSelectFile: (file: GitFileStatus, repo: GitRepo) => void;
}) {
  const { container, node, repo, selectedPath, selectedRepoPath, onSelectFile } = options;
  for (const child of sortedChildren(node)) {
    if (child.file && child.children.size === 0) {
      const file = child.file;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `gitFileItem gitTreeFile${file.path === selectedPath && repo.path === selectedRepoPath ? " selected" : ""}`;
      const badge = document.createElement("span");
      badge.className = `gitStatusBadge ${file.label}`;
      badge.textContent = code(file);
      const name = document.createElement("span");
      name.className = "gitFilePath";
      name.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : child.name;
      button.append(badge, name);
      button.addEventListener("click", () => onSelectFile(file, repo));
      container.append(button);
      continue;
    }

    const details = document.createElement("details");
    details.className = "gitTreeDir";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = child.name;
    details.append(summary);
    const children = document.createElement("div");
    children.className = "gitTreeChildren";
    renderTreeNode({ container: children, node: child, repo, selectedPath, selectedRepoPath, onSelectFile });
    details.append(children);
    container.append(details);
  }
}

export function renderStatusView(options: {
  container: HTMLElement;
  repos: GitRepo[];
  statusesByRepo: Record<string, GitStatusResponse | undefined>;
  selectedPath?: string;
  selectedRepoPath?: string;
  syncingRepo?: string;
  onSelectRepo: (repo: GitRepo) => void;
  onSelectFile: (file: GitFileStatus, repo: GitRepo) => void;
  onRebase: (repo: GitRepo) => void;
}) {
  const { container, repos, statusesByRepo, selectedPath, selectedRepoPath, syncingRepo, onSelectRepo, onSelectFile, onRebase } = options;
  container.textContent = "";

  const repoSection = document.createElement("section");
  repoSection.className = "gitRepoOverview";
  const repoHeading = document.createElement("h3");
  repoHeading.textContent = "Repositories";
  repoSection.append(repoHeading);

  const repoList = document.createElement("div");
  repoList.className = "gitRepoOverviewList";
  for (const repo of repos) {
    const status = statusesByRepo[repo.path];
    const row = document.createElement("div");
    row.className = `gitRepoOverviewItem${repo.path === selectedRepoPath ? " selected" : ""}`;

    const select = document.createElement("button");
    select.type = "button";
    select.className = "gitRepoSelect";
    select.addEventListener("click", () => onSelectRepo(repo));

    const name = document.createElement("span");
    name.className = "gitRepoName";
    name.textContent = repoDisplayPath(repo);
    const meta = document.createElement("span");
    meta.className = "gitRepoMeta";
    appendRepoMeta(meta, repo, status);
    select.append(name, meta);
    row.append(select);

    const rebase = createRebaseButton(repo, status, syncingRepo, onRebase);
    if (rebase) row.append(rebase);
    repoList.append(row);
  }
  repoSection.append(repoList);
  container.append(repoSection);

  const changesSection = document.createElement("section");
  changesSection.className = "gitChangesOverview";
  const changesHeading = document.createElement("h3");
  changesHeading.textContent = "Changes";
  changesSection.append(changesHeading);

  let totalChanges = 0;
  for (const repo of repos) {
    const status = statusesByRepo[repo.path];
    const files = status?.files || [];
    totalChanges += files.length;
    if (status && !files.length) continue;

    const details = document.createElement("details");
    details.className = "gitRepoChangesAccordion";
    details.open = files.length > 0 || repo.path === selectedRepoPath;

    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "gitRepoName";
    name.textContent = repoDisplayPath(repo);
    const meta = document.createElement("span");
    meta.className = "gitRepoMeta";
    appendRepoMeta(meta, repo, status);
    summary.append(name, meta);
    details.append(summary);

    const body = document.createElement("div");
    body.className = "gitRepoChangesBody";
    if (!status) {
      const empty = document.createElement("div");
      empty.className = "gitEmpty";
      empty.textContent = "Loading status…";
      body.append(empty);
    } else {
      renderTreeNode({ container: body, node: buildTree(files), repo, selectedPath, selectedRepoPath, onSelectFile });
    }
    details.append(body);
    changesSection.append(details);
  }

  if (!totalChanges) {
    const empty = document.createElement("div");
    empty.className = "gitEmpty";
    empty.textContent = "All working trees clean.";
    changesSection.append(empty);
  }
  container.append(changesSection);
}
