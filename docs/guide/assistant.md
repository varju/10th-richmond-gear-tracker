# AI assistant

An AI assistant that speaks MCP (Model Context Protocol) can work the inventory for you: ask it questions, or have it
book a camp or check gear out. It acts as you, with what you are allowed to do.

## Connect an assistant

Open **Settings** > **AI assistant** and tap **Connect an assistant**. The token is shown once, so copy it before you
tap **Done**. Point your assistant at `https://your-site/gear/mcp` and send the token as the header
`Authorization: Bearer <token>`.

## What it can do

Anything your role lets you do in the app, except delete your account. Ask what we own, who has it, and what is broken;
have it book a camp, add gear, or check gear out. It names a clash the way the app does, and does not save over it. It
needs a connection, so it is no use in the yard.

## Revoke it

The assistant sits in **Settings** > **Your devices** beside your own device. Tap **Revoke** there and the token stops
working at once, the same as a lost device.
