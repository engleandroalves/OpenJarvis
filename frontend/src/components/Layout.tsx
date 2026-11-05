import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { BarChart3, Bot, Database, MessageSquare, Orbit, Rocket, ScrollText, Settings } from 'lucide-react';
import { ApprovalBell } from './ApprovalBell';
import { Sidebar } from './Sidebar/Sidebar';
import { SystemPulse } from './SystemPulse';
import { useAppStore } from '../lib/store';
import { checkHealth } from '../lib/api';
import './app-shell.css';

export function Layout() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () => checkHealth().then(setApiReachable);
    check();
    const interval = setInterval(check, 30000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const navigate = useNavigate();
  const location = useLocation();
  const showSidebar = location.pathname === '/chat';
  const navItems = [
    { path: '/', icon: Orbit, label: 'Cortex' },
    { path: '/chat', icon: MessageSquare, label: 'Chat' },
    { path: '/dashboard', icon: BarChart3, label: 'Visão geral' },
    { path: '/data-sources', icon: Database, label: 'Fontes' },
    { path: '/agents', icon: Bot, label: 'Agentes' },
    { path: '/logs', icon: ScrollText, label: 'Registros' },
    { path: '/settings', icon: Settings, label: 'Config.' },
    { path: '/get-started', icon: Rocket, label: 'Início' },
  ];

  return (
    <div className="openjarvis-shell flex flex-col h-full w-full overflow-hidden relative" style={{ paddingTop: '3px' }}>
      <div className="hud-backdrop" aria-hidden="true" />
      <SystemPulse apiReachable={apiReachable} />
      <ApprovalBell />
      <header className="oj-global-header">
        <div className="oj-brand-lockup"><span className="oj-brand-signal" /><span>OPEN<span>JARVIS</span></span></div>
        <nav className="oj-nav" aria-label="Navegação principal">
          {navItems.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={location.pathname === item.path ? 'active' : ''}
              aria-current={location.pathname === item.path ? 'page' : undefined}
              title={item.label}
            >
              <item.icon size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <span className="oj-global-status"><i /> LOCAL E PRIVADO</span>
      </header>

      {/* Health check banner */}
      {apiReachable === false && (
        <div
          className="flex items-center gap-3 px-4 py-2 text-sm shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--color-error) 8%, transparent)',
            borderBottom: '1px solid color-mix(in srgb, var(--color-error) 15%, transparent)',
            color: 'var(--color-text)',
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'var(--color-error)' }}
          />
          <span>Cannot reach OpenJarvis backend</span>
          <button
            onClick={() => navigate('/settings')}
            className="text-sm underline cursor-pointer ml-auto shrink-0"
            style={{ color: 'var(--color-accent)' }}
          >
            Change URL
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 relative z-10">
        {showSidebar && <Sidebar />}
        {showSidebar && sidebarOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/40 md:hidden"
            onClick={() => useAppStore.getState().setSidebarOpen(false)}
          />
        )}
        <main className="flex-1 flex flex-col min-w-0 h-full relative overflow-hidden" style={{ background: 'transparent' }}>
          <div className="flex-1 flex flex-col min-w-0 min-h-0 relative z-[2]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
