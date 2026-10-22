import { DESK, DESK2, LANDING, TERMINAL } from './tests/urls';

// The stack must already be up (./stack.sh); fail loudly instead of testing half a stack.
export default async function globalSetup() {
  for (const url of [LANDING, TERMINAL, `${DESK}/api/info`, `${DESK2}/api/info`]) {
    const res = await fetch(url).catch((e: Error) => {
      throw new Error(`Setup required: ${url} is not running (${e.message}). Start it with e2e/stack.sh`);
    });
    if (!res.ok) throw new Error(`Setup required: ${url} answered HTTP ${res.status}`);
  }
}
