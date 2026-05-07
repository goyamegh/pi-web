import type { GitCommitDetailsResponse, GitDiffResponse, GitLogResponse, GitStatusResponse, GitSyncResponse } from "./types.js";

async function getJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export function fetchGitStatus(headers: HeadersInit) {
  return getJson<GitStatusResponse>("/api/git/status", headers);
}

export function fetchGitLog(headers: HeadersInit) {
  return getJson<GitLogResponse>("/api/git/log", headers);
}

export function fetchGitDiff(headers: HeadersInit, path: string, staged: boolean) {
  const query = new URLSearchParams({ path, staged: staged ? "1" : "0" });
  return getJson<GitDiffResponse>(`/api/git/diff?${query}`, headers);
}

export function fetchGitCommit(headers: HeadersInit, hash: string) {
  const query = new URLSearchParams({ hash });
  return getJson<GitCommitDetailsResponse>(`/api/git/commit?${query}`, headers);
}

export function syncGit(headers: HeadersInit) {
  return postJson<GitSyncResponse>("/api/git/sync", headers);
}
