import { useEffect, useState } from "react";
import {
  addUnit,
  type ItemInput,
  makeGeneric,
  markMissing,
  mergeItem,
  moveUnit,
  retireItem,
  unmergeItem,
  unretireItem,
  updateItem,
  updateUnit,
} from "../lib/actions";
import { changes } from "../lib/audit";
import { hasOpenConflict } from "../lib/conflicts";
import { foundFor, resolveFound } from "../lib/found";
import {
  aliases,
  codesFor,
  displayName,
  generics,
  homeLabel,
  type Item,
  item,
  nameOf,
  numberTaken,
  parentOf,
  search,
  unitsOf,
} from "../lib/inventory";
import type { HistoryEntry } from "../lib/movement";
import { openRepairs, raiseTicket, type Repair, repairsFor, stateLabel } from "../lib/repairs";
import type { Note, State } from "../lib/replay";
import { isOverdue } from "../lib/reports";
import { navigate, useRoute } from "../lib/router";
import { timeline } from "../lib/timeline";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { guard, useUnsaved } from "../lib/unsaved";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { HomeFields, ItemFields, SEVERAL } from "./ItemFields";
import { boughtLabel, plural, statusLabel, userName } from "./labels";
import { CONFIRM_MS, MoveActions, useFlash } from "./MoveActions";
import { AddNote, NoteLine, NoteList } from "./Notes";
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
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moved, confirm] = useFlash(CONFIRM_MS);
  const state = store.state;
  const it = item(state, id);
  const admin = store.meta.user?.role === "admin";

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
        retired={Boolean(it.retired)}
        it={it}
        initial={{
          name: it.name ?? "",
          description: it.description ?? "",
          home_location_id: it.home_location_id ?? null,
          sub_location: it.sub_location ?? "",
          purchase_date: it.purchase_date ?? "",
          price: it.price ?? "",
          supplier: it.supplier ?? "",
        }}
        onDone={() => {
          setEditing(false);
          // Drop ?edit=1 so a reload shows the item, not the form.
          if (openInEdit) navigate(`/items/${id}`, true);
        }}
      />
    );
  }

  if (moving) {
    return <MovePicker store={store} id={id} onDone={() => setMoving(false)} />;
  }

  if (merging) {
    return (
      <MergePicker
        store={store}
        id={id}
        onDone={(survivor) => {
          setMerging(false);
          if (survivor) navigate(`/items/${survivor}`, true);
        }}
      />
    );
  }

  const codes = codesFor(state, id);
  const current = codes[0];
  const onItem = { entity_type: "item", entity_id: id };
  const open = openRepairs(state, id);
  const mergedFrom = aliases(state, id).slice(1);

  if (it.merged_into) {
    // A folded duplicate. Its record stays readable; the survivor does everything else (FR-INV-13).
    const survivor = item(state, it.merged_into);
    return (
      <Page
        title="Item"
        back="/"
        actions={
          admin ? (
            <button type="button" onClick={() => unmergeItem(store, id)}>
              Unmerge
            </button>
          ) : undefined
        }
      >
        <h2 className="item-title">
          {displayName(state, it)}
          <span className="badge">Merged</span>
        </h2>
        <p className="notice" role="note">
          Merged into{" "}
          <button className="link" type="button" onClick={() => navigate(`/items/${it.merged_into}`)}>
            {survivor ? displayName(state, survivor) : "(unknown item)"}
          </button>
        </p>
        <h3 className="section">History</h3>
        <History store={store} id={id} />
        <h3 className="section">Changes</h3>
        <Changes store={store} id={id} />
      </Page>
    );
  }

  if (it.generic) {
    // A name several things share: no code, no movements, no missing (FR-INV-21).
    return (
      <GenericPage
        store={store}
        it={it}
        onEdit={() => setEditing(true)}
        photos={<Photos store={store} on={onItem} />}
        changes={<Changes store={store} id={id} />}
      />
    );
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
          <MoveActions
            store={store}
            it={it}
            showEvent
            onMoved={(kind) => confirm(`${kind} · ${displayName(state, it)}`)}
          />
          <div className="row">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" onClick={() => navigate(`/scan?for=${id}`)}>
              Replace code
            </button>
          </div>
          {/* Retiring is rare and lives at the foot of Edit. Missing is not: gear goes astray weekly. */}
          {!it.retired && !it.missing && (
            <button type="button" className={confirmMissing ? "warn" : ""} onClick={missing}>
              {confirmMissing ? "Really missing?" : "Mark missing"}
            </button>
          )}
          {it.parent_id && !it.retired && (
            <button type="button" className="minor" onClick={() => setMoving(true)}>
              Move to another generic…
            </button>
          )}
          {admin && !it.retired && it.status === "in" && (
            <button type="button" className="minor" onClick={() => setMerging(true)}>
              Merge into another item…
            </button>
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
        {displayName(state, it)}
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
        {it.parent_id && (
          <>
            <dt>One of</dt>
            <dd>
              <button className="link" type="button" onClick={() => guard(() => navigate(`/items/${it.parent_id}`))}>
                {parentOf(state, it)?.name ?? "(unknown item)"}
              </button>
              {` · #${it.number ?? "?"}`}
              {it.nickname ? ` · ${it.nickname}` : ""}
            </dd>
          </>
        )}
        <dt>Description</dt>
        <dd className="prose">{it.description || "—"}</dd>
        <dt>Bought</dt>
        <dd>{boughtLabel(it) || "—"}</dd>
        {mergedFrom.length > 0 && (
          <>
            <dt>Merged from</dt>
            <dd>{mergedFrom.map((a) => nameOf(state, a)).join(", ")}</dd>
          </>
        )}
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

      <h3 className="section">Repairs</h3>
      <Repairs store={store} id={id} />

      <h3 className="section">History</h3>
      <History store={store} id={id} />
      <AddNote store={store} on={onItem} />

      <h3 className="section">Changes</h3>
      <Changes store={store} id={id} />
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

/** Movements and notes in one list, newest first. A note made on a movement sits under it. */
function History({ store, id }: Props) {
  const entries = timeline(store, id);
  const on = { entity_type: "item", entity_id: id };
  return (
    <>
      {entries.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ol className="history">
          {entries.map((e) =>
            e.kind === "movement" ? (
              <li key={e.id}>
                <span>{describeMovement(store.state, e.movement)}</span>
                <NoteList store={store} on={on} notes={e.movement.notes} />
              </li>
            ) : (
              <NoteLine key={e.id} store={store} on={on} note={e.note} />
            ),
          )}
        </ol>
      )}
      <p className="muted small">What this phone knows: the last 90 days.</p>
    </>
  );
}

/** What changed on the record, from what to what, by whom (FR-USR-09). */
function Changes({ store, id }: Props) {
  const entries = changes(store, id);
  const state = store.state;
  return (
    <>
      {entries.length === 0 ? (
        <p className="muted">No changes.</p>
      ) : (
        <ol className="history">
          {entries.map((c) => (
            <li key={c.id}>
              {c.kind === "created"
                ? `Created · ${userName(state, c.actor_id)} · ${isoDate(c.at)}`
                : `${c.label}: ${c.old} → ${c.new} · ${userName(state, c.actor_id)} · ${isoDate(c.at)}`}
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">What this phone knows: the last 90 days.</p>
    </>
  );
}

/**
 * Pick the item this one doubles, then confirm (FR-INV-13). The list is the normal search, less this item;
 * merged and retired items are already out of it.
 */
function MergePicker({ store, id, onDone }: { store: Store; id: string; onDone: (survivor?: string) => void }) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = store.state;
  const me = item(state, id);
  const survivor = chosen ? item(state, chosen) : undefined;
  const candidates = search(state, { query }).filter((c) => c.id !== id);
  const myName = me ? displayName(state, me) : "";

  async function merge() {
    if (!chosen) return;
    try {
      await mergeItem(store, id, chosen);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not merge");
      return;
    }
    onDone(chosen);
  }

  if (survivor) {
    return (
      <Page
        title="Merge"
        actions={
          <>
            <button type="button" className="warn" onClick={merge}>
              Merge
            </button>
            <button type="button" onClick={() => setChosen(null)}>
              Cancel
            </button>
          </>
        }
      >
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p>
          Merge {myName} into {displayName(state, survivor)}?
        </p>
        <p className="muted">
          {myName} disappears from the list. Its stickers, movements and tickets go with {displayName(state, survivor)}.
          This can be undone from {myName}’s page.
        </p>
      </Page>
    );
  }

  return (
    <Page
      title="Merge into"
      actions={
        <>
          <label className="tight">
            <span>Search</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
          <button type="button" onClick={() => onDone()}>
            Cancel
          </button>
        </>
      }
    >
      <p className="muted">Which item does {myName} double?</p>
      <ul className="items">
        {candidates.map((c) => (
          <li key={c.id}>
            <button className="item" type="button" onClick={() => setChosen(c.id)}>
              <span className="item-name">{displayName(state, c)}</span>
              <span className="muted small">{homeLabel(state, c)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}

/**
 * One form for all three shapes. A unit edits its number and nickname where an
 * item edits its name; a single item can be turned into a generic here
 * (FR-INV-26), and the tick asks once before it happens.
 */
function EditItem({
  store,
  id,
  it,
  initial,
  retired,
  onDone,
}: {
  store: Store;
  id: string;
  it: Item;
  initial: ItemInput;
  retired: boolean;
  onDone: () => void;
}) {
  const unit = Boolean(it.parent_id);
  const [values, setValues] = useState(initial);
  const [number, setNumber] = useState(String(it.number ?? ""));
  const [nickname, setNickname] = useState(it.nickname ?? "");
  const [nowRetired, setNowRetired] = useState(retired);
  const [several, setSeveral] = useState(false);
  const [asked, setAsked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number.parseInt(number, 10);
  const named = (values.name ?? "").trim() !== "";
  const numbered = n > 0 && !numberTaken(store.state, it.parent_id ?? "", n, id);
  const canSave = unit ? numbered : named;
  const dirty =
    nowRetired !== retired ||
    several ||
    (unit && (number !== String(it.number ?? "") || nickname !== (it.nickname ?? ""))) ||
    (Object.keys(values) as (keyof ItemInput)[]).some((k) => values[k] !== initial[k]);
  useUnsaved(dirty, { save: () => apply().then((ok) => ok), canSave });

  async function apply(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      if (unit) await updateUnit(store, id, { number: n, nickname: nickname.trim() || null });
      await updateItem(store, id, unit ? withoutName(values) : values);
      if (several) await makeGeneric(store, id);
      if (nowRetired !== retired) await (nowRetired ? retireItem : unretireItem)(store, id);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    // Turning one item into several is not an edit to undo; ask before it happens.
    if (several && !asked) {
      setAsked(true);
      return;
    }
    if (await apply()) onDone();
  }

  return (
    <Page
      title={unit ? "Edit unit" : it.generic ? "Edit generic" : "Edit item"}
      actions={
        <>
          <button className={asked ? "warn" : "primary"} type="button" onClick={save} disabled={saving || !canSave}>
            {asked ? "Yes, make it several" : "Save"}
          </button>
          <button type="button" onClick={() => guard(onDone)}>
            Cancel
          </button>
        </>
      }
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {unit ? (
        <>
          <label>
            <span>Number</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </label>
          {n > 0 && !numbered && <p className="error">#{n} is already used here. Pick another.</p>}
          <label>
            <span>Nickname (optional)</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} autoComplete="off" />
          </label>
          <HomeFields
            store={store}
            home_location_id={values.home_location_id ?? null}
            sub_location={values.sub_location ?? ""}
            onChange={(patch) => setValues({ ...values, ...patch })}
          />
          <label>
            <span>Description</span>
            <textarea
              value={values.description ?? ""}
              onChange={(e) => setValues({ ...values, description: e.target.value })}
              rows={3}
            />
          </label>
        </>
      ) : (
        <ItemFields store={store} values={values} onChange={setValues} generic={it.generic || several} />
      )}
      {!unit && !it.generic && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={several}
              onChange={(e) => {
                setSeveral(e.target.checked);
                setAsked(false);
              }}
            />
            <span>{SEVERAL}</span>
          </label>
          {several && (
            <p className="notice" role="note">
              {(values.name ?? "").trim()} becomes a name for several, and this one becomes #1 under it. Its code,
              movements and tickets stay where they are.
            </p>
          )}
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={nowRetired} onChange={(e) => setNowRetired(e.target.checked)} />
        <span>Retired</span>
      </label>
      <p className="muted small">
        {it.generic
          ? "A generic can be retired once every unit is (FR-INV-27)."
          : "A retired item keeps its record and its history, but drops off the list and cannot be checked out."}
      </p>
    </Page>
  );
}

/** A unit has no name of its own, so an edit must not write one. */
function withoutName(values: ItemInput): Partial<ItemInput> {
  const { name, ...rest } = values;
  return rest;
}

/**
 * A generic: the shared fields, its units and what each is doing, and one tap
 * to add another (FR-INV-21, FR-INV-22). No code, no movements, no missing.
 */
function GenericPage({
  store,
  it,
  onEdit,
  photos,
  changes,
}: {
  store: Store;
  it: Item;
  onEdit: () => void;
  photos: React.ReactNode;
  changes: React.ReactNode;
}) {
  const state = store.state;
  const [error, setError] = useState<string | null>(null);
  const units = unitsOf(state, it.id);
  const live = units.filter((u) => !u.retired);

  async function add() {
    try {
      const id = await addUnit(store, it.id);
      navigate(`/items/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add a unit");
    }
  }

  return (
    <Page
      title="Item"
      back="/"
      actions={
        <>
          <button className="primary" type="button" onClick={() => void add()}>
            Add a unit
          </button>
          <button type="button" onClick={onEdit}>
            Edit
          </button>
        </>
      }
    >
      <h2 className="item-title">
        {it.name}
        <span className="badge">Several</span>
        {it.retired && <span className="badge">Retired</span>}
      </h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <dl className="facts">
        <dt>Units</dt>
        <dd>{`${plural(live.length, "unit")} · ${live.filter((u) => u.status === "in" && !u.missing).length} in`}</dd>
        <dt>Default home</dt>
        <dd>{homeLabel(state, it) || "—"}</dd>
        <dt>Description</dt>
        <dd className="prose">{it.description || "—"}</dd>
        <dt>Bought</dt>
        <dd>{boughtLabel(it) || "—"}</dd>
        <dt>Added</dt>
        <dd>{it.added_at ? isoDate(it.added_at) : "—"}</dd>
      </dl>

      <h3 className="section">Units</h3>
      {units.length === 0 ? (
        <p className="muted">None yet. Add one, or scan a code and pick this one.</p>
      ) : (
        <ul className="items">
          {units.map((u) => (
            <li key={u.id}>
              <button className="item" type="button" onClick={() => guard(() => navigate(`/items/${u.id}`))}>
                <span>
                  <span className="item-name">{displayName(state, u)}</span>
                  {openRepairs(state, u.id).length > 0 && <span className="badge">Repair</span>}
                  {u.missing && <span className="badge">Missing</span>}
                  {u.retired && <span className="badge">Retired</span>}
                </span>
                <span className="muted small">{statusLabel(state, u)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="section">Photos</h3>
      {photos}

      <h3 className="section">Changes</h3>
      {changes}
    </Page>
  );
}

/** File a unit under a different generic (FR-INV-28). Its history goes with it. */
function MovePicker({ store, id, onDone }: { store: Store; id: string; onDone: () => void }) {
  const state = store.state;
  const [error, setError] = useState<string | null>(null);
  const it = item(state, id);
  const choices = generics(state).filter((g) => !g.retired && g.id !== it?.parent_id);

  async function move(parentId: string) {
    try {
      await moveUnit(store, id, parentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move it");
      return;
    }
    onDone();
  }

  return (
    <Page
      title="Move to another generic"
      actions={
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      }
    >
      <p className="muted">
        {it ? displayName(state, it) : ""} keeps its code, its movements and its tickets. A number already used under
        the new generic is bumped to the next free one.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="items">
        {choices.map((g) => (
          <li key={g.id}>
            <button className="item" type="button" onClick={() => void move(g.id)}>
              <span className="item-name">{g.name}</span>
              <span className="muted small">{plural(unitsOf(state, g.id).length, "unit")}</span>
            </button>
          </li>
        ))}
        {choices.length === 0 && <li className="muted">No other generic items yet.</li>}
      </ul>
    </Page>
  );
}
