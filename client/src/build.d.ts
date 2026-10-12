/** The commit this build is from, baked in by vite.config.ts. "dev" outside a `make image` build. */
declare const __GIT_SHA__: string;
/** The server's address in the iPhone app's build; "" in the web build. Read it through lib/server.ts. */
declare const __SERVER_URL__: string;
