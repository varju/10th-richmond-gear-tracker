# Assistant

## Connect an assistant

Open Settings and tap Connect an assistant. The token is shown once, so copy it before you tap Done. Point your
assistant at `https://your-site/gear/mcp` and send the token as the header `Authorization: Bearer <token>`.

## What you can ask for

Ask what we own, where it lives, who has it, and what is broken. It can book a camp, add and edit gear, raise and answer
tickets, and check gear out and in. It tells you about a clash the way the app does, and does not save over it.

## What it will not do

For a User, nothing an Admin does. If you are an Admin, that work is here too: people, mail, group settings, locations,
renaming or deleting categories, printing codes, importing a CSV, deleting an item, and merging duplicates. It refuses
anyone else the same way the app does. It also needs a connection, so it is no use in the yard.

## Revoke it

The assistant sits in your device list beside your own device. Revoke it there and the token stops working at once, the
same as a lost device.
