"""The privacy policy, a plain page anyone can open with no sign-in (FR-PUB-07).

Served by the server, not the client: an app store's reviewer, or anyone who never installed
the app, opens it as a link, with no script and no service worker. The text is the same for
every group. The group's name and contact are filled in from its settings when it is asked for.
"""

from html import escape

UPDATED = "12 October 2026"

STYLE = """
:root { color-scheme: dark; }
body { margin: 0; background: #001a70; color: #fff; font: 18px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1rem 16px 3rem; }
h1 { font-size: 1.6rem; margin: 0.5rem 0 0.25rem; }
h2 { font-size: 1.2rem; margin: 1.75rem 0 0.25rem; }
p, li { margin: 0.4rem 0; }
ul { padding-left: 1.25rem; }
a { color: #fff; }
.muted { color: rgba(255, 255, 255, 0.7); }
"""


def page(group: str, contact: str | None) -> str:
    """The whole page. `group` is the group's name, `contact` the address its mail is sent from."""
    who = escape(group) if group else "the group"
    subject = escape(group) if group else "The group"
    if contact:
        ask = f'email <a href="mailto:{escape(contact, quote=True)}">{escape(contact)}</a>'
    else:
        ask = "contact the group's leaders"
    title = f"Privacy · {escape(group)}" if group else "Privacy · Gear Tracker"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{STYLE}</style>
</head>
<body>
<main>
<h1>Privacy</h1>
<p class="muted">Last updated {UPDATED}</p>

<p>{subject} uses Gear Tracker to keep track of its equipment: what it owns, where it is, and who has it.
{subject} runs it, not a company. Its volunteers look after it.</p>

<h2>What we keep</h2>
<ul>
<li>Your account: your name, email address and role. Your password is kept only as a one-way hash, so no one can read
it.</li>
<li>Each check-out, check-in and other change to the gear, with who made it and when.</li>
<li>Notes, repair tickets and photos that members add.</li>
<li>Found-gear reports. Anyone who finds our gear can tell us where it is, with no account. We keep what they type,
including any contact details they give. Every member can see it, and members who asked for found-gear alerts get it
by email.</li>
</ul>
<p>We keep these records for as long as {who} uses Gear Tracker. They are the history of the group's equipment.</p>

<h2>Photos</h2>
<p>We keep photos as they arrive. If your phone saved where a photo was taken, that location may be kept with it. To
stop this, turn off location for your phone's camera.</p>

<h2>On your phone</h2>
<p>The app keeps a copy of the group's records on your phone, so it works with no signal. This includes members' names,
notes and found-gear reports.</p>
<p>When you scan a code, the camera only reads the code. No picture is saved or sent.</p>

<h2>Logs and backups</h2>
<p>The server logs each request: the time, the IP address, the page asked for, and the email address of whoever was
signed in. A failed sign-in is logged with the IP address and the email address tried. Logs are kept for 30 days.</p>
<p>The whole database is backed up each night. Each backup is kept for 30 days.</p>

<h2>Who can see it</h2>
<ul>
<li>Signed-in members of the group see the records. Admins also see members' email addresses.</li>
<li>Members who ask for email alerts get them about found gear, repair tickets and new members.</li>
<li>Someone who scans a code without signing in sees only the group's name and how to contact it.</li>
</ul>

<h2>What we do not do</h2>
<p>No ads, no tracking and no analytics. We do not sell or share your data. The only other services involved are:</p>
<ul>
<li>the group's email provider, which sends invites, password resets and alerts</li>
<li>calendar feeds the group adds. The server fetches them and sends nothing about you.</li>
</ul>

<h2>AI assistants</h2>
<p>A member can connect an AI tool of their own to Gear Tracker. That tool gets what it asks for, as far as that member
is allowed to see: gear, notes and names, for example. The group does not control that tool or what it does with the
data. Gear Tracker itself uses no AI service.</p>

<h2>Young people</h2>
<p>Gear Tracker does not ask for anything about the young people in the group. No field asks for youth data. Please
keep details about youth out of notes.</p>

<h2>Deleting your account</h2>
<p>In the app, go to Settings, then Delete my account. This signs you out, and you cannot sign in again. Your other
devices sign out the next time they connect. Your name stays on the group's records of check-outs, notes, tickets and
photos, because they are the history of the group's equipment. An Admin can restore your access.</p>

<h2>Questions</h2>
<p>To ask about your data, {ask}.</p>
</main>
</body>
</html>
"""
