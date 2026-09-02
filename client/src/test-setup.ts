// A real IndexedDB implementation in memory, so store tests run the code we ship.
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { PHONE, setWidth } from "./ui/widthTestKit";

// A phone unless a test asks for a desk, whatever width the test DOM defaults to.
beforeEach(() => setWidth(PHONE));
afterEach(cleanup);
