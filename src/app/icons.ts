import { Bookmark, Brain, CornerDownRight, createElement, GitBranch, GitFork, KeyRound, Maximize2, Minimize2, Menu, MoreVertical, Paperclip, Pin, Route, SendHorizontal, Settings, Square, SquarePen, Star, Trash2, X } from "lucide";

const iconNodes = {
  bookmark: Bookmark,
  brain: Brain,
  "corner-down-right": CornerDownRight,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  "key-round": KeyRound,
  menu: Menu,
  "more-vertical": MoreVertical,
  paperclip: Paperclip,
  pin: Pin,
  route: Route,
  "send-horizontal": SendHorizontal,
  settings: Settings,
  square: Square,
  "square-pen": SquarePen,
  star: Star,
  "trash-2": Trash2,
  "maximize-2": Maximize2,
  "minimize-2": Minimize2,
  x: X,
} as const;

export type IconName = keyof typeof iconNodes;

export function iconElement(name: IconName) {
  return createElement(iconNodes[name], { "aria-hidden": "true" });
}

export function setIcon(button: HTMLButtonElement, name: IconName) {
  button.textContent = "";
  button.append(iconElement(name));
}
