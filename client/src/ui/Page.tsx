import type { ReactNode } from "react";
import { leave } from "../lib/unsaved";

interface Props {
  title: string;
  /** Where the back button goes. None means no back button. */
  back?: string;
  children: ReactNode;
  /** Buttons for the lower half of the screen (NFR-USE-03). */
  actions?: ReactNode;
}

/** Every screen: header, scrolling body, actions at the thumb. */
export function Page({ title, back, children, actions }: Props) {
  return (
    <>
      <header>
        {back !== undefined && (
          <button className="back" type="button" onClick={() => leave(back)} aria-label="Back">
            ‹
          </button>
        )}
        <h1>{title}</h1>
      </header>
      <main>{children}</main>
      {actions && <div className="actions">{actions}</div>}
    </>
  );
}
