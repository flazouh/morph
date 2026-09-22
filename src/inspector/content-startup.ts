import {
  GATE,
  GATE_MS,
  hold,
  wearStyles
} from "../bridge/loader"
import type { InspectorSend } from "./controller"
import { cssFor, INSPECTOR_SHEET_ID } from "./css"

export const startInspectorContent = async (
  document: Document,
  send: InspectorSend
): Promise<void> => {
  try {
    const answer = await send({ type: "loadInspector" })
    if (answer.type === "inspectorLoaded" && answer.record !== null) {
      wearStyles(
        document,
        hold,
        INSPECTOR_SHEET_ID,
        cssFor(answer.record),
        false,
        GATE,
        GATE_MS
      )
    }
  } catch {
    // Inspector restore must not stop the existing content script from becoming ready.
  }
}
