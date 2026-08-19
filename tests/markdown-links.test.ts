import { describe, expect, it } from "vitest";
import { isAllowedMarkdownHref } from "../src/markdown/render.js";

describe("isAllowedMarkdownHref", () => {
  it("allows http(s), mailto, anchors, relative paths, and vscode deep links", () => {
    expect(isAllowedMarkdownHref("https://example.com")).toBe(true);
    expect(isAllowedMarkdownHref("http://example.com")).toBe(true);
    expect(isAllowedMarkdownHref("mailto:a@b.com")).toBe(true);
    expect(isAllowedMarkdownHref("#section")).toBe(true);
    expect(isAllowedMarkdownHref("/api/artifacts/report.md")).toBe(true);
    expect(isAllowedMarkdownHref("vscode://vscode-remote/ssh-remote+host/path/file.excalidraw")).toBe(true);
    expect(isAllowedMarkdownHref("VSCODE://vscode-remote/ssh-remote+host/path")).toBe(true);
  });

  it("rejects script-capable and unknown schemes", () => {
    expect(isAllowedMarkdownHref("javascript:alert(1)")).toBe(false);
    expect(isAllowedMarkdownHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedMarkdownHref("file:///etc/passwd")).toBe(false);
    expect(isAllowedMarkdownHref("vbscript:msgbox(1)")).toBe(false);
    expect(isAllowedMarkdownHref("ftp://example.com")).toBe(false);
    // vscode must be the scheme, not a prefix trick
    expect(isAllowedMarkdownHref("javascript:alert(1)//vscode://")).toBe(false);
  });
});
