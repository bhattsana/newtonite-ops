import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { Item, ItemList } from './api';

type Props = { open: boolean; canCreate: boolean; onClose: () => void };

export function CommandPalette({ open, canCreate, onClose }: Props) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const search = query.trim();
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
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Enter' && event.target === input.current && results.data?.data.length === 1) {
      visit(`/items/${results.data.data[0].id}`);
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
      <div className="palette-group" aria-label="Navigation">
        <p className="eyebrow">Navigate</p>
        <button onClick={() => visit('/')}>Work dashboard</button>
        <button onClick={() => visit('/teams')}>Teams</button>
        {canCreate && <button onClick={() => visit('/items/new')}>Create a work item</button>}
      </div>
      {search.length >= 2 && <div className="palette-group" aria-label="Work item results">
        <p className="eyebrow">Matching work</p>
        {results.isLoading && <p className="muted small" role="status">Searching your team work…</p>}
        {results.error && <p className="alert err" role="alert">Could not search work items. Close the command center and try again.</p>}
        {results.data?.data.length === 0 && <p className="muted small">No matching work items.</p>}
        {results.data?.data.map((item: Item) => <button key={item.id} onClick={() => visit(`/items/${item.id}`)}>
          <span className="mono">{item.reference}</span><span>{item.title}</span><span className="muted small">{item.status.replace(/_/g, ' ')}</span>
        </button>)}
      </div>}
      <footer><span>Search respects your team access</span><kbd>ESC</kbd></footer>
    </section>
  </div>;
}
