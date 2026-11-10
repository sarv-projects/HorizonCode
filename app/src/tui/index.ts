/**
 * tui/index.ts — the chat surface of HorizonCode.
 *
 * Two loops, one renderer:
 *   runInteractive — a human at a terminal gets a chat bar (the default)
 *   runHeadless    — a pipe or a script gets plain streamed text
 */

export { runInteractive } from "./interactive";
export type { InteractiveOptions } from "./interactive";
export { runHeadless } from "./headless";
export type { HeadlessOptions } from "./headless";
export { runPrint, filesInDiff, PRINT_FORMATS } from "./print";
export type { PrintFormat, PrintOptions, PrintResult } from "./print";
export { createApprovalHandler, createApprovalUi, installApprovalHandler } from "./approval";
export type { ApprovalUi } from "./approval";
export { createRenderer } from "./render";
export type { RenderOptions, Renderer } from "./render";
export { printBanner, printGreeting } from "./banner";
export * as style from "./style";
