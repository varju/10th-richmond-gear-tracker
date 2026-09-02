/**
 * The device clock is not trusted (NFR-DATA-13). Every response carries
 * server_time; measured against the middle of the round trip, that gives the
 * offset to add to a local reading.
 */
export function measureOffset(serverTime: number, sentAt: number, receivedAt: number): number {
  return serverTime - Math.round((sentAt + receivedAt) / 2);
}

export const DAY_MS = 24 * 3_600_000;

/** How far back a device keeps history (NFR-DATA-03). Matches sync.RETENTION_MS on the server. */
export const RETENTION_MS = 90 * DAY_MS;

/** Unsent this long interrupts on open instead of sitting in the banner (FR-OFF-09). */
export const STALE_PENDING_MS = 3 * DAY_MS;
