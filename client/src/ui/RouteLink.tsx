import type { ComponentProps } from "react";
import { hrefOf } from "../lib/router";
import { NATIVE } from "../lib/server";
import { guard, leave } from "../lib/unsaved";

type Props = Omit<ComponentProps<"a">, "href" | "onClick"> & {
  to: string;
  replace?: boolean;
  /** Does the going, for a tap that also has to move the focus. */
  go?: () => void;
  native?: boolean;
};

/**
 * A way to another screen: a real link on the website, so it can open in a new
 * tab or window, and a button in the app. Styled by the same rules either way.
 */
export function RouteLink({ to, replace, go, native = NATIVE, className = "link", children, ...rest }: Props) {
  const open = () => (go ? guard(go) : leave(to, replace));
  if (native) {
    return (
      <button {...(rest as ComponentProps<"button">)} className={className} type="button" onClick={open}>
        {children}
      </button>
    );
  }
  return (
    <a
      {...rest}
      className={`btn ${className}`.trim()}
      href={hrefOf(to)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open();
      }}
    >
      {children}
    </a>
  );
}
