import { request, FullConfig } from '@playwright/test';

// The backend the Vite dev server proxies /api/v1 to (see
// frontend/vite.config.ts). Overridable for non-default ports.
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8081';

const ADMIN_USERNAME = 'e2e-admin';
const SEED_BOARD_NAME = 'E2E Board';

// globalSetup runs after Playwright's webServer processes are ready,
// so both the backend and the Vite dev server are reachable here.
//
// The specs each register a fresh user through the login screen. That
// only works when:
//   1. the users table has a first admin (otherwise /auth/login with an
//      unknown username is rejected), and
//   2. at least one *public* board exists (the SPA's post-login
//      redirect sends the user to /board/:id only when boardsApi.getAll()
//      returns something).
//
// Seed both through the real API so the fixture stays in sync with the
// backend's own bootstrap rules.
async function globalSetup(_config: FullConfig) {
  const api = await request.newContext({ baseURL: BACKEND_URL });

  try {
    // Always sign in so the request context carries the auth cookie for
    // the board bootstrap below. On a fresh database this call also
    // creates the first user, who is promoted to ADMIN — the specs then
    // register their own throwaway users via the UI login screen.
    const login = await api.post('/api/v1/auth/login', {
      data: { username: ADMIN_USERNAME },
    });
    if (!login.ok()) {
      throw new Error(
        `e2e seed: failed to create/login admin user (${login.status()} ${await login.text()})`,
      );
    }

    const boards = await api.get('/api/v1/boards');
    const boardList = boards.ok() ? await boards.json().catch(() => []) : [];
    if (!Array.isArray(boardList) || boardList.length === 0) {
      const created = await api.post('/api/v1/boards', {
        data: { name: SEED_BOARD_NAME, isPublic: true },
      });
      if (!created.ok()) {
        throw new Error(
          `e2e seed: failed to create seed board (${created.status()} ${await created.text()})`,
        );
      }
    }
  } finally {
    await api.dispose();
  }
}

export default globalSetup;
