import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { Check, Copy, createElement } from "lucide";
import { attachImageActions } from "../components/imageActions.js";

marked.setOptions({
  async: false,
  breaks: true,
  gfm: true,
});

const markdownCache = new Map<string, string>();
const maxCachedMarkdown = 160;
const allowedMarkdownTags = new Set([
  "a", "blockquote", "br", "code", "del", "div", "em", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "img",
  "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);
const allowedMarkdownAttributes = new Set(["alt", "class", "href", "rel", "src", "target", "title"]);

export type MarkdownRenderer = {
  renderAssistantMarkdown: (body: HTMLElement, text: string) => void;
  queueAssistantMarkdownRender: (body: HTMLElement, text: string) => void;
  unobserve: (body: HTMLElement) => void;
};

function sanitizeMarkdownHtml(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (!allowedMarkdownTags.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowedMarkdownAttributes.has(name) || name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "href") {
        const href = attribute.value.trim();
        if (!/^(https?:|mailto:|#|\/)/i.test(href)) element.removeAttribute(attribute.name);
      }

      if (name === "src") {
        const src = attribute.value.trim();
        if (!/^(https?:|data:image\/(png|jpeg|jpg|gif|webp);base64,|\/api\/artifacts\/)/i.test(src)) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    if (tagName === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }

    if (tagName === "img" && !element.getAttribute("src")) {
      element.remove();
    }
  }

  return template.innerHTML;
}

function highlightMarkdownCode(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const code of Array.from(template.content.querySelectorAll("pre code"))) {
    const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
    const language = languageClass?.slice("language-".length);
    const source = code.textContent || "";

    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(source, { language }).value
      : hljs.highlightAuto(source).value;

    code.innerHTML = highlighted;
    code.classList.add("hljs");
    if (language) code.classList.add(`language-${language}`);
  }

  return template.innerHTML;
}

function markdownHtml(text: string) {
  const cached = markdownCache.get(text);
  if (cached !== undefined) {
    markdownCache.delete(text);
    markdownCache.set(text, cached);
    return cached;
  }

  const html = highlightMarkdownCode(sanitizeMarkdownHtml(marked.parse(text) as string));
  markdownCache.set(text, html);
  if (markdownCache.size > maxCachedMarkdown) markdownCache.delete(markdownCache.keys().next().value as string);
  return html;
}

function enhanceCodeBlocks(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll<HTMLPreElement>("pre"))) {
    if (pre.querySelector(".copyCode")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copyCode";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", btn.title);
    btn.append(createElement(Copy, { "aria-hidden": "true" }));
    btn.dataset.icon = "copy";
    btn.addEventListener("click", () => {
      btn.innerHTML = "";
      btn.append(createElement(Check, { "aria-hidden": "true" }));
      btn.dataset.icon = "check";
      setTimeout(() => {
        btn.innerHTML = "";
        btn.append(createElement(Copy, { "aria-hidden": "true" }));
        btn.dataset.icon = "copy";
      }, 1500);
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code?.textContent || pre.textContent || "").catch(() => {});
    });
    pre.style.position = "relative";
    pre.append(btn);
  }
}

function enhanceImages(root: ParentNode) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) attachImageActions(img);
}

function renderAssistantMarkdown(body: HTMLElement, text: string) {
  body.classList.add("markdownBody");
  body.innerHTML = markdownHtml(text);
  enhanceCodeBlocks(body);
  enhanceImages(body);
  body.dataset.markdownRendered = "true";
  delete body.dataset.markdownText;
}

export function createMarkdownRenderer(messagesEl: HTMLElement): MarkdownRenderer {
  const requestIdle = window.requestIdleCallback || ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1));
  const markdownRenderObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const body = entry.target as HTMLElement;
        observer.unobserve(body);
        const text = body.dataset.markdownText || "";
        requestIdle(() => {
          if (body.isConnected && text && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
        });
      }
    }, { root: messagesEl, rootMargin: "600px 0px" })
    : null;

  return {
    renderAssistantMarkdown,
    queueAssistantMarkdownRender(body, text) {
      body.dataset.markdownText = text;
      if (markdownRenderObserver) markdownRenderObserver.observe(body);
      else requestIdle(() => {
        if (body.isConnected && !body.dataset.markdownRendered) renderAssistantMarkdown(body, text);
      });
    },
    unobserve(body) {
      markdownRenderObserver?.unobserve(body);
    },
  };
}
