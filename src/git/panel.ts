import { fetchGitCommit, fetchGitDiff, fetchGitLog, fetchGitRepos, fetchGitStatus, syncGit } from "./api.js";
import { renderCommitView } from "./commitView.js";
import { renderDiffView } from "./diffView.js";
import { renderGraphView } from "./graphView.js";
import { renderStatusView } from "./statusView.js";
import type { GitCommit, GitFileStatus, GitPrimaryView, GitRepo, GitState } from "./types.js";

export function initGitPanel(options: { button: HTMLButtonElement; panel: HTMLElement; apiHeaders: () => HeadersInit }) {
  const { button, panel, apiHeaders } = options;
  const primary = panel.querySelector<HTMLElement>("#gitPrimaryPane")!;
  const detail = panel.querySelector<HTMLElement>("#gitDetailPane")!;
  const statusTab = panel.querySelector<HTMLButtonElement>("#gitStatusTab")!;
  const graphTab = panel.querySelector<HTMLButtonElement>("#gitGraphTab")!;
  const close = panel.querySelector<HTMLButtonElement>("#gitCloseButton")!;
  const footerText = panel.querySelector<HTMLElement>("#gitFooter")!;
  const syncButton = panel.querySelector<HTMLButtonElement>("#gitSyncButton")!;

  const state: GitState = {
    isOpen: false,
    loading: false,
    syncing: false,
    commits: [],
    repos: [],
    repoPickerOpen: false,
    primaryView: "status",
    mobileView: "status",
    diffLoading: false,
    commitLoading: false,
  };

  function repoStorageKey(cwd = state.repoCwd) {
    return cwd ? `pi-web.git.selectedRepo:${cwd}` : "pi-web.git.selectedRepo";
  }

  function storedRepo(cwd: string) {
    try { return localStorage.getItem(repoStorageKey(cwd)); } catch { return undefined; }
  }

  function storeRepo(repo: GitRepo) {
    try { localStorage.setItem(repoStorageKey(), repo.path); } catch { /* ignore */ }
  }

  function selectedRepoPath() {
    return state.selectedRepo?.path;
  }

  function setOpen(open: boolean) {
    state.isOpen = open;
    panel.hidden = !open;
    button.classList.toggle("active", open);
    if (open) void refresh();
  }

  function chooseRepo(repos: GitRepo[], cwd: string) {
    const previous = state.selectedRepo?.path || storedRepo(cwd);
    return repos.find((repo) => repo.path === previous) || repos.find((repo) => repo.isCurrent) || repos[0];
  }

  async function loadSelectedRepoData() {
    if (!state.selectedRepo) {
      state.status = { ok: true, isRepo: false, ahead: 0, behind: 0, files: [] };
      state.commits = [];
      state.selectedFile = undefined;
      state.selectedCommit = undefined;
      state.diff = undefined;
      state.commitDiff = undefined;
      return;
    }

    const repo = selectedRepoPath();
    const [status, log] = await Promise.all([fetchGitStatus(apiHeaders(), repo), fetchGitLog(apiHeaders(), repo)]);
    state.status = status;
    state.commits = log.commits || [];
    state.selectedFile = status.files[0];
    state.selectedCommit = state.commits[0];
    state.diff = undefined;
    state.commitDiff = undefined;
    state.commitFiles = undefined;
    if (state.selectedFile) await selectFile(state.selectedFile, false);
  }

  async function refresh() {
    state.loading = true; state.error = undefined; render();
    try {
      const repoList = await fetchGitRepos(apiHeaders());
      state.repos = repoList.repos;
      state.repoCwd = repoList.cwd;
      state.selectedRepo = chooseRepo(repoList.repos, repoList.cwd);
      await loadSelectedRepoData();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false; render();
    }
  }

  async function selectRepo(repo: GitRepo) {
    state.selectedRepo = repo;
    state.repoPickerOpen = false;
    state.loading = true;
    state.error = undefined;
    state.selectedFile = undefined;
    state.selectedCommit = undefined;
    state.diff = undefined;
    state.commitDiff = undefined;
    storeRepo(repo);
    render();
    try {
      await loadSelectedRepoData();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function selectFile(file: GitFileStatus, navigate = true) {
    state.selectedFile = file; state.diffLoading = true; state.diff = undefined;
    if (navigate) state.mobileView = "diff";
    render();
    try {
      const diff = await fetchGitDiff(apiHeaders(), file.path, file.staged && file.worktreeStatus === " ", selectedRepoPath());
      state.diff = diff.diff;
    } catch (error) {
      state.diff = error instanceof Error ? error.message : String(error);
    } finally {
      state.diffLoading = false; render();
    }
  }

  async function selectCommit(commit: GitCommit, navigate = true) {
    state.selectedCommit = commit;
    state.commitLoading = true;
    state.commitFiles = undefined;
    state.commitDiff = undefined;
    if (navigate) state.mobileView = "commit";
    render();
    try {
      const details = await fetchGitCommit(apiHeaders(), commit.hash, selectedRepoPath());
      state.commitFiles = details.files;
      state.commitDiff = details.diff;
    } catch (error) {
      state.commitDiff = error instanceof Error ? error.message : String(error);
    } finally {
      state.commitLoading = false;
      render();
    }
  }

  function setPrimary(view: GitPrimaryView) {
    state.primaryView = view;
    state.mobileView = view;
    render();
  }

  async function runSync() {
    state.syncing = true; state.error = undefined; render();
    try {
      const result = await syncGit(apiHeaders(), selectedRepoPath());
      state.status = result.status;
      const log = await fetchGitLog(apiHeaders(), selectedRepoPath());
      state.commits = log.commits || [];
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.syncing = false; render();
    }
  }

  function repoDisplayPath(repo: GitRepo) {
    return repo.path === "." ? "." : repo.path;
  }

  function renderRepoPicker(container: HTMLElement) {
    if (state.repos.length <= 1) return;
    const details = document.createElement("details");
    details.className = "gitRepoAccordion";
    details.open = state.repoPickerOpen || (!state.selectedRepo && state.repos.length > 0);
    details.addEventListener("toggle", () => { state.repoPickerOpen = details.open; });

    const summary = document.createElement("summary");
    summary.textContent = state.selectedRepo ? `Repository: ${repoDisplayPath(state.selectedRepo)}` : "Repository: none found";
    details.append(summary);

    const list = document.createElement("div");
    list.className = "gitRepoList";
    if (!state.repos.length) {
      const empty = document.createElement("div");
      empty.className = "gitRepoEmpty";
      empty.textContent = "No repos at the current folder or one level down.";
      list.append(empty);
    } else {
      for (const repo of state.repos) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `gitRepoItem${repo.path === state.selectedRepo?.path ? " selected" : ""}`;
        item.disabled = state.loading || state.syncing;
        item.addEventListener("click", () => void selectRepo(repo));

        const name = document.createElement("span");
        name.className = "gitRepoName";
        name.textContent = repoDisplayPath(repo);
        item.append(name);

        const meta = document.createElement("span");
        meta.className = "gitRepoMeta";
        const dirty = repo.dirtyCount ? `${repo.dirtyCount} changed` : "clean";
        meta.textContent = `${repo.branch || "detached"} · ${dirty}`;
        item.append(meta);

        list.append(item);
      }
    }
    details.append(list);
    container.append(details);
  }

  function renderFooter() {
    const s = state.status;
    const repo = state.repos.length > 1 && state.selectedRepo ? `${repoDisplayPath(state.selectedRepo)} · ` : "";
    footerText.textContent = s?.isRepo ? `${repo}${s.branch || "detached"}${s.upstream ? ` ⇄ ${s.upstream}` : ""} · Ahead ${s.ahead} · Behind ${s.behind}` : "Not a Git repository";
    syncButton.disabled = state.syncing || !s?.isRepo;
    syncButton.textContent = state.syncing ? "Syncing…" : "⟳ Sync";
  }

  function render() {
    panel.dataset.view = state.mobileView;
    panel.dataset.primaryView = state.primaryView;
    statusTab.classList.toggle("active", state.primaryView === "status");
    graphTab.classList.toggle("active", state.primaryView === "graph");
    primary.textContent = "";
    renderRepoPicker(primary);
    const primaryContent = document.createElement("div");
    primaryContent.className = "gitPrimaryContent";
    primary.append(primaryContent);

    if (state.loading) {
      primaryContent.textContent = "Loading Git data…";
    } else if (state.error) {
      primaryContent.textContent = state.error;
    } else if (!state.repos.length) {
      primaryContent.textContent = "No Git repositories found in the current folder or one level down.";
    } else if (!state.status?.isRepo) {
      primaryContent.textContent = "Selected folder is not a Git repository.";
    } else if (state.primaryView === "status") {
      renderStatusView({ container: primaryContent, files: state.status.files, selectedPath: state.selectedFile?.path, onSelectFile: (file) => void selectFile(file) });
    } else {
      renderGraphView({ container: primaryContent, commits: state.commits, selectedHash: state.selectedCommit?.hash, onSelectCommit: (commit) => void selectCommit(commit) });
    }

    if (state.mobileView === "commit") renderCommitView({ container: detail, commit: state.selectedCommit, files: state.commitFiles, diff: state.commitDiff, loading: state.commitLoading, onBack: () => setPrimary("graph") });
    else renderDiffView({ container: detail, file: state.selectedFile, diff: state.diff, loading: state.diffLoading, onBack: () => setPrimary("status") });
    renderFooter();
  }

  button.addEventListener("click", () => setOpen(!state.isOpen));
  close.addEventListener("click", () => setOpen(false));
  statusTab.addEventListener("click", () => setPrimary("status"));
  graphTab.addEventListener("click", () => setPrimary("graph"));
  syncButton.addEventListener("click", () => void runSync());
  render();
}
