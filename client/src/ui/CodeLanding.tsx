import { useEffect } from "react";
import { code as codeOf, codeStatus } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

/**
 * Where a scan and a sticker's URL both land: /g/<code>. A code on an item
 * opens the item (FR-TAG-05, FR-TAG-06); an unassigned one offers
 * create-or-bind (FR-TAG-07).
 */
export function CodeLanding({ store, code }: { store: Store; code: string }) {
  useStore(store);
  const status = codeStatus(store.state, code);
  const itemId = codeOf(store.state, code)?.item_id;

  useEffect(() => {
    if ((status === "assigned" || status === "replaced") && itemId) navigate(`/items/${itemId}`, true);
  }, [status, itemId]);

  const scanAgain = (
    <button type="button" onClick={() => navigate("/scan")}>
      Scan again
    </button>
  );

  if (status === "unassigned") {
    return (
      <Page
        title="New code"
        back="/"
        actions={
          <>
            <button type="button" className="primary" onClick={() => navigate(`/items/new?code=${code}`)}>
              Create a new item
            </button>
            <button type="button" className="primary" onClick={() => navigate(`/bind/${code}`)}>
              Put it on an existing item
            </button>
            {scanAgain}
          </>
        }
      >
        <p className="big code">{code}</p>
        <p className="muted">This code is not on anything yet.</p>
      </Page>
    );
  }

  if (status === "unknown") {
    return (
      <Page title="Not one of our codes" back="/" actions={scanAgain}>
        <p className="big code">{code}</p>
        <p className="muted">If it was just printed, sync first.</p>
      </Page>
    );
  }

  return null;
}
