import { PAPER_TRADING } from "../config.js";

export function assertPaperMode(): void {
  if (PAPER_TRADING !== true) {
    throw new Error(
      "Order execution requires PAPER_TRADING=true and is disabled in paper-off mode."
    );
  }
}
