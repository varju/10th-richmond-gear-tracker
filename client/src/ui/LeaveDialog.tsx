import { useState } from "react";
import { unsaved, useUnsavedState } from "../lib/unsaved";

/** Shown when leaving would lose a draft. Save when the form allows it, Discard, or Keep editing. */
export function LeaveDialog() {
  useUnsavedState();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!unsaved.pending) return null;
  const save = unsaved.save;

  async function saveAndGo() {
    if (!save) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await save()) unsaved.proceed();
      else setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet" role="alertdialog" aria-labelledby="leave-title">
      <h2 id="leave-title">Unsaved changes</h2>
      <p>{save ? "Save them, or leave without them?" : "Leave without them?"}</p>
      {failed && (
        <p className="error" role="alert">
          Could not save. Fix the form, or discard.
        </p>
      )}
      {save && (
        <button className="primary" type="button" onClick={saveAndGo} disabled={saving || !unsaved.canSave}>
          Save
        </button>
      )}
      <button type="button" onClick={() => unsaved.proceed()} disabled={saving}>
        Discard
      </button>
      <button type="button" onClick={() => unsaved.cancel()} disabled={saving}>
        Keep editing
      </button>
    </div>
  );
}
