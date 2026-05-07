import { fetchGitCommit, fetchGitDiff, fetchGitLog, fetchGitStatus, syncGit } from "./api.js";
import { renderCommitView } from "./commitView.js";
import { renderDiffView } from "./diffView.js";
import { renderGraphView } from "./graphView.js";
import { renderStatusView } from "./statusView.js";
import type { GitCommit, GitFileStatus, GitPrimaryView, GitState } from "./types.js";

export function initGitPanel(options: { button: HTMLButtonElement; panel: HTMLElement; apiHeaders: () => HeadersInit }) {
  const { button, panel, apiHeaders } = options;
  const primary = panel.querySelector<HTMLElement>("#gitPrimaryPane")!;
  const detail = panel.querySelector<HTMLElement>("#gitDetailPane")!;
  const statusTab = panel.querySelector<HTMLButtonElement>("#gitStatusTab")!;
  const graphTab = panel.querySelector<HTMLButtonElement>("#gitGraphTab")!;
  const close = panel.querySelector<HTMLButtonElement>("#gitCloseButton")!;
  const footerText = panel.querySelector<HTMLElement>("#gitFooter")!;
  const syncButton = panel.querySelector<HTMLButtonElement>("#gitSyncButton")!;

  const state: GitState = { isOpen: false, loading: false, syncing: false, commits: [], primaryView: "status", mobileView: "status", diffLoading: false, commitLoading: false };

  function setOpen(open: boolean) {
    state.isOpen = open;
    panel.hidden = !open;
    button.classList.toggle("active", open);
    if (open) void refresh();
  }

  async function refresh() {
    state.loading = true; state.error = undefined; render();
    try {
      const [status, log] = await Promise.all([fetchGitStatus(apiHeaders()), fetchGitLog(apiHeaders())]);
      state.status = status; state.commits = log.commits || [];
      state.selectedFile = status.files[0];
      state.selectedCommit = state.commits[0];
      if (state.selectedFile) await selectFile(state.selectedFile, false);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false; render();
    }
  }

  async function selectFile(file: GitFileStatus, navigate = true) {
    state.selectedFile = file; state.diffLoading = true; state.diff = undefined;
    if (navigate) state.mobileView = "diff";
    render();
    try {
      const diff = await fetchGitDiff(apiHeaders(), file.path, file.staged && file.worktreeStatus === " ");
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
      const details = await fetchGitCommit(apiHeaders(), commit.hash);
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
      const result = await syncGit(apiHeaders());
      state.status = result.status;
      const log = await fetchGitLog(apiHeaders());
      state.commits = log.commits || [];
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.syncing = false; render();
    }
  }

  function renderFooter() {
    const s = state.status;
    footerText.textContent = s?.isRepo ? `${s.branch || "detached"}${s.upstream ? ` ⇄ ${s.upstream}` : ""} · Ahead ${s.ahead} · Behind ${s.behind}` : "Not a Git repository";
    syncButton.disabled = state.syncing || !s?.isRepo;
    syncButton.textContent = state.syncing ? "Syncing…" : "⟳ Sync";
  }

  function render() {
    panel.dataset.view = state.mobileView;
    panel.dataset.primaryView = state.primaryView;
    statusTab.classList.toggle("active", state.primaryView === "status");
    graphTab.classList.toggle("active", state.primaryView === "graph");
    primary.textContent = "";
    if (state.loading) {
      primary.textContent = "Loading Git data…";
    } else if (state.error) {
      primary.textContent = state.error;
    } else if (!state.status?.isRepo) {
      primary.textContent = "Current working directory is not a Git repository.";
    } else if (state.primaryView === "status") {
      renderStatusView({ container: primary, files: state.status.files, selectedPath: state.selectedFile?.path, onSelectFile: (file) => void selectFile(file) });
    } else {
      renderGraphView({ container: primary, commits: state.commits, selectedHash: state.selectedCommit?.hash, onSelectCommit: (commit) => void selectCommit(commit) });
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
