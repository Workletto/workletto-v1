// Forms with changes that aren't saved yet (every form built on useSaveForm). Leaving the page, or
// moving to another page of the app, asks first.

const dirtyForms = new Set<object>();

/** A form says whether it has unsaved changes. */
export function setFormDirty(form: object, dirty: boolean) {
  if (dirty) dirtyForms.add(form);
  else dirtyForms.delete(form);
}

export const hasUnsavedChanges = () => dirtyForms.size > 0;

/** True when the person may leave: nothing is unsaved, or they chose to leave anyway. */
export function confirmLeave(): boolean {
  return !hasUnsavedChanges() || window.confirm("Leave without saving your changes?");
}

if (typeof window !== "undefined") {
  // Closing the tab, reloading or typing another address: the browser asks in its own words.
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
