export type GitPrimaryView = "status" | "graph";
export type GitView = GitPrimaryView | "diff" | "commit";

export type GitFileLabel = "modified" | "added" | "deleted" | "renamed" | "untracked" | "staged" | "conflicted";

export type GitFileStatus = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  label: GitFileLabel;
  staged: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  refs: string[];
  subject: string;
};

export type GitStatusResponse = {
  ok: true;
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  defaultRemoteBranch?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
};

export type GitLogResponse = { ok: true; isRepo: boolean; commits: GitCommit[] };
export type GitDiffResponse = { ok: true; path: string; staged: boolean; diff: string };
export type GitCommitFile = { path: string; status: string; additions?: number; deletions?: number };
export type GitCommitDetailsResponse = { ok: true; commit: GitCommit; files: GitCommitFile[]; diff: string };
export type GitSyncResponse = { ok: true; output: string; status: GitStatusResponse };

export type GitState = {
  isOpen: boolean;
  loading: boolean;
  syncing: boolean;
  error?: string;
  status?: GitStatusResponse;
  commits: GitCommit[];
  primaryView: GitPrimaryView;
  mobileView: GitView;
  selectedFile?: GitFileStatus;
  selectedCommit?: GitCommit;
  commitFiles?: GitCommitFile[];
  commitDiff?: string;
  commitLoading: boolean;
  diff?: string;
  diffLoading: boolean;
};
