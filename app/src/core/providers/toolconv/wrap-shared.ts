/**
 * wrap-shared.ts — shared inner request prep for text toolconv wrappers.
 */

import type { ProviderRequest, ToolSpec } from "../../../contracts";
import type { ToolFormat } from "../../config";
import { rewriteHistoryForTextToolconv } from "./history-rewrite";

export function prepareInnerTextToolRequest(
  req: ProviderRequest,
  dialect: ToolFormat,
  renderInstructions: (specs: ToolSpec[]) => string,
): ProviderRequest {
  const appendix = renderInstructions(req.tools);
  const extra = appendix !== "" ? `\n\n${appendix}` : "";
  return {
    ...req,
    system: req.system + extra,
    tools: [],
    messages: rewriteHistoryForTextToolconv(req.messages, dialect),
  };
}
