import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { Item, ItemList } from './api';

type Props = { open: boolean; canCreate: boolean; userId: number; onRefresh: () => void; onClose: () => void };

export function CommandPalette({ open, canCreate, userId, onRefresh, onClose }: Props) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const search = query.trim();
  const normalizedSearch = search.toLocaleLowerCase();
  const commands: { label: string; keywords: string; path?: string; action?: () => void }[] = [
    { label: 'Work dashboard', keywords: 'home overview', path: '/' },
    { label: 'Open work queue', keywords: 'active queue items', path: '/?active=true' },
    { label: 'Assigned to me', keywords: 'my work queue owner', path: `/?assigneeId=${userId}&active=true` },
    { label: 'Urgent unassigned work', keywords: 'high priority nobody owner', path: '/?unassigned=true&highPriority=true&active=true' },
    { label: 'Awaiting my approval', keywords: 'approve review pending', path: '/?approvable=true' },
    { label: 'Refresh dashboard data', keywords: 'reload sync update', action: onRefresh },
    { label: 'Teams', keywords: 'members team', path: '/teams' },
    ...(canCreate ? [{ label: 'Create a work item', keywords: 'new create task', path: '/items/new' }] : []),
  ].filter((command) => `${command.label} ${command.keywords}`.toLocaleLowerCase().includes(normalizedSearch));
  const results = useQuery({
    queryKey: ['command-search', search],
    queryFn: ({ signal }) => api<ItemList>('/items', { signal, query: { q: search, limit: 6 } }),
    enabled: open && search.length >= 2,
    staleTime: 0,
  });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    input.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    onClose();
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.focus(), 0);
  };
  const visit = (path: string) => {
    close();
    navigate(path);
  };
  const runCommand = (command: (typeof commands)[number]) => {
    if (command.action) {
      close();
      command.action();
    } else if (command.path) {
      visit(command.path);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-palette-option]')];
      if (options.length) {
        event.preventDefault();
        const current = options.findIndex((option) => option === document.activeElement);
        const next = current < 0
          ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    }
    if (event.key === 'Enter' && event.target === input.current) {
      if (search && commands.length === 1) runCommand(commands[0]);
      else if (results.data?.data.length === 1) visit(`/items/${results.data.data[0].id}`);
    }
    if (event.key !== 'Tab') return;
    const controls = [...(event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)'))];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="palette" role="dialog" aria-modal="true" aria-labelledby="palette-title" onKeyDown={onKeyDown}>
      <h2 id="palette-title">Command center</h2>
      <label className="sr-only" htmlFor="command-search">Search work items or commands</label>
      <input id="command-search" ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work or jump to a page…" />
      {commands.length > 0 && <div className="palette-group" role="group" aria-label="Commands">
        <p className="eyebrow">{search ? 'Matching commands' : 'Commands'}</p>
        {commands.map((command) => <button data-palette-option key={command.label} onClick={() => runCommand(command)}>{command.label}</button>)}
      </div>}
      {search.length >= 2 && <div className="palette-group" role="group" aria-label="Work item results">
        <p className="eyebrow">Matching work</p>
        {results.isLoading && <p className="muted small" role="status">Searching your team work…</p>}
        {results.error && <p className="alert err" role="alert">Could not search work items. Close the command center and try again.</p>}
        {results.data?.data.length === 0 && <p className="muted small">No matching work items.</p>}
        {results.data?.data.map((item: Item) => <button data-palette-option key={item.id} onClick={() => visit(`/items/${item.id}`)}>
          <span className="mono">{item.reference}</span><span>{item.title}</span><span className="muted small">{item.status.replace(/_/g, ' ')}</span>
        </button>)}
      </div>}
      {search && commands.length === 0 && search.length < 2 && <p className="palette-empty">No matching commands. Enter at least two characters to search work items.</p>}
      <footer><span>Search respects your team access</span><span><kbd>↑</kbd> <kbd>↓</kbd> navigate <kbd>ENTER</kbd> open <kbd>ESC</kbd> close</span></footer>
    </section>
  </div>;
}
