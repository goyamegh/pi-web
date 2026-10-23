import { type IconNode, ArrowLeft, Bell, Bookmark, Brain, Check, CheckCircle, ChevronRight, Copy, CornerDownRight, createElement, Flag, FolderTree, Funnel, GitBranch, GitFork, Hourglass, Info, KeyRound, LoaderCircle, Maximize2, Mic, Minimize2, Menu, MessageCircle, MoreVertical, NotebookPen, Paperclip, Pencil, Pin, RotateCcw, Route, ScrollText, Search, SendHorizontal, Server, Settings, Square, SquarePen, Star, Trash2, TriangleAlert, WifiOff, X } from "lucide";

/**
 * pi-web's own "session search" mark: a magnifying glass peeking out of a chat
 * bubble. Drawn on lucide's 24px grid so it inherits currentColor and the
 * shared stroke style; it is an original drawing, not a lucide glyph.
 */
const SessionSearch: IconNode = [
  ["path", { d: "M20 12.5V8a3.5 3.5 0 0 0-3.5-3.5h-9A3.5 3.5 0 0 0 4 8v12.5l5-4h6.5" }],
  ["circle", { cx: "12.5", cy: "9.5", r: "3.2" }],
  ["path", { d: "m14.8 11.8 4.7 4.7" }],
];

const iconNodes = {
  "arrow-left": ArrowLeft,
  bell: Bell,
  bookmark: Bookmark,
  brain: Brain,
  check: Check,
  "circle-check": CheckCircle,
  "chevron-right": ChevronRight,
  copy: Copy,
  "corner-down-right": CornerDownRight,
  flag: Flag,
  "folder-tree": FolderTree,
  funnel: Funnel,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  info: Info,
  hourglass: Hourglass,
  "key-round": KeyRound,
  "loader-circle": LoaderCircle,
  menu: Menu,
  mic: Mic,
  "message-circle": MessageCircle,
  "more-vertical": MoreVertical,
  "notebook-pen": NotebookPen,
  paperclip: Paperclip,
  pin: Pin,
  pencil: Pencil,
  "rotate-ccw": RotateCcw,
  route: Route,
  "scroll-text": ScrollText,
  search: Search,
  "session-search": SessionSearch,
  "send-horizontal": SendHorizontal,
  server: Server,
  settings: Settings,
  square: Square,
  "square-pen": SquarePen,
  star: Star,
  "trash-2": Trash2,
  "triangle-alert": TriangleAlert,
  "wifi-off": WifiOff,
  "maximize-2": Maximize2,
  "minimize-2": Minimize2,
  x: X,
} as const;

export type IconName = keyof typeof iconNodes;

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(iconNodes, value);
}

export function iconElement(name: IconName) {
  return createElement(iconNodes[name], { "aria-hidden": "true" });
}

export function setIcon(element: HTMLElement, name: IconName) {
  element.textContent = "";
  element.append(iconElement(name));
}
