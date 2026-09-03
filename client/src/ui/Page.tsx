import { type ReactNode, useEffect, useState } from "react";
import { useWide } from "../lib/wide";
import { leaveBack } from "../lib/unsaved";
import { navigate, useRoute } from "../lib/router";
import { useShell } from "../shell";
import { Sections } from "./Sections";

interface Props {
  title: string;
  /** Where back goes on a cold load, when there is no in-app history. None means no back button. */
  back?: string;
  children: ReactNode;
  /** Buttons for the lower half of the screen (NFR-USE-03). */
  actions?: ReactNode;
}

/**
 * Every screen: header, scrolling body, actions at the thumb. The header
 * carries back where there is a step back, the title (which also goes home),
 * and the menu button. The desk keeps the sections in its sidebar instead, so
 * its header has no menu of its own.
 */
export function Page({ title, back, children, actions }: Props) {
  const { store } = useShell();
  const wide = useWide();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const menu = Boolean(store) && !wide;

  // A link followed from the menu must land on that screen with the menu closed.
  useEffect(() => setOpen(false), [route.path]);

  return (
    <>
      <header>
        {back !== undefined && (
          <button className="back" type="button" onClick={() => leaveBack(back)} aria-label="Back">
            ‹
          </button>
        )}
        {store ? (
          <h1>
            <button className="title" type="button" onClick={() => navigate("/")}>
              {title}
            </button>
          </h1>
        ) : (
          <h1>{title}</h1>
        )}
        {menu && (
          <button
            className="corner"
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Menu"}
          >
            {open ? "✕" : "☰"}
          </button>
        )}
      </header>
      <main>{menu && open ? <Sections store={store!} layout="menu" /> : children}</main>
      {!(menu && open) && actions && <div className="actions">{actions}</div>}
    </>
  );
}
