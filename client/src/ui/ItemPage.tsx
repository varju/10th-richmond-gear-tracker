import { useEffect, useState } from "react";
import { type ItemInput, markMissing, retireItem, unretireItem, updateItem } from "../lib/actions";
import { hasOpenConflict } from "../lib/conflicts";
import { foundFor, resolveFound } from "../lib/found";
import { codesFor, homeLabel, item, typeName } from "../lib/inventory";
import { history, type HistoryEntry } from "../lib/movement";
import { openRepairs, raiseTicket, type Repair, repairsFor, stateLabel } from "../lib/repairs";
import type { Note, State } from "../lib/replay";
import { isOverdue } from "../lib/reports";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { guard, useUnsaved } from "../lib/unsaved";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { ItemFields } from "./ItemFields";
import { statusLabel, userName } from "./labels";
import { CONFIRM_MS, MoveActions, useFlash } from "./MoveActions";
import { AddNote, NoteList } from "./Notes";
import { Page } from "./Page";
import { Photos } from "./Photos";

interface Props {
  store: Store;
  id: string;
}

/** One item: what it is, where it lives, who has it, and what has happened to it (FR-INV-09). */
export function ItemPage({ store, id }: Props) {
  useStore(store);
  const { now } = useShell();
  const openInEdit = useRoute().query.get("edit") === "1";
  const [editing, setEditing] = useState(openInEdit);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [moved, confirm] = useFlash(CONFIRM_MS);
  const state = store.state;
  const it = item(state, id);

  useEffect(() => {
    if (openInEdit) setEditing(true);
  }, [openInEdit]);

  if (!it) {
    return (
      <Page title="Not found" back="/">
        <p>No item with that id. It may not have synced to this phone yet.</p>
      </Page>
    );
  }

  if (editing) {
    return (
      <EditItem
        store={store}
        id={id}
        initial={{
          name: it.name,
          description: it.description ?? "",
          home_location_id: it.home_location_id ?? null,
          sub_location: it.sub_location ?? "",
          type_id: it.type_id ?? null,
          condition: it.condition ?? "",
        }}
        onDone={() => {
          setEditing(false);
          // Drop ?edit=1 so a reload shows the item, not the form.
          if (openInEdit) navigate(`/items/${id}`, true);
        }}
      />
    );
  }

  const codes = codesFor(state, id);
  const current = codes[0];
  const notes = (it.notes ?? []) as Note[];
  const itemNotes = notes.filter((n) => !n.movement_id);
  const onItem = { entity_type: "item", entity_id: id };
  const open = openRepairs(state, id);

  async function retire() {
    if (!confirmRetire) {
      setConfirmRetire(true);
      return;
    }
    await retireItem(store, id);
    setConfirmRetire(false);
  }

  // Lost, not written off (FR-INV-19). The next scan or check-in clears it.
  async function missing() {
    if (!confirmMissing) {
      setConfirmMissing(true);
      return;
    }
    await markMissing(store, id);
    setConfirmMissing(false);
  }

  return (
    <Page
      title="Item"
      back="/"
      actions={
        <>
          <MoveActions store={store} it={it} showEvent onMoved={(kind) => confirm(`${kind} · ${it.name}`)} />
          <div className="row">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" onClick={() => navigate(`/scan?for=${id}`)}>
              Replace code
            </button>
          </div>
          {it.retired ? (
            <button type="button" onClick={() => unretireItem(store, id)}>
              Unretire
            </button>
          ) : (
            <div className="row">
              {!it.missing && (
                <button type="button" className={confirmMissing ? "warn" : ""} onClick={missing}>
                  {confirmMissing ? "Really missing?" : "Mark missing"}
                </button>
              )}
              <button type="button" className={confirmRetire ? "warn" : ""} onClick={retire}>
                {confirmRetire ? "Really retire?" : "Retire"}
              </button>
            </div>
          )}
        </>
      }
    >
      {moved && (
        <p className="confirmed" role="status">
          {moved}
        </p>
      )}
      <h2 className="item-title">
        {it.name}
        {it.retired && <span className="badge">Retired</span>}
        {it.missing && <span className="badge">Missing</span>}
      </h2>
      {it.missing && (
        <p className="notice" role="note">
          Missing. Scanning it or checking it in clears this.
        </p>
      )}
      {hasOpenConflict(state, id) && (
        <p className="notice notice-row" role="note">
          <span>Two check-outs overlapped.</span>
          <button type="button" className="minor" onClick={() => guard(() => navigate("/conflicts"))}>
            Review
          </button>
        </p>
      )}
      {foundFor(state, id).map((r) => (
        <p key={r.id} className="notice found-notice" role="note">
          <span>Reported found · {r.note}</span>
          <button type="button" className="minor" onClick={() => resolveFound(store, r.id)}>
            Resolve
          </button>
        </p>
      ))}
      {open.length > 0 && (
        <p className="notice" role="note">
          Needs repair · {open[0]!.description}
        </p>
      )}
      <dl className="facts">
        <dt>Status</dt>
        <dd>{statusLabel(state, it) + (isOverdue(state, it, now()) ? " · Overdue" : "")}</dd>
        <dt>Home</dt>
        <dd>{homeLabel(state, it) || "—"}</dd>
        <dt>Type</dt>
        <dd>{typeName(state, it.type_id) || "—"}</dd>
        <dt>Condition</dt>
        <dd>{it.condition || "—"}</dd>
        <dt>Description</dt>
        <dd className="prose">{it.description || "—"}</dd>
        <dt>Code</dt>
        <dd>
          {current ? <code>{current.id}</code> : "none"}
          {codes.length > 1 && <span className="muted"> · {codes.length - 1} replaced</span>}
        </dd>
        <dt>Added</dt>
        <dd>{it.added_at ? isoDate(it.added_at) : "—"}</dd>
        <dt>Modified</dt>
        <dd>{it.modified_at ? isoDate(it.modified_at) : "—"}</dd>
      </dl>

      <h3 className="section">Photos</h3>
      <Photos store={store} on={onItem} />

      <h3 className="section">Notes</h3>
      <NoteList store={store} on={onItem} notes={itemNotes} />
      <AddNote store={store} on={onItem} />

      <h3 className="section">Repairs</h3>
      <Repairs store={store} id={id} />

      <h3 className="section">History</h3>
      <History store={store} id={id} />
    </Page>
  );
}

/** "Checked out by Alice for Spring camp · 2026-09-01". */
export function describeMovement(state: State, e: HistoryEntry): string {
  const who = userName(state, e.actor_id);
  const when = isoDate(e.at);
  if (e.type === "checked_in") return `Checked in by ${who} · ${when}`;
  const verb = e.supersedes ? "Transferred to" : "Checked out by";
  return e.event ? `${verb} ${who} for ${e.event} · ${when}` : `${verb} ${who} · ${when}`;
}

/** Every ticket the item has had, open ones first; closed ones stay (FR-REP-04). */
function Repairs({ store, id }: Props) {
  const tickets = repairsFor(store.state, id);
  return (
    <>
      {tickets.length > 0 && (
        <ul className="items">
          {tickets.map((r) => (
            <li key={r.id}>
              <button className="item" type="button" onClick={() => guard(() => navigate(`/repairs/${r.id}`))}>
                <span className="item-name">{describeRepair(r)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ReportFault store={store} id={id} />
    </>
  );
}

/** "Open · zipper broken · 2026-09-01". */
export function describeRepair(r: Repair): string {
  return [stateLabel(r.state), r.description, r.added_at ? isoDate(r.added_at) : ""].filter(Boolean).join(" · ");
}

/** Any signed-in user, a description, nothing else (FR-REP-01, FR-REP-02). */
function ReportFault({ store, id }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft?.trim() ?? "";
  useUnsaved(text !== "", { save: commit });

  async function commit(): Promise<boolean> {
    if (text) await raiseTicket(store, id, text);
    setDraft(null);
    return true;
  }

  if (draft === null) {
    return (
      <button type="button" className="minor" onClick={() => setDraft("")}>
        Report a fault
      </button>
    );
  }
  return (
    <form
      className="note-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <textarea
        aria-label="Fault"
        autoFocus
        rows={2}
        placeholder="e.g. zipper broken on the bag"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="minor primary" disabled={text === ""}>
        Save
      </button>
      <button type="button" className="minor" onClick={() => setDraft(null)}>
        Cancel
      </button>
    </form>
  );
}

function History({ store, id }: Props) {
  const entries = history(store, id);
  return (
    <>
      {entries.length === 0 ? (
        <p className="muted">No movements.</p>
      ) : (
        <ol className="history">
          {entries.map((e) => (
            <li key={e.id}>
              <span>{describeMovement(store.state, e)}</span>
              <NoteList store={store} on={{ entity_type: "item", entity_id: id }} notes={e.notes} />
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">What this phone knows: the last 90 days.</p>
    </>
  );
}

function EditItem({
  store,
  id,
  initial,
  onDone,
}: {
  store: Store;
  id: string;
  initial: ItemInput;
  onDone: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = (Object.keys(values) as (keyof ItemInput)[]).some((k) => values[k] !== initial[k]);
  useUnsaved(dirty, { save: () => apply().then(() => true), canSave: values.name.trim() !== "" });

  async function apply() {
    setSaving(true);
    try {
      await updateItem(store, id, values);
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    await apply();
    onDone();
  }

  return (
    <Page
      title="Edit item"
      actions={
        <>
          <button className="primary" type="button" onClick={save} disabled={saving || values.name.trim() === ""}>
            Save
          </button>
          <button type="button" onClick={() => guard(onDone)}>
            Cancel
          </button>
        </>
      }
    >
      <ItemFields store={store} values={values} onChange={setValues} />
    </Page>
  );
}
