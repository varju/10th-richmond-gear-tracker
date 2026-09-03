import { expect, test } from "vitest";
import { ApiError, createApi } from "./api";

const T0 = 1_756_684_800_000;

test("a response with no server_time (an unhandled error, or a framework's own 404) gives no offset", async () => {
  const fetch = async () => new Response(JSON.stringify({ detail: "Internal Server Error" }), { status: 500 });
  const api = createApi({ fetch, now: () => T0 });

  let caught: ApiError | undefined;
  try {
    await api.bootstrap();
  } catch (error) {
    caught = error as ApiError;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught?.status).toBe(500);
  expect(caught?.offset).toBeUndefined();
});

test("a non-JSON body (a proxy's HTML error page) is treated as empty, not a thrown SyntaxError", async () => {
  const fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
  const api = createApi({ fetch, now: () => T0 });

  await expect(api.bootstrap()).rejects.toMatchObject({ status: 502, message: "Bad Gateway" });
});

test("a normal response with server_time still yields an offset", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ snapshot: {}, cursor: 0, log_id: "log-one", server_time: T0 + 60_000 }), {
      status: 200,
    });
  const api = createApi({ fetch, now: () => T0 });

  const { offset } = await api.bootstrap();
  expect(offset).toBe(60_000);
});

test("every response carries the round trip it took, offset or not", async () => {
  let calls = 0;
  const now = () => T0 + (calls++ === 0 ? 0 : 40);
  const fetch = async () =>
    new Response(JSON.stringify({ snapshot: {}, cursor: 0, log_id: "log-one" }), { status: 200 });
  const api = createApi({ fetch, now });

  const { round_trip } = await api.bootstrap();
  expect(round_trip).toBe(40);
});

test("push sends round_trip_ms only when given", async () => {
  let body: Record<string, unknown> = {};
  const fetch = async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ accepted: [], rejected: [] }), { status: 200 });
  };
  const api = createApi({ fetch: fetch as typeof globalThis.fetch, now: () => T0 });

  await api.push("device-a", T0, []);
  expect(body.round_trip_ms).toBeUndefined();

  await api.push("device-a", T0, [], 250);
  expect(body.round_trip_ms).toBe(250);
});
