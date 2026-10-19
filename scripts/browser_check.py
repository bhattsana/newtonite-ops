"""Real-browser check (Chromium via Playwright). Requires: API on :3000, built SPA served on :5173 (VITE_API_BASE_URL=http://localhost:3000),
a freshly seeded DB, and env JWT_SECRET (to mint an expired token) + API_START_CMD_ENV. Usage: python3 scripts/browser_check.py"""
import os, re, json, time, signal, subprocess, urllib.request
from playwright.sync_api import sync_playwright, expect
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); WEB = 'http://localhost:5173'; API = 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS', '/tmp/shots'); os.makedirs(SHOTS, exist_ok=True); SECRET = os.environ['JWT_SECRET']
CHROME = os.environ.get('CHROME', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'); AXE = os.environ.get('AXE', '/tmp/axe/node_modules/axe-core/axe.min.js')
PROBE = f'probe-{int(time.time())}@demo.test'  # unique per run: throttling is keyed by email+IP and lasts 15 minutes
fails = 0; cur = 'init'; console = []; api_proc = None
def check(name, cond, extra=''):
    global fails; print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  -> ' + str(extra)[:240]}"); fails += (not cond)
def api(method, path, tok=None, body=None):
    req = urllib.request.Request(f'{API}/api/v1{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'content-type': 'application/json', **({'authorization': f'Bearer {tok}'} if tok else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or 'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or 'null')
def token(u): return api('POST', '/auth/login', None, {'email': f'{u}@demo.test', 'password': 'demo-local-only'})[1]['token']
def start_api():
    global api_proc
    api_proc = subprocess.Popen(['npx', 'tsx', 'src/server.ts'], cwd=ROOT, preexec_fn=os.setsid, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, 'PORT': '3000', 'CORS_ORIGINS': WEB})
    for _ in range(60):
        try: urllib.request.urlopen(API + '/health'); return
        except Exception: time.sleep(0.25)
    raise RuntimeError('API did not start')
def stop_api():
    if api_proc: os.killpg(os.getpgid(api_proc.pid), signal.SIGTERM); api_proc.wait()
def poll(fn, secs=8):
    end = time.time() + secs
    while time.time() < end:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.15)
    return False
def mkpage(ctx, label):
    p = ctx.new_page(); p.set_default_timeout(8000)
    p.on('console', lambda m: m.type in ('error', 'warning') and console.append((cur, label, m.type, m.text[:160])))
    p.on('response', lambda r: r.status >= 400 and console.append((cur, label, f'http{r.status}', r.request.method + ' ' + r.url.replace(API, ''))))
    p.on('pageerror', lambda e: console.append((cur, label, 'pageerror', str(e)[:160])))
    return p
def login(p, email, pw='demo-local-only'):
    p.goto(WEB + '/login'); p.get_by_label('Email').fill(email); p.get_by_label('Password').fill(pw); p.get_by_role('button', name='Sign in').click()
def rows(p): return p.locator('tbody tr')
def settle(p): p.wait_for_load_state('networkidle')  # only reliable right after navigation; use poll() after interactions
def load_all(p):
    poll(lambda: rows(p).count() > 0 or p.get_by_text('No work items match').count() > 0)
    while p.get_by_role('button', name='Load more').count():
        n = rows(p).count(); p.get_by_role('button', name='Load more').click(); poll(lambda: rows(p).count() > n or p.get_by_role('button', name=re.compile('Load more|Loading')).count() == 0)  # the label is 'Loading…' while fetching
    return rows(p).count()
def no_hscroll(p): return p.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
def shot(p, name): p.screenshot(path=f'{SHOTS}/{name}.png', full_page=True)
def run(name, fn):
    global cur; cur = name; print(f'--- {name}')
    try: fn()
    except Exception as e: check(f'{name} [exception]', False, str(e).splitlines()[0])
def new_ctx(b, w=1440, h=900, tok=None):
    c = b.new_context(viewport={'width': w, 'height': h})
    if tok: c.add_init_script(f"sessionStorage.setItem('token','{tok}')")
    return c
AXE_SRC = open(AXE).read()
def axe(p, label):
    # Inject through CDP (page.evaluate), not add_script_tag: the app's CSP correctly refuses inline <script>, and we do not bypass it in tests.
    if p.evaluate("typeof window.axe") != 'object': p.evaluate('(function(){' + AXE_SRC + '\n})()')
    v = p.evaluate("axe.run().then(r=>r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.length,help:v.help,t:v.nodes.slice(0,2).map(n=>n.target.join(' '))})))")
    check(f'axe: no accessibility violations on {label}', not v, json.dumps(v))
def expired_token():
    return subprocess.check_output(['node', '-e', f"console.log(require('jsonwebtoken').sign({{sub:'2'}},'{SECRET}',{{expiresIn:-60}}))"], cwd=ROOT).decode().strip()

start_api(); T = {u: token(u) for u in ['lead', 'member', 'member2', 'viewer', 'nora']}
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    ctx = new_ctx(br); p = mkpage(ctx, 'main')
    def s_unauth():
        p.goto(WEB + '/'); p.wait_for_url(re.compile('/login')); expect(p.get_by_role('heading', name=re.compile('Operations under pressure'))).to_be_visible()
        check('production build does not advertise demo credentials or prefill an email', 'demo-local-only' not in p.inner_text('body') and p.get_by_label('Email').input_value() == '', p.inner_text('body')[:200])
        check('unauthenticated visit redirects to /login', True); shot(p, '01-login'); axe(p, 'login')
        check('login page has no horizontal scroll', no_hscroll(p))
    run('unauthenticated redirect', s_unauth)
    def s_invalid():
        login(p, 'lead@demo.test', 'wrong'); expect(p.get_by_text('Invalid email or password.')).to_be_visible(); check('invalid login shows error, stays on /login', '/login' in p.url)
        check('no token stored after failed login', p.evaluate("sessionStorage.getItem('token')") is None)
        p.get_by_role('button', name='Show').click(); check('Show toggles password visibility', p.get_by_label('Password').get_attribute('type') == 'text'); p.get_by_role('button', name='Hide').click()
        check('Hide restores masking', p.get_by_label('Password').get_attribute('type') == 'password')
    run('invalid login', s_invalid)
    def s_kbd_login():
        p.goto(WEB + '/login'); p.get_by_label('Email').fill('lead@demo.test'); p.get_by_label('Password').fill('x'); p.get_by_label('Email').focus(); order = []
        for _ in range(4):
            order.append(p.evaluate("document.activeElement.tagName+':'+(document.activeElement.type=='button'||document.activeElement.type=='submit'?document.activeElement.textContent.trim():document.activeElement.type)")); p.keyboard.press('Tab')
        check('Tab order on login: email, password, show/hide, sign in', order[0].startswith('INPUT:email') and order[1].startswith('INPUT:password') and 'Show' in order[2] and 'Sign in' in order[3], order)
        p.get_by_label('Email').focus(); p.keyboard.press('Tab'); p.get_by_label('Password').fill(''); ol = p.evaluate("getComputedStyle(document.activeElement).outlineStyle+' '+getComputedStyle(document.activeElement).outlineWidth")
        check('focused field has a visible outline', not ol.startswith('none'), ol)
        p.get_by_label('Email').fill('lead@demo.test'); p.get_by_label('Password').fill('demo-local-only'); p.keyboard.press('Enter')
        expect(p.get_by_role('heading', name='Work')).to_be_visible(); check('submitting with Enter logs in', True)
    run('keyboard login', s_kbd_login)
    def s_dash():
        settle(p); check('dashboard shows rows from the API', rows(p).count() > 0); check('token stored for session', bool(p.evaluate("sessionStorage.getItem('token')")))
        shot(p, '02-dashboard'); axe(p, 'dashboard'); check('dashboard has no horizontal scroll', no_hscroll(p))
        expect(p.get_by_role('link', name='Work', exact=True)).to_have_attribute('aria-current', 'page'); check('active nav link is marked aria-current', True)
    run('dashboard', s_dash)
    def s_tiles():
        for label, key in [('Assigned to me', 'assigned'), ('Awaiting my approval', 'approval'), ('Unassigned urgent', 'urgent'), ('Overdue', 'overdue')]:
            p.goto(WEB + '/'); settle(p); tile = p.get_by_role('button', name=re.compile(label)); n = int(tile.locator('b').inner_text()); tile.click(); p.wait_for_timeout(600)
            got = load_all(p)
            check(f'tile "{label}" count ({n}) equals the rows its click shows ({got})', n == got, f'tile={n} rows={got} url={p.url}')
    run('summary tiles match their lists', s_tiles)
    def s_nav():
        p.goto(WEB + '/'); p.get_by_role('link', name='Teams').click(); expect(p.get_by_role('heading', name='Teams')).to_be_visible()
        expect(p.get_by_role('link', name='Teams')).to_have_attribute('aria-current', 'page'); check('Teams page lists members with roles', poll(lambda: p.locator('tbody tr').count() >= 3))
        shot(p, '03-teams'); axe(p, 'teams'); p.get_by_role('link', name='Work', exact=True).click(); expect(p.get_by_role('heading', name='Work')).to_be_visible(); check('navigate back to Work', True)
        p.goto(WEB + '/does-not-exist'); expect(p.get_by_role('heading', name='Not found')).to_be_visible(); check('unknown route shows Not found inside the shell', p.get_by_role('link', name='Work', exact=True).count() > 0)
    run('navigation', s_nav)
    def s_filters():
        p.goto(WEB + '/'); settle(p); box = p.get_by_label('Search work items'); box.fill('failover'); p.wait_for_timeout(700); settle(p)
        t = rows(p).all_inner_texts(); check('search narrows rows server-side', len(t) > 0 and all(re.search('failover', x, re.I) for x in t), t[:2]); check('search term is reflected in URL', 'q=failover' in p.url, p.url)
        p.reload(); settle(p); check('search term survives reload (URL state)', p.get_by_label('Search work items').input_value() == 'failover')
        p.get_by_role('button', name='Reset filters').click(); p.wait_for_timeout(600); check('reset clears search and URL', p.get_by_label('Search work items').input_value() == '' and 'q=' not in p.url)
        p.get_by_label('Status').select_option('IN_PROGRESS'); p.wait_for_timeout(600); settle(p); t = rows(p).all_inner_texts()
        check('status filter shows only that status', len(t) > 0 and all('In progress' in x for x in t))
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Team').select_option(index=1); p.wait_for_timeout(600); settle(p); check('team filter changes the result set', rows(p).count() > 0 and 'teamId=' in p.url)
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Search work items').fill('disk'); p.get_by_label('Status').select_option('OPEN'); p.wait_for_timeout(900)
        check('filter changed right after typing survives the search debounce (URL keeps both)', 'q=disk' in p.url and 'status=OPEN' in p.url, p.url)
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Overdue').click(); poll(lambda: p.get_by_label('Overdue').is_checked() and 'overdue=true' in p.url); p.wait_for_timeout(600); settle(p); t = rows(p).all_inner_texts(); check('overdue filter shows only overdue rows', len(t) > 0 and all('Overdue' in x for x in t))
        p.get_by_role('button', name='Reset filters').click(); p.wait_for_timeout(500)
        p.get_by_label('Priority').select_option('URGENT'); poll(lambda: 'priority=URGENT' in p.url); p.wait_for_timeout(500); t = rows(p).all_inner_texts(); check('priority filter shows only Urgent', len(t) > 0 and all('Urgent' in x for x in t))
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Type').select_option('INCIDENT'); p.wait_for_timeout(600); check('type filter applies server-side (type=INCIDENT in request/URL)', 'type=INCIDENT' in p.url and rows(p).count() > 0)
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Assignee').select_option('unassigned'); p.wait_for_timeout(600); t = rows(p).all_inner_texts(); check('assignee=Unassigned shows only unassigned rows', len(t) > 0 and all('Unassigned' in x for x in t))
        p.get_by_role('button', name='Reset filters').click(); p.get_by_label('Assignee').select_option('me'); p.wait_for_timeout(600); t = rows(p).all_inner_texts(); check('assignee=Me shows only my rows', len(t) > 0 and all('Lena Lead' in x for x in t)); p.get_by_role('button', name='Reset filters').click(); p.wait_for_timeout(400)
        p.get_by_label('Search work items').fill('zzzz-nothing'); expect(p.get_by_text('No work items match')).to_be_visible(); check('empty state for no matches', True)
    run('search and filters', s_filters)
    def s_page():
        p.goto(WEB + '/'); poll(lambda: rows(p).count() > 0); first = rows(p).count(); check('first page is bounded (<=20 rows)', 0 < first <= 20, first)
        walked = load_all(p)
        _, summ = api('GET', '/items?limit=100', T['lead']); total = 0; cur_ = None
        while True:
            _, r = api('GET', f'/items?limit=100{"&cursor=" + str(cur_) if cur_ else ""}', T['lead']); total += len(r['data']); cur_ = r['nextCursor']
            if not cur_: break
        check(f'Load more reaches every visible item exactly once ({walked} rows vs {total} from API)', walked == total and walked > first, (walked, total))
    run('pagination', s_page)
    def s_kbd_table():
        p.goto(WEB + '/'); settle(p); p.get_by_label('Search work items').focus(); seen = False
        for _ in range(12):
            p.keyboard.press('Tab')
            if p.evaluate("document.activeElement.tagName") == 'TR': seen = True; break
        check('table rows are reachable with Tab', seen)
        if seen:
            ol = p.evaluate("getComputedStyle(document.activeElement).outlineStyle"); check('focused row has a visible focus indicator', ol != 'none', ol)
            p.keyboard.press('Enter'); p.wait_for_url(re.compile(r'/items/\d+')); check('Enter on a focused row opens the item', True)
    run('keyboard: table', s_kbd_table)
    created = {}
    def s_create():
        p.goto(WEB + '/'); p.get_by_role('link', name='New work item').click(); expect(p.get_by_role('heading', name='New work item')).to_be_visible()
        check('Create is disabled while title is empty', p.get_by_role('button', name='Create').is_disabled()); shot(p, '04-create'); axe(p, 'create form')
        p.get_by_label('Title').fill('Browser verification item'); p.get_by_label('Description').fill('Created through a real browser.'); p.get_by_label('Priority').select_option('URGENT')
        p.get_by_label('Due date').fill('2031-01-01T10:00'); p.get_by_role('button', name='Create').click()
        p.wait_for_url(re.compile(r'/items/\d+')); created['id'] = int(p.url.rsplit('/', 1)[1]); expect(p.get_by_role('heading', name='Browser verification item')).to_be_visible()
        check('creation shows a success toast with the reference', poll(lambda: re.search(r'OPS-\d{5} created', p.locator('.toasts').inner_text())))
        check('detail shows readable team name, not an id', p.get_by_text(re.compile('^(Platform|Support|Security)$')).count() >= 1)
        s, it = api('GET', f'/items/{created["id"]}', T['lead']); check('item persisted with chosen priority and due date', s == 200 and it['priority'] == 'URGENT' and it['due_at'].startswith('2031-01-01'), it)
        p.goto(WEB + '/'); settle(p); expect(rows(p).first).to_contain_text('Browser verification item'); check('new item appears first on the dashboard (lists were refreshed)', True)
    run('create', s_create)
    def s_detail():
        p.goto(f'{WEB}/items/{created["id"]}'); expect(p.get_by_role('heading', name='Browser verification item')).to_be_visible(); shot(p, '05-detail'); axe(p, 'work item detail')
        p.get_by_role('button', name='Claim').click(); expect(p.get_by_text('You claimed this item')).to_be_visible(); expect(p.get_by_role('button', name='Claim')).to_have_count(0)
        expect(p.get_by_text('claimed this item').last).to_be_visible(); check('claim works; button disappears; activity shows the claim', True)
        t = p.get_by_label('Title'); t.fill('Browser verification item (edited)'); p.get_by_role('button', name='Save changes').click(); expect(p.get_by_text('Changes saved')).to_be_visible()
        expect(p.get_by_text(re.compile('changed title'))).to_be_visible(); check('edit saves and appears in activity with before/after', True)
        p.get_by_label('Add a comment').fill('Comment from the browser'); p.get_by_role('button', name='Comment').click(); expect(p.get_by_text('Comment from the browser')).to_be_visible(); check('comment appears', True)
        p.get_by_role('button', name='Move to awaiting approval').click(); dlg = p.locator('dialog[open]'); expect(dlg).to_be_visible(); check('confirmation dialog opens (modal)', True)
        check('focus is inside the dialog', p.evaluate("!!document.activeElement.closest('dialog')")); p.keyboard.press('Escape'); expect(p.locator('dialog[open]')).to_have_count(0)
        check('Escape closes the dialog without changing status', 'Awaiting approval' not in p.locator('.badge').first.inner_text())
        p.get_by_role('button', name='Move to awaiting approval').click(); p.locator('dialog[open]').get_by_role('button', name='Confirm').click(); expect(p.get_by_text('Status updated')).to_be_visible()
        expect(p.locator('.badge').first).to_have_text('Awaiting approval'); check('status moved to Awaiting approval after confirmation', True)
        p.get_by_role('button', name='Approve').click(); p.locator('dialog[open]').get_by_role('button', name='Confirm').click(); expect(p.locator('.badge').first).to_have_text('Resolved')
        expect(p.get_by_text('approved and resolved this item')).to_be_visible(); check('lead approval resolves the item and is logged', True); shot(p, '06-detail-resolved')
        _, act = api('GET', f'/items/{created["id"]}/activity', T['lead']); check('activity order and actors correct', [e['event_type'] for e in act['data']][:3] == ['CREATED', 'CLAIMED', 'TITLE_CHANGED'] and all(e['actor_name'] == 'Lena Lead' for e in act['data']), [e['event_type'] for e in act['data']])
    run('detail: claim, edit, comment, approval', s_detail)
    def s_roles():
        _, it = api('POST', '/items', T['member'], {'title': 'Role gating item', 'teamId': api('GET', '/teams', T['member'])[1]['data'][0]['id']})
        api('POST', f'/items/{it["id"]}/transition', T['member'], {'to': 'IN_PROGRESS', 'expectedVersion': 1}); api('POST', f'/items/{it["id"]}/transition', T['member'], {'to': 'AWAITING_APPROVAL', 'expectedVersion': 2})
        for who, can in [('member', False), ('viewer', False), ('lead', True)]:
            c = new_ctx(br, tok=T[who]); q = mkpage(c, who); q.goto(f'{WEB}/items/{it["id"]}'); expect(q.get_by_role('heading', name='Role gating item')).to_be_visible()
            check(f'{who}: Approve button {"visible" if can else "hidden"}', (q.get_by_role('button', name='Approve').count() == 1) == can)
            if who == 'viewer': check('viewer sees read-only banner and disabled form', q.get_by_text(re.compile('read-only')).count() == 1 and q.get_by_label('Title').is_disabled()); shot(q, '07-viewer-readonly')
            c.close()
        c = new_ctx(br, tok=T['nora']); q = mkpage(c, 'nora'); q.goto(f'{WEB}/items/{it["id"]}'); expect(q.get_by_role('heading', name='Not found')).to_be_visible(); check('non-member sees Not found for the item', True); c.close()
    run('role gating in the UI', s_roles)
    def s_conflict():
        tid = api('GET', '/teams', T['lead'])[1]['data'][0]['id']; _, it = api('POST', '/items', T['lead'], {'title': 'Conflict target', 'teamId': tid})
        ca, cb = new_ctx(br, tok=T['lead']), new_ctx(br, tok=T['member']); a, b = mkpage(ca, 'A-lead'), mkpage(cb, 'B-member')
        a.goto(f'{WEB}/items/{it["id"]}'); b.goto(f'{WEB}/items/{it["id"]}'); expect(a.get_by_label('Title')).to_have_value('Conflict target'); expect(b.get_by_label('Title')).to_have_value('Conflict target')
        b.get_by_label('Title').fill('Edited by B'); b.get_by_role('button', name='Save changes').click(); expect(b.get_by_text('Changes saved')).to_be_visible()
        a.get_by_label('Title').fill('Edited by A (stale)'); a.get_by_role('button', name='Save changes').click(); expect(a.get_by_role('alert').filter(has_text='changed by someone else')).to_be_visible()
        check('stale save shows a conflict message', True); check('no false success toast in A', 'Changes saved' not in a.locator('.toasts').inner_text()); check("A's typed text is preserved", a.get_by_label('Title').input_value() == 'Edited by A (stale)')
        check('server kept B’s data', api('GET', f'/items/{it["id"]}', T['lead'])[1]['title'] == 'Edited by B'); shot(a, '08-conflict')
        a.get_by_role('button', name=re.compile('Reload latest')).click(); expect(a.get_by_label('Title')).to_have_value('Edited by B'); check('Reload latest shows the newer server data', True)
        # claim race through two real browsers (B's page is stale: it still shows an enabled Claim button)
        _, it2 = api('POST', '/items', T['lead'], {'title': 'Claim race', 'teamId': tid}); a.goto(f'{WEB}/items/{it2["id"]}'); b.goto(f'{WEB}/items/{it2["id"]}')
        expect(a.get_by_role('button', name='Claim')).to_be_visible(); expect(b.get_by_role('button', name='Claim')).to_be_visible()
        a.get_by_role('button', name='Claim').click(); expect(a.get_by_text('You claimed this item')).to_be_visible()
        b.get_by_role('button', name='Claim').click(); expect(b.get_by_text(re.compile('already been claimed'))).to_be_visible(); check('loser sees an explicit "already claimed" error', True)
        check('loser sees no success toast', 'You claimed this item' not in b.locator('.toasts').inner_text()); expect(b.get_by_role('button', name='Claim')).to_have_count(0); check('loser UI refreshed: Claim button removed', True)
        ca.close(); cb.close()
    run('conflicts across two real browsers', s_conflict)
    def s_session():
        c = br.new_context(viewport={'width': 1440, 'height': 900}); c.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('token','garbage.token.value');sessionStorage.setItem('seeded','1')}")
        q = mkpage(c, 'tamper'); q.goto(WEB + '/'); q.wait_for_url(re.compile(r'/login\?expired=1')); expect(q.get_by_text('Your session expired')).to_be_visible(); check('garbage token -> redirected to login with "session expired"', True)
        check('bad token removed from storage', q.evaluate("sessionStorage.getItem('token')") is None); c.close()
        c = br.new_context(viewport={'width': 1440, 'height': 900}); c.add_init_script(f"if(!sessionStorage.getItem('seeded')){{sessionStorage.setItem('token','{expired_token()}');sessionStorage.setItem('seeded','1')}}")
        q = mkpage(c, 'expired'); q.goto(WEB + '/'); q.wait_for_url(re.compile(r'/login\?expired=1')); check('genuinely expired (signed) token -> redirected with "session expired"', True); c.close()
        c = br.new_context(viewport={'width': 1440, 'height': 900}); q = mkpage(c, 'mid'); login(q, 'lead@demo.test'); expect(q.get_by_role('heading', name='Work')).to_be_visible(); settle(q)
        q.evaluate(f"sessionStorage.setItem('token','{expired_token()}')"); rows(q).first.locator('a').click(); q.wait_for_url(re.compile(r'/login\?expired=1')); check('token expiring mid-session -> next action redirects to login', True)
        q.goto(WEB + '/'); q.wait_for_url(re.compile('/login')); check('after expiry the protected page stays protected', q.get_by_role('heading', name='Work').count() == 0 and rows(q).count() == 0); c.close()
    run('session expiry', s_session)
    def s_logout():
        c = br.new_context(viewport={'width': 1440, 'height': 900}); q = mkpage(c, 'logout'); calls = []; q.on('response', lambda r: '/auth/logout' in r.url and calls.append(r.status))
        login(q, 'lead@demo.test'); expect(q.get_by_role('heading', name='Work')).to_be_visible(); old_tok = q.evaluate("sessionStorage.getItem('token')"); q.get_by_role('button', name='Sign out').click(); q.wait_for_url(re.compile('/login'))
        check('the token used before logout is rejected by the server afterwards (revoked, not just forgotten)', api('GET', '/auth/me', old_tok)[0] == 401)
        check('Sign out calls POST /auth/logout (204) and returns to login', calls == [204], calls); check('token cleared from storage on logout', q.evaluate("sessionStorage.getItem('token')") is None)
        q.goto(WEB + '/'); q.wait_for_url(re.compile('/login')); q.go_back(); q.wait_for_timeout(500)
        check('after logout, Back/direct visits do not reveal data', q.get_by_role('heading', name='Work').count() == 0 or '/login' in q.url); check('no table rows visible after logout', rows(q).count() == 0); c.close()
    run('logout', s_logout)
    def s_resp():
        for (w, h, n) in [(1440, 900, 'desktop'), (1024, 768, 'tablet-landscape'), (768, 1024, 'tablet-portrait'), (390, 844, 'mobile')]:
            c = new_ctx(br, w, h, tok=T['lead']); q = mkpage(c, n)
            for path, nm in [('/', 'dashboard'), (f'/items/{created["id"]}', 'detail'), ('/items/new', 'create'), ('/teams', 'teams')]:
                q.goto(WEB + path); settle(q); q.wait_for_timeout(300); check(f'{n} {nm}: no horizontal page scroll', no_hscroll(q), q.evaluate('document.documentElement.scrollWidth'))
                if nm in ('dashboard', 'detail') or n == 'mobile': shot(q, f'09-{n}-{nm}')
            q.goto(WEB + '/'); settle(q); check(f'{n}: nav and primary action reachable', q.get_by_role('link', name='Teams').is_visible() and q.get_by_role('link', name='New work item').is_visible())
            if n == 'mobile':
                small = q.evaluate("[...document.querySelectorAll('button,a,select,input')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.height<24)}).length"); print(f'     (info) interactive elements under 24px tall on mobile: {small}')
                axe(q, 'mobile dashboard')
            c.close()
    run('responsive layouts', s_resp)
    def s_down():
        c = new_ctx(br); q = mkpage(c, 'down'); login(q, 'lead@demo.test'); expect(q.get_by_role('heading', name='Work')).to_be_visible(); stop_api(); q.reload()
        expect(q.get_by_text('API unavailable')).to_be_visible(); check('API down -> clear "API unavailable" state with retry', q.get_by_role('button', name='Try again').count() == 1); shot(q, '10-api-down')
        start_api(); q.get_by_role('button', name='Try again').click(); expect(q.get_by_role('heading', name='Work')).to_be_visible(); check('Try again recovers once the API is back', True); c.close()
    def s_sec():
        c = new_ctx(br); q = mkpage(c, 'sec'); q.goto(WEB + '/login')
        meta = q.evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content || ''")
        check('built SPA ships a CSP: script-src self, connect-src only self + the API, object-src none', "script-src 'self'" in meta and "connect-src 'self' http://localhost:3000" in meta and "object-src 'none'" in meta, meta)
        check('CSP blocks a request to a third-party origin (token exfiltration path)', q.evaluate("fetch('https://example.com/x').then(()=>'allowed').catch(()=>'blocked')") == 'blocked')
        check('CSP blocks an injected inline script', q.evaluate("(()=>{const s=document.createElement('script');s.textContent='window.__x=1';document.head.appendChild(s);return window.__x===1?'ran':'blocked'})()") == 'blocked')
        with urllib.request.urlopen(API + '/health') as r: h = r.headers
        check('API response carries security headers', h.get('X-Content-Type-Options') == 'nosniff' and h.get('X-Frame-Options') == 'DENY' and 'X-Powered-By' not in h)
        st = q.evaluate("Promise.all(Array.from({length:10},()=>fetch('http://localhost:3000/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'" + PROBE + "',password:'bad'})}).then(r=>r.status)))")
        check('10 failed logins from the browser are all plain 401s', set(st) == {401}, st)
        q.get_by_label('Email').fill(PROBE); q.get_by_label('Password').fill('bad'); q.get_by_role('button', name='Sign in').click()
        expect(q.get_by_text(re.compile('Too many failed sign-in attempts'))).to_be_visible(); check('11th attempt shows the throttling message in the UI', True); shot(q, '11-throttled')
        q.get_by_label('Email').fill('lead@demo.test'); q.get_by_label('Password').fill('demo-local-only'); q.get_by_role('button', name='Sign in').click(); expect(q.get_by_role('heading', name='Work')).to_be_visible(); check('a different account still signs in from the same browser', True); c.close()
    run('security: CSP, headers, throttling', s_sec)
    run('API unavailable and recovery', s_down)
    br.close()
stop_api()
print('\n=== console / page errors by step (label) ===')
agg = {}
for step_, label, typ, text in console: agg.setdefault((step_, typ, text), 0); agg[(step_, typ, text)] += 1
for (s_, t_, x_), n in agg.items(): print(f'[{s_}] {t_} x{n}: {x_}')
print(f'\n{fails} CHECK(S) FAILED' if fails else '\nALL BROWSER CHECKS PASSED'); raise SystemExit(1 if fails else 0)
