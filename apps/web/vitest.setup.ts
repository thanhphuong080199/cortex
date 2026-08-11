// Registers jest-dom's matchers (toBeInTheDocument, etc.) on vitest's `expect`. Safe to load
// for every suite, including the node-environment ones: it only extends `expect`, it never
// touches `document` at import time, so it is a no-op for suites that never render anything.
import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's own auto-cleanup only self-registers when it finds a global
// `afterEach` (true under Jest, and under vitest only with `test.globals: true`). This config
// deliberately doesn't set `globals: true` -- so without this, every render from a prior test
// stays mounted in `document.body`, and `screen.getByRole(...)` starts matching more than one
// element the moment a suite has two tests that each render the same component.
afterEach(cleanup);
