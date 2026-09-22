/** Shared dimensions for the page host and the localhost preview. */
export const CHAT_GEOMETRY = {
  inset: 24,
  normal: {
    width: 380,
    minWidth: 320,
    height: 720,
    maxHeightPercent: 70,
    minHeight: 360,
    radius: 16
  },
  /** The settings workspace needs room for the section list and the section form. */
  settings: {
    width: 600
  },
  expanded: {
    width: 760,
    height: 820,
    maxHeightPercent: 84,
    viewportMargin: 48,
    radius: 18
  },
  minimized: {
    width: 112,
    height: 44,
    radius: 14
  }
} as const

/** One layout source for the page host and the development preview. */
export const CHAT_LAYOUT = {
  normal: {
    right: `${CHAT_GEOMETRY.inset}px`,
    bottom: `${CHAT_GEOMETRY.inset}px`,
    left: "auto",
    top: "auto",
    width: `${CHAT_GEOMETRY.normal.width}px`,
    maxWidth: `calc(100vw - ${CHAT_GEOMETRY.expanded.viewportMargin}px)`,
    height: `${CHAT_GEOMETRY.normal.height}px`,
    maxHeight: `${CHAT_GEOMETRY.normal.maxHeightPercent}vh`,
    minHeight: `${CHAT_GEOMETRY.normal.minHeight}px`,
    overflow: "hidden",
    transform: "none",
    borderRadius: `${CHAT_GEOMETRY.normal.radius}px`
  },
  expanded: {
    right: "auto",
    bottom: "auto",
    left: "50%",
    top: "50%",
    width: `${CHAT_GEOMETRY.expanded.width}px`,
    maxWidth: `calc(100vw - ${CHAT_GEOMETRY.expanded.viewportMargin}px)`,
    height: `${CHAT_GEOMETRY.expanded.height}px`,
    maxHeight: `${CHAT_GEOMETRY.expanded.maxHeightPercent}vh`,
    minHeight: "0",
    overflow: "hidden",
    transform: "translate(-50%, -50%)",
    borderRadius: `${CHAT_GEOMETRY.expanded.radius}px`
  },
  minimized: {
    right: `${CHAT_GEOMETRY.inset}px`,
    bottom: `${CHAT_GEOMETRY.inset}px`,
    left: "auto",
    top: "auto",
    width: `${CHAT_GEOMETRY.minimized.width}px`,
    maxWidth: "none",
    height: `${CHAT_GEOMETRY.minimized.height}px`,
    maxHeight: "none",
    minHeight: "0",
    overflow: "visible",
    transform: "none",
    borderRadius: `${CHAT_GEOMETRY.minimized.radius}px`
  }
} as const
