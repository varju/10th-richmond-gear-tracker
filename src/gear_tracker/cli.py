"""gear-admin: the things that have to happen at the server's keyboard.

Creating the first Admin (FR-USR-13), seeding a fresh instance from its config
file, loading test data into an empty one, exporting and importing the
inventory as a spreadsheet, and getting back in when every Admin has lost
their password.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

from gear_tracker import accounts, derived, inventory, inventory_csv, seed
from gear_tracker.db import open_db
from gear_tracker.errors import ApiError
from gear_tracker.migrate import migrate


def read_password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Again: "):
        raise SystemExit("Passwords do not match.")
    return first


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gear-admin", description="Gear Tracker server administration.")
    parser.add_argument("--db", required=True, help="path to the SQLite file")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create-admin", help="create the first Admin account")
    create.add_argument("--name", required=True)
    create.add_argument("--email", required=True)
    create.add_argument("--password-stdin", action="store_true", help="read the password from stdin")

    reset = sub.add_parser("reset-link", help="print a one-time password reset link token for a user")
    reset.add_argument("--email", required=True)

    apply_seed = sub.add_parser("seed", help="apply a seed file: first Admin, group setting, mail")
    apply_seed.add_argument("--file", required=True, help="path to seed.toml")

    load = sub.add_parser("load", help="load locations and items into a database with no items")
    load.add_argument("--file", required=True, help='"demo" for the bundled file, or a path to one of your own')
    load.add_argument("--as", dest="actor", help="email of the Admin to record it as; the first Admin by default")

    export = sub.add_parser("export", help="write the inventory as a CSV file")
    export.add_argument("--out", help="where to write it; stdout by default")

    do_import = sub.add_parser("import", help="add or change items from a CSV file")
    do_import.add_argument("--file", required=True, help="path to the CSV file")
    do_import.add_argument("--as", dest="actor", help="email of the Admin to record it as; the first Admin by default")
    do_import.add_argument("--dry-run", action="store_true", help="show what would change, and write nothing")

    args = parser.parse_args(argv)
    migrate(args.db)
    with open_db(args.db) as conn:
        try:
            if args.command == "create-admin":
                password = read_password(args)
                if len(password) < 8:
                    print("error: password must be at least 8 characters", file=sys.stderr)
                    return 1
                user_id = accounts.create_admin(conn, args.name, args.email, password)
                print(f"created Admin {args.email} ({user_id})")
            elif args.command == "load":
                actor_id = accounts.user_id_of(conn, args.actor) if args.actor else accounts.first_admin(conn)
                if actor_id is None:
                    print(
                        f"error: no account for {args.actor}" if args.actor else "error: no Admin yet", file=sys.stderr
                    )
                    return 1
                print(inventory.load(conn, inventory.read(args.file), actor_id))
            elif args.command == "export":
                text = inventory_csv.export(derived.snapshot(conn))
                if args.out:
                    Path(args.out).write_text(text)
                    print(f"wrote {args.out}")
                else:
                    print(text)
            elif args.command == "import":
                actor_id = accounts.user_id_of(conn, args.actor) if args.actor else accounts.first_admin(conn)
                if actor_id is None:
                    print(
                        f"error: no account for {args.actor}" if args.actor else "error: no Admin yet", file=sys.stderr
                    )
                    return 1
                text = Path(args.file).read_text()
                if args.dry_run:
                    made = inventory_csv.plan(derived.snapshot(conn), text)
                    print(f"{len(made.adds)} to add, {len(made.changes)} to change, {made.unchanged} unchanged")
                    for name in made.new_locations:
                        print(f"new location: {name}")
                    for name in made.new_categories:
                        print(f"new category: {name}")
                    for error in made.errors:
                        print(f"row {error['row']}: {error['message']}", file=sys.stderr)
                    return 1 if made.errors else 0
                else:
                    done = inventory_csv.apply(conn, text, actor_id)
                    categories = len(done["created_categories"])
                    print(
                        f"added {done['added']}, changed {done['changed']}, "
                        f"created {inventory._count(len(done['created_locations']), 'location')}, "
                        f"{categories} {'category' if categories == 1 else 'categories'}"
                    )
            elif args.command == "seed":
                done = seed.apply(conn, seed.read(args.file))
                print("\n".join(done) if done else "nothing to do")
            else:
                user_id = accounts.user_id_of(conn, args.email)
                if user_id is None:
                    print(f"error: no account for {args.email}", file=sys.stderr)
                    return 1
                # The keyboard is the credential here, so no Admin principal is needed.
                token = accounts._issue_link(conn, user_id, "reset", accounts.now_ms())
                print(token)
        except ApiError as exc:
            print(f"error: {exc.message}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
