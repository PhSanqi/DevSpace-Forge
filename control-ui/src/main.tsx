import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Health = { ok?: boolean; status?: number; error?: string };
type Snapshot = {
  generated_at?: string;
  instance?: string;
  platform?: string;
  runtime?: { actual?: { version?: string; pid?: number; evidence?: string }; version?: string; pointer_mismatch?: boolean; provenance?: { runtime?: { git_commit?: string } } };
  services?: { devspace?: string | null; tunnel?: string | null };
  mcp?: { local_health?: Health; public_health?: Health };
  connection?: { public_base_url?: string | null; public_mcp_url?: string | null; local_mcp_url?: string | null };
  inventory?: { available?: boolean; workspace_count?: number; workflow_session_count?: number; job_count?: number };
  management?: { settings?: { allowed_roots?: string[]; local_port?: number | null; public_base_url?: string | null; effective_public_base_url?: string | null; tunnel_mode?: 'Quick' | 'Remote'; tunnel_token_present?: boolean; auto_start?: boolean | null }; services?: { devspace?: { status?: string }; tunnel?: { status?: string } } };
};

type Page = 'overview' | 'connection' | 'onboarding';
const pageNames: Record<Page, string> = { overview: 'Overview', connection: 'Connection', onboarding: 'First run' };
const initialPage = (): Page => {
  const segment = location.pathname.split('/')[2];
  return segment === 'connection' || segment === 'onboarding' ? segment : 'overview';
};
const value = (input: string | number | null | undefined, fallback = 'Not available') => input === null || input === undefined || input === '' ? fallback : String(input);
const healthLabel = (health?: Health) => health?.ok ? 'Available' : health?.status ? `HTTP ${health.status}` : 'Not verified';
const stateTone = (good?: boolean) => good ? 'good' : 'muted';

async function managementPost(path: string, body: object): Promise<{ ok?: boolean; errors?: unknown[]; warnings?: unknown[] }> {
  const tokenResponse = await fetch('/api/action-token', { cache: 'no-store', credentials: 'same-origin' });
  if (!tokenResponse.ok) throw new Error(`Operator token unavailable (HTTP ${tokenResponse.status}).`);
  const { token } = await tokenResponse.json() as { token: string };
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-devspace-console-token': token }, body: JSON.stringify(body) });
  const result = await response.json() as { ok?: boolean; errors?: unknown[]; warnings?: unknown[] };
  if (!response.ok && !(path === '/api/management/validate' && response.status === 409)) throw new Error(`Request failed (HTTP ${response.status}). Check the fields and try again.`);
  return result;
}

function Status({ label, good }: { label: string; good?: boolean }) {
  return <span className={`status ${stateTone(good)}`}><span className="status-dot" />{label}</span>;
}

function Metric({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return <div className="metric"><span className="overline">{label}</span><strong>{children}</strong>{note && <small>{note}</small>}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Overview({ data }: { data: Snapshot }) {
  const local = data.mcp?.local_health;
  const publicHealth = data.mcp?.public_health;
  const running = data.runtime?.actual;
  const windows = data.platform === 'win32';
  const devspaceStatus = windows
    ? (running?.pid ? 'Running' : 'Not observed')
    : value(data.management?.services?.devspace?.status || data.services?.devspace, 'Unknown');
  const tunnelStatus = windows
    ? (publicHealth?.ok ? 'Route reachable' : 'Not verified')
    : value(data.management?.services?.tunnel?.status || data.services?.tunnel, 'Unknown');
  return <>
    <div className="hero"><div><p className="overline">INSTANCE / {value(data.instance, 'LOCAL').toUpperCase()}</p><h2>One clear view of your space.</h2><p>Live signals from the existing DevSpace control core. A health check shows reachability at the moment observed.</p></div><Status label={local?.ok ? 'Local endpoint reachable' : 'Needs a closer look'} good={local?.ok} /></div>
    <div className="metrics">
      <Metric label="LOCAL MCP" note="Origin health check">{healthLabel(local)}</Metric>
      <Metric label="PUBLIC MCP" note="External route health check">{healthLabel(publicHealth)}</Metric>
      <Metric label="RUNTIME" note="Observed process version">{value(running?.version || data.runtime?.version, 'Unverified')}</Metric>
      <Metric label="WORKSPACES" note={data.inventory?.available ? 'In durable state' : 'Inventory unavailable'}>{data.inventory?.available ? value(data.inventory.workspace_count, '0') : '—'}</Metric>
    </div>
    <div className="two-col">
      <section className="panel"><div className="panel-head"><div><p className="overline">SERVICE STATE</p><h3>At a glance</h3></div></div><dl>
        <Field label="DevSpace"><Status label={devspaceStatus} good={windows ? !!running?.pid : devspaceStatus === 'active'} /></Field>
        <Field label={windows ? 'Public route' : 'Tunnel'}><Status label={tunnelStatus} good={windows ? !!publicHealth?.ok : tunnelStatus === 'active'} /></Field>
        <Field label="Workflow sessions">{data.inventory?.available ? value(data.inventory.workflow_session_count, '0') : 'Not available'}</Field>
        <Field label="Durable jobs">{data.inventory?.available ? value(data.inventory.job_count, '0') : 'Not available'}</Field>
      </dl></section>
      <section className="panel"><div className="panel-head"><div><p className="overline">RUNTIME IDENTITY</p><h3>What is running</h3></div></div><dl>
        <Field label="Process ID">{value(running?.pid)}</Field>
        <Field label="Source revision">{value(data.runtime?.provenance?.runtime?.git_commit, 'Not recorded')}</Field>
        <Field label="Configured and live path">{data.runtime?.pointer_mismatch ? 'Different — inspect legacy console' : 'No mismatch reported'}</Field>
      </dl><p className="panel-note">Version labels and process evidence have different meanings. Use the legacy console for full provenance.</p></section>
    </div>
  </>;
}

function Connection({ data }: { data: Snapshot }) {
  const conn = data.connection;
  const settings = data.management?.settings;
  const autoStart = data.platform === 'win32'
    ? 'Desktop startup is not managed by this preview'
    : settings?.auto_start === true ? 'Enabled' : settings?.auto_start === false ? 'Disabled' : 'Not available';
  return <>
    <div className="section-intro"><p className="overline">CONNECTION / CURRENT CONFIGURATION</p><h2>Know where your clients connect.</h2><p>These addresses and checks come from the current instance snapshot. Credentials are never displayed here.</p></div>
    <div className="two-col">
      <section className="panel prominent"><div className="panel-head"><div><p className="overline">PUBLIC ACCESS</p><h3>MCP endpoint</h3></div><Status label={healthLabel(data.mcp?.public_health)} good={data.mcp?.public_health?.ok} /></div><div className="endpoint">{value(conn?.public_mcp_url, 'No public endpoint configured')}</div><dl><Field label="Public base URL">{value(conn?.public_base_url)}</Field><Field label="Tunnel mode">{value(settings?.tunnel_mode)}</Field><Field label="Tunnel token">{settings?.tunnel_token_present ? 'Present' : 'Not present'}</Field></dl></section>
      <section className="panel"><div className="panel-head"><div><p className="overline">LOCAL ACCESS</p><h3>On this machine</h3></div><Status label={healthLabel(data.mcp?.local_health)} good={data.mcp?.local_health?.ok} /></div><div className="endpoint">{value(conn?.local_mcp_url, 'Local endpoint not available')}</div><dl><Field label="Configured port">{value(settings?.local_port)}</Field><Field label="Service">{data.platform === 'win32' ? (data.runtime?.actual?.pid ? 'Running' : 'Not observed') : value(data.management?.services?.devspace?.status || data.services?.devspace, 'Unknown')}</Field><Field label="Auto start">{autoStart}</Field></dl></section>
    </div>
    <div className="info-band"><strong>Connection boundary</strong><span>Management stays on this loopback console. The public MCP endpoint is a separate route and may require authentication.</span></div>
  </>;
}

function Onboarding({ data, refresh }: { data: Snapshot; refresh: () => Promise<void> }) {
  const settings = data.management?.settings;
  const [roots, setRoots] = useState(() => (settings?.allowed_roots || []).join('\n'));
  const [port, setPort] = useState(() => String(settings?.local_port ?? ''));
  const [publicUrl, setPublicUrl] = useState(() => settings?.public_base_url || '');
  const [mode, setMode] = useState<'Quick' | 'Remote'>(() => settings?.tunnel_mode || 'Remote');
  const [token, setToken] = useState('');
  const [replacingToken, setReplacingToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [validation, setValidation] = useState('');
  useEffect(() => {
    if (dirty) return;
    setRoots((settings?.allowed_roots || []).join('\n'));
    setPort(String(settings?.local_port ?? ''));
    setPublicUrl(settings?.public_base_url || '');
    setMode(settings?.tunnel_mode || 'Remote');
  }, [settings, dirty]);
  const save = async () => {
    setWorking(true); setFailure(''); setMessage(''); setValidation('');
    let configSaved = false;
    try {
      const allowed_roots = roots.split(/\r?\n/).map(root => root.trim()).filter(Boolean);
      const local_port = Number(port);
      if (!allowed_roots.length || !Number.isSafeInteger(local_port) || local_port < 1 || local_port > 65535 || (mode === 'Remote' && !publicUrl.trim())) {
        setFailure('Add at least one existing absolute root, a valid port, and a public HTTPS URL for Remote mode.');
        return;
      }
      await managementPost('/api/management/config/save', { allowed_roots, local_port, public_base_url: publicUrl.trim(), tunnel_mode: mode });
      configSaved = true;
      if (mode === 'Remote' && token.trim()) {
        await managementPost('/api/management/tunnel-token', { token: token.trim() });
        setToken('');
        setReplacingToken(false);
      }
      setDirty(false);
      setMessage('Configuration saved. A runtime or service restart may still be required before changes take effect.');
    } catch (cause) {
      setFailure(`${configSaved ? 'Configuration saved, but the token was not saved. A runtime or service restart may still be required. ' : ''}${cause instanceof Error ? cause.message : 'Request failed. Try again.'}`);
    } finally {
      if (configSaved) await refresh();
      setWorking(false);
    }
  };
  const validate = async () => {
    setWorking(true); setFailure(''); setValidation('');
    try {
      const result = await managementPost('/api/management/validate', {});
      setValidation(result.ok ? `Validation passed${result.warnings?.length ? ` with ${result.warnings.length} warning(s)` : ''}.` : `Validation failed${result.errors?.length ? ` with ${result.errors.length} issue(s)` : ''}. Check the saved settings and try again.`);
    } catch (cause) { setFailure(cause instanceof Error ? cause.message : 'Validation unavailable. Try again.'); }
    finally { setWorking(false); }
  };
  return <>
    <div className="section-intro"><p className="overline">FIRST RUN / CONFIGURATION</p><h2>Give your space a starting point.</h2><p>Set project access and connection details for this instance. Save, then validate the saved configuration.</p></div>
    <div className="setup-grid"><div className="setup-main">
      <section className="panel setup-step"><div className="panel-head"><div><p className="overline">01 / PROJECT ACCESS</p><h3>Choose where DevSpace can work</h3></div></div><div className="form-grid"><label className="form-field wide">Allowed Roots <small>One existing absolute directory per line</small><textarea value={roots} rows={3} spellCheck={false} onChange={event => { setRoots(event.target.value); setDirty(true); }} disabled={working} placeholder={data.platform === 'win32' ? 'C:\\Projects' : '/path/to/projects'} /></label><label className="form-field">Local port <small>For the local MCP endpoint</small><input type="number" min="1" max="65535" value={port} onChange={event => { setPort(event.target.value); setDirty(true); }} disabled={working} /></label></div></section>
      <section className="panel setup-step"><div className="panel-head"><div><p className="overline">02 / CONNECTION</p><h3>Choose how clients connect</h3></div></div><div className="mode-options" role="group" aria-label="Connection mode"><label className={mode === 'Quick' ? 'selected' : ''}><input type="radio" name="mode" checked={mode === 'Quick'} onChange={() => { setMode('Quick'); setDirty(true); }} disabled={working} /><span><strong>Quick</strong><small>Temporary public route</small></span></label><label className={mode === 'Remote' ? 'selected' : ''}><input type="radio" name="mode" checked={mode === 'Remote'} onChange={() => { setMode('Remote'); setDirty(true); }} disabled={working} /><span><strong>Remote</strong><small>Your HTTPS address</small></span></label></div>{mode === 'Remote' && <div className="form-grid connection-fields"><label className="form-field wide">Public base URL <small>HTTPS origin or path, without /mcp</small><input type="url" value={publicUrl} onChange={event => { setPublicUrl(event.target.value); setDirty(true); }} disabled={working} placeholder="https://example.com" /></label><label className="form-field wide">Tunnel token <small>{settings?.tunnel_token_present ? 'A token is stored. Enter a new value only to rotate it.' : 'Optional; stored separately and never shown again'}</small><input type="password" value={token} onChange={event => setToken(event.target.value)} disabled={working || (!!settings?.tunnel_token_present && !replacingToken)} autoComplete="new-password" placeholder={settings?.tunnel_token_present ? '••••••••' : ''} /></label>{settings?.tunnel_token_present && !replacingToken && <div className="form-field wide"><button className="button secondary" type="button" onClick={() => setReplacingToken(true)} disabled={working}>Replace token</button></div>}</div>}</section>
      <section className="panel setup-step"><div className="panel-head"><div><p className="overline">03 / REVIEW</p><h3>Save and check</h3></div></div><div className="review-lines"><span>{roots.split(/\r?\n/).filter(root => root.trim()).length} allowed root(s) · port {port || '—'}</span><span>{mode} mode · {mode === 'Remote' ? (publicUrl || 'Public URL needed') : value(settings?.effective_public_base_url, 'Route assigned when active')}</span></div><div className="setup-actions"><button className="button" type="button" onClick={() => void save()} disabled={working}>{working ? 'Working…' : 'Save connection'}</button><button className="button secondary" type="button" onClick={() => void validate()} disabled={working}>{working ? 'Working…' : 'Validate saved config'}</button></div>{failure && <p className="setup-feedback error" role="alert">{failure}</p>}{message && <p className="setup-feedback success" role="status">{message}</p>}{validation && <p className={`setup-feedback ${validation.startsWith('Validation passed') ? 'success' : 'error'}`} role="status">{validation}</p>}<p className="field-hint">Validation checks saved settings. Unsaved edits are not included.</p></section>
    </div><aside className="next-card setup-aside"><p className="overline">CURRENT INSTANCE</p><h3>{data.platform === 'win32' ? 'Windows preview' : 'Control preview'}</h3><p>{data.platform === 'win32' ? 'Configuration is available here. Service ownership and autostart are not yet managed by this preview.' : 'This screen saves configuration only. It does not start or restart services.'}</p><div className="aside-facts"><span>Mode <strong>{value(settings?.tunnel_mode)}</strong></span><span>Token <strong>{settings?.tunnel_token_present ? 'Stored' : 'Absent'}</strong></span><span>Local MCP <strong>{healthLabel(data.mcp?.local_health)}</strong></span></div><a href="/next/connection" className="button">Review connection details <span aria-hidden="true">→</span></a><small>Client access and live runtime behavior still need separate verification.</small></aside></div>
  </>;
}

function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Status request returned HTTP ${response.status}.`);
      setData(await response.json() as Snapshot);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Status is unavailable.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 30000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { const onPop = () => setPage(initialPage()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  const navigate = (next: Page) => { history.pushState(null, '', `/next/${next}`); setPage(next); };
  return <div className="app"><a className="skip" href="#content">Skip to content</a><aside className="rail"><div className="brand"><div className="brand-symbol">D<span>.</span></div><div><strong>DevSpace Forge</strong><small>CONTROL PREVIEW</small></div></div><nav aria-label="Primary navigation"><span className="nav-label">WORKSPACE</span>{(Object.keys(pageNames) as Page[]).map(item => <button key={item} className={`nav-item ${page === item ? 'active' : ''}`} onClick={() => navigate(item)} aria-current={page === item ? 'page' : undefined}><span>{pageNames[item]}</span><span aria-hidden="true" className="nav-arrow">↗</span></button>)}</nav><div className="rail-foot"><span className="small-mark" /> Local control plane <small>Migration preview · configuration</small></div></aside><div className="main-wrap"><header className="topbar"><div><span className="mobile-brand">DevSpace Forge</span><span className="crumb">Control <span>/</span> {pageNames[page]}</span></div><div className="top-actions"><span className="top-instance">{value(data?.instance, 'Local instance')}</span><button className="refresh" onClick={() => void refresh()} disabled={loading}>Refresh <span aria-hidden="true">↻</span></button></div></header><main id="content"><div className="page-head"><div><p className="overline">DEVSPACE FORGE / CONTROL</p><h1>{pageNames[page]}</h1></div><span className="updated">{data?.generated_at ? `Updated ${new Date(data.generated_at).toLocaleTimeString()}` : 'Awaiting snapshot'}</span></div>{error && <div className="error" role="alert">{error} {data && 'Showing the last successful snapshot.'}</div>}{loading && !data ? <div className="loading" role="status">Reading the current instance…</div> : data ? page === 'overview' ? <Overview data={data} /> : page === 'connection' ? <Connection data={data} /> : <Onboarding data={data} refresh={refresh} /> : <div className="loading">No status snapshot is available. Check that the control server is running, then refresh.</div>}</main><footer className="main-foot">DevSpace Forge <span>·</span> Loopback management preview</footer></div></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
