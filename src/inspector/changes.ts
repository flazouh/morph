import type { ChangeHistory, ChangeRecord, StyleChange, StyleProperty } from "./model"

const update = (
  history: ChangeHistory,
  changes: ReadonlyArray<StyleChange>
): ChangeHistory => ({
  present: { ...history.present, changes },
  past: [...history.past, history.present],
  future: []
})

export const applyChange = (history: ChangeHistory, change: StyleChange): ChangeHistory => {
  const index = history.present.changes.findIndex(
    (item) => item.selector === change.selector && item.property === change.property
  )

  if (index === -1) {
    if (change.before === change.after) return history
    return update(history, [...history.present.changes, change])
  }

  const current = history.present.changes[index]
  if (current === undefined || current.after === change.after) return history
  if (current.before === change.after) {
    return update(history, history.present.changes.filter((_, itemIndex) => itemIndex !== index))
  }

  return update(
    history,
    history.present.changes.map((item, itemIndex) => (
      itemIndex === index ? { ...item, after: change.after } : item
    ))
  )
}

export const undo = (history: ChangeHistory): ChangeHistory => {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return {
    present: previous,
    past: history.past.slice(0, -1),
    future: [history.present, ...history.future]
  }
}

export const redo = (history: ChangeHistory): ChangeHistory => {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    present: next,
    past: [...history.past, history.present],
    future: history.future.slice(1)
  }
}

export const removeChange = (
  history: ChangeHistory,
  selector: string,
  property: StyleProperty
): ChangeHistory => {
  const changes = history.present.changes.filter(
    (change) => change.selector !== selector || change.property !== property
  )
  return changes.length === history.present.changes.length ? history : update(history, changes)
}

export const discard = (history: ChangeHistory): ChangeHistory => {
  const present: ChangeRecord = { ...history.present, changes: [], sources: {} }
  return { present, past: [], future: [] }
}
