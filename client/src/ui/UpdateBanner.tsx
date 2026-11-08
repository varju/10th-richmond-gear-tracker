import { guard } from "../lib/unsaved";
import { update, useUpdateReady } from "../lib/update";

/** `linked` false shows the text alone, while a dialog covers the page. */
export function UpdateBanner({ linked = true }: { linked?: boolean }) {
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      A new version is ready{" "}
      {linked && (
        <button type="button" className="link" onClick={() => guard(update.apply)}>
          Reload
        </button>
      )}
    </div>
  );
}
