import { useEffect } from "react";
import { seen } from "../lib/actions";
import { code as codeOf, codeStatus, resolveItem } from "../lib/inventory";
import { back, navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

/**
 * Where a scan and a sticker's URL both land: /g/<code>. A code on an item
 * opens the item (FR-TAG-05, FR-TAG-06); an unassigned one offers
 * create-or-bind (FR-TAG-07), or another of something we have several of
 * (FR-INV-24, S-BOOT-03).
 *
 * A junction, not a stop. Every way out of it replaces this entry, so back
 * from the next screen returns to the scanner, not to the code again.
 */
export function CodeLanding({ store, code }: { store: Store; code: string }) {
  useStore(store);
  const state = store.state;
  const status = codeStatus(state, code);
  // A sticker on a merged duplicate opens the survivor (FR-INV-13).
  const bound = codeOf(state, code)?.item_id;
  const itemId = bound ? resolveItem(state, bound) : undefined;

  useEffect(() => {
    if ((status === "assigned" || status === "replaced") && itemId) {
      void seen(store, itemId);
      navigate(`/items/${itemId}`, true);
    }
  }, [store, status, itemId]);

  const scanAgain = (
    <button type="button" onClick={() => back("/scan")}>
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
            <button type="button" className="primary" onClick={() => navigate(`/another/${code}`, true)}>
              Another of…
            </button>
            <button type="button" onClick={() => navigate(`/items/new?code=${code}`, true)}>
              Create a new item
            </button>
            <button type="button" onClick={() => navigate(`/bind/${code}`, true)}>
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
