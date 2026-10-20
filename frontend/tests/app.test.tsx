import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';
import { api, ApiError } from '../src/api';

const BASE = 'http://127.0.0.1:3200/api/v1';
const raw = async (method: string, path: string, _session?: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers['X-CSRF-Token'] = (await (await fetch(BASE + '/auth/csrf', { credentials: 'include' })).json()).csrfToken;
  }
  const response = await fetch(BASE + path, { method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const tokenFor = async (user: string) => {
  const result = await raw('POST', '/auth/login', undefined, { email: `${user}@demo.test`, password: 'demo-local-only' });
  if (result.status !== 200) throw new Error(`Could not sign in test account ${user}: ${result.status}`);
  return `cookie-session:${user}`;
};
const session = async (user: string) => tokenFor(user);
const platformId = async (tok: string) => (await raw('GET', '/teams', tok)).body.data.find((t: { slug: string }) => t.slug === 'platform').id as number;
const mkItem = async (tok: string, title: string, extra: Record<string, unknown> = {}) => (await raw('POST', '/items', tok, { title, teamId: await platformId(tok), ...extra })).body;
const view = (path: string) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
const uniq = (p: string) => `${p} ${Math.random().toString(36).slice(2, 8)}`;

describe('login', () => {
  it('shows an error for invalid credentials and stays on the login screen', async () => {
    const u = userEvent.setup(); view('/login');
    await u.type(screen.getByLabelText('Password'), 'wrong-password'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(sessionStorage.getItem('token')).toBeNull();
  });
  it('logs in against the real API and lands on the dashboard with real data', async () => {
    const u = userEvent.setup(); view('/login');
    await u.type(screen.getByLabelText('Password'), 'demo-local-only'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Operational overview' })).toBeInTheDocument();
    expect(sessionStorage.getItem('token')).toBeNull();
    const s = (await raw('GET', '/dashboard/summary')).body;
    expect(await screen.findByRole('button', { name: /Assigned to me/ })).toHaveTextContent(String(s.assignedToMe));
    expect(screen.getByRole('button', { name: /Overdue/ })).toHaveTextContent(String(s.overdue));
    expect(await screen.findAllByText(/^OPS-\d{5}$/)).not.toHaveLength(0);
  });
  it('shows a clear message when sign-in is throttled after repeated failures', async () => {
    const email = `lock-${Math.random().toString(36).slice(2, 8)}@demo.test`;
    for (let i = 0; i < 10; i++) await raw('POST', '/auth/login', undefined, { email, password: 'bad' });
    const u = userEvent.setup(); view('/login'); await u.clear(screen.getByLabelText('Email')); await u.type(screen.getByLabelText('Email'), email);
    await u.type(screen.getByLabelText('Password'), 'bad'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Too many failed sign-in attempts/)).toBeInTheDocument(); expect(sessionStorage.getItem('token')).toBeNull();
  });
  it('redirects unauthenticated visitors to login', async () => { view('/'); expect(await screen.findByRole('heading', { name: /Operations under pressure/ })).toBeInTheDocument(); });
});

describe('dashboard', () => {
  it('opens the command center with Ctrl+K and keeps creation actions permission-aware', async () => {
    await session('viewer'); const u = userEvent.setup(); view('/');
    await screen.findByRole('heading', { name: 'Operational overview' });
    await u.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Command center' });
    expect(within(dialog).getByRole('button', { name: /Work dashboard/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Teams/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Create a work item' })).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: /Teams/ }));
    expect(await screen.findByRole('heading', { name: 'Teams' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await screen.findByRole('dialog', { name: 'Command center' });
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command center' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Search or jump to/ })).toHaveFocus();
  });
  it('searches real, access-scoped work items from the command center', async () => {
    const tok = await session('member'); const title = uniq('Palette search'); await mkItem(tok, title);
    const u = userEvent.setup(); view('/');
    await screen.findByRole('heading', { name: 'Operational overview' });
    await u.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Command center' });
    await u.type(within(dialog).getByRole('textbox', { name: 'Search work items or commands' }), title);
    await screen.findByRole('button', { name: new RegExp(title) });
    await u.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });
  it('saves and reapplies browser-local filters', async () => {
    await session('member'); const u = userEvent.setup(); const rendered = view('/');
    await screen.findByRole('heading', { name: 'Operational overview' });
    await u.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    await u.type(screen.getByLabelText('Name this filter view'), 'Urgent queue');
    await u.click(screen.getByRole('button', { name: 'Save current filters' }));
    expect(await screen.findByText('Saved “Urgent queue” on this browser')).toBeInTheDocument();
    rendered.unmount();
    view('/');
    await screen.findByRole('heading', { name: 'Operational overview' });
    const views = screen.getByLabelText('Saved views');
    const savedOption = within(views).getByRole('option', { name: 'Urgent queue' }) as HTMLOptionElement;
    await u.selectOptions(views, savedOption.value);
    expect(screen.getByLabelText('Priority')).toHaveValue('URGENT');
  });
  it('filters the queue when a workflow status is selected in the Operations Core', async () => {
    await session('member'); const u = userEvent.setup(); view('/');
    await screen.findAllByText(/^OPS-\d{5}$/);
    await u.click(screen.getByRole('button', { name: /OPEN/ }));
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('OPEN'));
    await waitFor(() => {
      const rows = screen.getAllByRole('row').slice(1);
      rows.forEach((row) => expect(row).toHaveTextContent('Open'));
    });
  });
  it('search is sent to the server and filters rows; reset restores them', async () => {
    await session('member'); const u = userEvent.setup(); view('/');
    await screen.findAllByText(/^OPS-\d{5}$/);
    await u.type(screen.getByLabelText('Search work items'), 'failover');
    await waitFor(() => { const rows = screen.getAllByRole('row').slice(1); expect(rows.length).toBeGreaterThan(0); rows.forEach((r) => expect(r).toHaveTextContent(/failover/i)); });
    await u.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(screen.getByLabelText('Search work items')).toHaveValue(''));
  });
  it('a filter changed right after typing in search is NOT wiped by the debounced search update', async () => {
    await session('member'); const u = userEvent.setup(); view('/'); await screen.findAllByText(/^OPS-\d{5}$/);
    await u.type(screen.getByLabelText('Search work items'), 'alert'); await u.selectOptions(screen.getByLabelText('Status'), 'OPEN');
    await new Promise((r) => setTimeout(r, 700)); // let the 300ms debounce fire
    expect(screen.getByLabelText('Status')).toHaveValue('OPEN'); expect(screen.getByLabelText('Search work items')).toHaveValue('alert');
    await waitFor(() => { const rows = screen.getAllByRole('row').slice(1); expect(rows.length).toBeGreaterThan(0); rows.forEach((r) => { expect(r).toHaveTextContent(/alert/i); expect(r).toHaveTextContent('Open'); }); });
  });
  it('priority, type and assignee filters are sent to the server', async () => {
    await session('member'); const u = userEvent.setup(); view('/'); await screen.findAllByText(/^OPS-\d{5}$/);
    await u.selectOptions(screen.getByLabelText('Priority'), 'URGENT'); await u.selectOptions(screen.getByLabelText('Assignee'), 'unassigned');
    await waitFor(() => { const rows = screen.getAllByRole('row').slice(1); expect(rows.length).toBeGreaterThan(0); rows.forEach((r) => { expect(r).toHaveTextContent('Urgent'); expect(r).toHaveTextContent('Unassigned'); }); });
  });
  it('shows an empty state when nothing matches', async () => {
    await session('member'); const u = userEvent.setup(); view('/'); await screen.findAllByText(/^OPS-\d{5}$/);
    await u.type(screen.getByLabelText('Search work items'), 'zzzz-no-such-item');
    expect(await screen.findByText('No work items match')).toBeInTheDocument();
  });
});

describe('create', () => {
  it('creates an item, navigates to its detail page, and it is persisted', async () => {
    const tok = await session('member'); const u = userEvent.setup(); view('/items/new'); const title = uniq('UI created');
    await u.type(await screen.findByLabelText('Title'), title); await u.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    const list = (await raw('GET', `/items?q=${encodeURIComponent(title)}`, tok)).body.data; expect(list).toHaveLength(1);
  });
  it('viewer-only users cannot create (button disabled, no writable team)', async () => {
    await session('viewer'); view('/items/new'); await screen.findByLabelText('Title');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});

describe('detail: edit, conflict, claim, workflow, comments, activity', () => {
  it('saves an edit and shows it in the activity timeline', async () => {
    const tok = await session('member'); const it = await mkItem(tok, uniq('Edit me')); const u = userEvent.setup(); view(`/items/${it.id}`);
    const title = await screen.findByLabelText('Title'); await u.clear(title); await u.type(title, it.title + ' v2'); await u.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved')).toBeInTheDocument();
    expect(await screen.findByText(/changed title/i)).toBeInTheDocument();
    expect((await raw('GET', `/items/${it.id}`, tok)).body.version).toBe(2);
  });
  it('on a stale edit shows a conflict, does NOT claim success, keeps typed text, and reload shows server data', async () => {
    const tok = await session('member'); const it = await mkItem(tok, uniq('Conflict')); const u = userEvent.setup(); view(`/items/${it.id}`);
    const title = await screen.findByLabelText('Title');
    const lead = await tokenFor('lead'); expect((await raw('PATCH', `/items/${it.id}`, lead, { expectedVersion: 1, title: 'Changed by lead' })).status).toBe(200);
    await u.clear(title); await u.type(title, 'My stale edit'); await u.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed by someone else/i);
    expect(screen.queryByText('Changes saved')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('My stale edit');
    expect((await raw('GET', `/items/${it.id}`, tok)).body.title).toBe('Changed by lead');
    await u.click(screen.getByRole('button', { name: /Reload latest/ }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Changed by lead'));
  });
  it('claims an item', async () => {
    const tok = await session('member'); const it = await mkItem(tok, uniq('Claim me')); const u = userEvent.setup(); view(`/items/${it.id}`);
    await u.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('You claimed this item')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument());
    expect((await raw('GET', `/items/${it.id}`, tok)).body.assignee_id).not.toBeNull();
  });
  it('losing a claim race shows the server error, not a success toast, and refreshes state', async () => {
    const tok = await session('member'); const it = await mkItem(tok, uniq('Race')); const u = userEvent.setup(); view(`/items/${it.id}`);
    const claimBtn = await screen.findByRole('button', { name: 'Claim' });
    expect((await raw('POST', `/items/${it.id}/claim`, await tokenFor('member2'))).status).toBe(200); // someone else wins first
    await u.click(claimBtn);
    expect(await screen.findByText(/already been claimed/i)).toBeInTheDocument();
    expect(screen.queryByText('You claimed this item')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument());
  });
  it('only a Lead sees Approve; approving needs confirmation and resolves the item', async () => {
    const m = await tokenFor('member'); const it = await mkItem(m, uniq('Approve me'));
    const r = await raw('POST', `/items/${it.id}/transition`, m, { to: 'IN_PROGRESS', expectedVersion: 1 });
    await raw('POST', `/items/${it.id}/transition`, m, { to: 'AWAITING_APPROVAL', expectedVersion: r.body.version });
    const first = view(`/items/${it.id}`);
    await screen.findByRole('heading', { name: it.title }); expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument(); first.unmount();
    await session('lead'); const u = userEvent.setup(); view(`/items/${it.id}`);
    await u.click(await screen.findByRole('button', { name: 'Approve' }));
    const dlg = await screen.findByRole('dialog'); expect(within(dlg).getByText('Approve and resolve?')).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Status updated')).toBeInTheDocument();
    expect(await screen.findByText(/approved and resolved this item/i)).toBeInTheDocument();
    expect((await raw('GET', `/items/${it.id}`, m)).body.status).toBe('RESOLVED');
  });
  it('viewers get a read-only page', async () => {
    const m = await tokenFor('member'); const it = await mkItem(m, uniq('Read only')); await session('viewer'); view(`/items/${it.id}`);
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    for (const n of ['Claim', 'Save changes', 'Comment']) expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
  });
  it('adds a comment that appears in the list', async () => {
    const tok = await session('member'); const it = await mkItem(tok, uniq('Comments')); const u = userEvent.setup(); view(`/items/${it.id}`);
    await u.type(await screen.findByLabelText('Add a comment'), 'Looking into this now'); await u.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Comment added')).toBeInTheDocument();
    expect(await screen.findByText('Looking into this now')).toBeInTheDocument();
    const commentResponse = await raw('GET', `/items/${it.id}/comments`, tok);
    expect(commentResponse.status).toBe(200);
    expect(commentResponse.body.data).toHaveLength(1);
  });
  it('shows Not found for an item in a team the user does not belong to, and for a missing item', async () => {
    const m = await tokenFor('member'); const it = await mkItem(m, uniq('Private')); await session('nora'); const first = view(`/items/${it.id}`);
    expect(await screen.findByText('Not found')).toBeInTheDocument(); first.unmount();
    view('/items/99999999'); expect(await screen.findByText('Not found')).toBeInTheDocument();
  });
});

describe('api client', () => {
  it('normalizes network failure into an ApiError with status 0', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(api('/items')).rejects.toMatchObject({ status: 0, code: 'NETWORK' }); spy.mockRestore();
    expect(new ApiError(0, 'NETWORK', 'x')).toBeInstanceOf(Error);
  });
});
