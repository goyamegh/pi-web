import type { GitCommitDetailsResponse, GitDiffResponse, GitLogResponse, GitReposResponse, GitStatusResponse, GitSyncResponse } from "./types.js";

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

function queryWithRepo(values: Record<string, string> = {}, repo?: string) {
  const query = new URLSearchParams(values);
  if (repo) query.set("repo", repo);
  return query;
}

export function fetchGitRepos(headers: HeadersInit) {
  return getJson<GitReposResponse>("/api/git/repos", headers);
}

export function fetchGitStatus(headers: HeadersInit, repo?: string) {
  const query = queryWithRepo({}, repo);
  return getJson<GitStatusResponse>(`/api/git/status?${query}`, headers);
}

export function fetchGitLog(headers: HeadersInit, repo?: string) {
  const query = queryWithRepo({}, repo);
  return getJson<GitLogResponse>(`/api/git/log?${query}`, headers);
}

export function fetchGitDiff(headers: HeadersInit, path: string, staged: boolean, repo?: string) {
  const query = queryWithRepo({ path, staged: staged ? "1" : "0" }, repo);
  return getJson<GitDiffResponse>(`/api/git/diff?${query}`, headers);
}

export function fetchGitCommit(headers: HeadersInit, hash: string, repo?: string) {
  const query = queryWithRepo({ hash }, repo);
  return getJson<GitCommitDetailsResponse>(`/api/git/commit?${query}`, headers);
}

export function syncGit(headers: HeadersInit, repo?: string) {
  const query = queryWithRepo({}, repo);
  return postJson<GitSyncResponse>(`/api/git/sync?${query}`, headers);
}
