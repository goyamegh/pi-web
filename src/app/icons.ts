import { Brain, CornerDownRight, createElement, GitBranch, KeyRound, Maximize2, Minimize2, Menu, Paperclip, Route, SendHorizontal, Square, SquarePen, X } from "lucide";

const iconNodes = {
  brain: Brain,
  "corner-down-right": CornerDownRight,
  "git-branch": GitBranch,
  "key-round": KeyRound,
  menu: Menu,
  paperclip: Paperclip,
  route: Route,
  "send-horizontal": SendHorizontal,
  square: Square,
  "square-pen": SquarePen,
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
