import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Cpu,
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { KnowledgeGraph } from '../components/Knowledge/KnowledgeGraph';
import { SkillsArc } from '../components/Knowledge/SkillsArc';
import { buildSkillGroups } from '../components/Knowledge/skills';
import { MessageBubble } from '../components/Chat/MessageBubble';
import { InputArea } from '../components/Chat/InputArea';
import { StreamingDots } from '../components/Chat/StreamingDots';
import { fetchAvailableTools, type ToolInfo } from '../lib/api';
import { fetchVaultGraph, type VaultGraph } from '../lib/vault-api';
import { useAppStore } from '../lib/store';
import './cortex.css';

const LEFT_W = 300;
const RIGHT_W = 372;
const GAP = 12;

type Focus = { kind: 'note' | 'skill'; id: string } | null;

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function useVaultGraph() {
  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchVaultGraph()
      .then((g) => {
        setGraph(g);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);
  return { graph, error, loading, reload: load };
}

export function CortexPage() {
  const navigate = useNavigate();
  const { graph, error, loading, reload } = useVaultGraph();
  const [focus, setFocus] = useState<Focus>(null);
  const [query, setQuery] = useState('');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [tools, setTools] = useState<ToolInfo[]>([]);

  const messages = useAppStore((s) => s.messages);
  const streamState = useAppStore((s) => s.streamState);
  const activeId = useAppStore((s) => s.activeId);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const serverInfo = useAppStore((s) => s.serverInfo);
  const deepResearch = useAppStore((s) => s.deepResearch);
  const savings = useAppStore((s) => s.savings);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const createConversation = useAppStore((s) => s.createConversation);

  const streaming = streamState.isStreaming && streamState.conversationId === activeId;

  useEffect(() => {
    fetchAvailableTools().then(setTools).catch(() => setTools([]));
  }, []);

  const skills = useMemo(() => buildSkillGroups(tools, messages), [tools, messages]);
  const focusedSkill = focus?.kind === 'skill' ? skills.find((s) => s.id === focus.id) : undefined;

  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (from: string, to: string) => {
      const list = map.get(from);
      if (list) list.push(to);
      else map.set(from, [to]);
    };
    for (const e of graph?.edges ?? []) {
      add(e.source, e.target);
      add(e.target, e.source);
    }
    return map;
  }, [graph]);

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const noteId = focus?.kind === 'note' ? focus.id : null;
  const note = noteId ? nodeById.get(noteId) : undefined;
  const linked = note ? (adjacency.get(note.id) ?? []).slice(0, 14) : [];

  const stats = useMemo(() => {
    const folders = new Set((graph?.nodes ?? []).map((n) => n.folder));
    return { notes: graph?.nodes.length ?? 0, links: graph?.edges.length ?? 0, folders: folders.size };
  }, [graph]);

  // Notes cited by the latest assistant reply light up in the graph.
  const highlighted = useMemo(() => {
    const ids = new Set<string>();
    if (!graph) return ids;
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!last?.researchSources?.length) return ids;
    const byTitle = new Map(graph.nodes.map((n) => [n.title.toLowerCase(), n.id]));
    for (const src of last.researchSources) {
      const byName = src.title ? byTitle.get(src.title.toLowerCase()) : undefined;
      if (byName) ids.add(byName);
      if (src.url) {
        try {
          const file = new URL(src.url).searchParams.get('file');
          if (file && nodeById.has(file)) ids.add(file);
        } catch {
          // non-URL source reference
        }
      }
    }
    return ids;
  }, [messages, graph, nodeById]);

  const tokens = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    const series: number[] = [];
    for (const m of messages) {
      if (!m.usage) continue;
      prompt += m.usage.prompt_tokens ?? 0;
      completion += m.usage.completion_tokens ?? 0;
      series.push(m.usage.total_tokens ?? (m.usage.prompt_tokens ?? 0) + (m.usage.completion_tokens ?? 0));
    }
    return { prompt, completion, total: prompt + completion, series: series.slice(-24) };
  }, [messages]);

  const liveTokens = streaming ? Math.ceil(streamState.content.length / 4) : 0;
  const activeSkills = skills.filter((s) => s.state === 'active').length;

  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamState.content]);

  const modelLabel = deepResearch ? 'Deep Research' : selectedModel || serverInfo?.model || 'Selecionar modelo';
  const selectNote = useCallback((id: string | null) => setFocus(id ? { kind: 'note', id } : null), []);
  const selectSkill = useCallback((id: string) => setFocus((f) => (f?.kind === 'skill' && f.id === id ? null : { kind: 'skill', id })), []);

  return (
    <div className="cortex">
      <div
        className="cortex-stage"
        style={{ left: leftOpen ? LEFT_W + GAP * 2 : 0, right: rightOpen ? RIGHT_W + GAP * 2 : 0 }}
      >
        <KnowledgeGraph
          graph={graph}
          selectedId={noteId}
          onSelect={selectNote}
          highlightedIds={highlighted}
          query={query}
          active={streaming}
        />
        <SkillsArc groups={skills} selectedId={focusedSkill?.id ?? null} onSelect={selectSkill} />
        {!loading && graph && !graph.configured && (
          <div className="cortex-empty">
            <Database size={18} />
            <strong>Nenhum vault conectado</strong>
            <span>Conecte seu vault do Obsidian para ver as notas como um grafo.</span>
            <button onClick={() => navigate('/data-sources')}>Conectar fontes</button>
          </div>
        )}
        {error && (
          <div className="cortex-empty">
            <strong>Não foi possível carregar o grafo</strong>
            <span>{error}</span>
            <button onClick={reload}>Tentar de novo</button>
          </div>
        )}
        {graph?.truncated && (
          <div className="cortex-note">Exibindo {stats.notes} de {graph.total_notes} notas (mais conectadas)</div>
        )}
      </div>

      {!leftOpen && (
        <button className="cortex-reopen left" onClick={() => setLeftOpen(true)} title="Abrir painel"><PanelLeftOpen size={16} /></button>
      )}
      {!rightOpen && (
        <button className="cortex-reopen right" onClick={() => setRightOpen(true)} title="Abrir chat"><PanelRightOpen size={16} /></button>
      )}

      {leftOpen && (
        <aside className="cortex-panel left" style={{ width: LEFT_W }}>
          <header className="cortex-panel-head">
            <span className="cortex-brand"><i />MAPA DE CONHECIMENTO</span>
            <nav><button onClick={() => setLeftOpen(false)} title="Recolher"><PanelLeftClose size={14} /></button></nav>
          </header>

          <label className="cortex-search">
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar notas e pastas" />
          </label>

          <div className="cortex-stats">
            <div><b>{stats.notes}</b><span>notas</span></div>
            <div><b>{stats.links}</b><span>conexões</span></div>
            <div><b>{stats.folders}</b><span>pastas</span></div>
            <button onClick={reload} title="Recarregar vault" className={loading ? 'spin' : ''}><RefreshCw size={13} /></button>
          </div>

          <div className="cortex-scroll">
            <section>
              <h3>{focusedSkill ? 'Skill em foco' : 'Nota em foco'}</h3>
              {focusedSkill ? (
                <div className="cortex-note-card">
                  <strong>{focusedSkill.label}</strong>
                  <div className="meta">
                    <span className={`chip ${focusedSkill.state}`}>
                      {focusedSkill.state === 'active' ? 'em uso' : focusedSkill.state === 'locked' ? 'requer credenciais' : 'pronta'}
                    </span>
                    <span>{focusedSkill.tools.length} ferramentas</span>
                  </div>
                  <ul className="tool-list">
                    {focusedSkill.tools.map((t) => (
                      <li key={t.name}>
                        <b>{t.name}</b>
                        <span>{clip(t.description, 120)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="activity">
                    <span>EXECUÇÃO NA SESSÃO</span>
                    {focusedSkill.lastCall ? (
                      <>
                        <strong className={focusedSkill.lastCall.status}>
                          {focusedSkill.lastCall.tool} ·{' '}
                          {focusedSkill.lastCall.status === 'success' ? 'concluída' : focusedSkill.lastCall.status === 'error' ? 'atenção necessária' : 'em execução'}
                        </strong>
                        <p>{focusedSkill.lastCall.result ? clip(focusedSkill.lastCall.result, 180) : 'Chamada registrada; aguardando saída.'}</p>
                      </>
                    ) : (
                      <p>Sem execução registrada nesta sessão.</p>
                    )}
                  </div>
                </div>
              ) : note ? (
                <div className="cortex-note-card">
                  <strong>{note.title}</strong>
                  <small>{note.id}</small>
                  {note.excerpt && <p>{note.excerpt}</p>}
                  <div className="meta">
                    <span>{note.words} palavras</span>
                    <span>{note.degree} conexões</span>
                    <span>{new Date(note.mtime * 1000).toLocaleDateString()}</span>
                  </div>
                  {note.tags.length > 0 && (
                    <div className="tags">{note.tags.map((t) => <span key={t}>#{t}</span>)}</div>
                  )}
                  {linked.length > 0 && (
                    <ul className="links">
                      {linked.map((id) => (
                        <li key={id}><button onClick={() => selectNote(id)}>{nodeById.get(id)?.title ?? id}</button></li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="cortex-hint">Clique em uma nota do grafo ou em uma skill. Role para zoom, arraste para mover, duplo clique para recentralizar.</p>
              )}
            </section>

            <section>
              <h3><Wrench size={12} /> Skills <em>{activeSkills ? `${activeSkills} em uso` : `${tools.length} ferramentas`}</em></h3>
              {skills.length === 0 && <p className="cortex-hint">Nenhuma skill disponível.</p>}
              <ul className="cortex-skills">
                {skills.map((s) => (
                  <li key={s.id} className={focusedSkill?.id === s.id ? 'open' : ''}>
                    <button onClick={() => selectSkill(s.id)}>
                      <i className={s.state} />
                      <span>{s.label}</span>
                      <small>{s.tools.length}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </aside>
      )}

      {rightOpen && (
        <aside className="cortex-panel right" style={{ width: RIGHT_W }}>
          <header className="cortex-panel-head">
            <button className="cortex-model" onClick={() => setCommandPaletteOpen(true)} title="Trocar motor (Ctrl+K)">
              <Cpu size={13} /><span>{modelLabel}</span>
            </button>
            <nav>
              <button onClick={() => createConversation(selectedModel)} title="Nova conversa"><Plus size={14} /></button>
              <button onClick={() => setRightOpen(false)} title="Recolher"><PanelRightClose size={14} /></button>
            </nav>
          </header>

          <section className="cortex-tokens">
            <div className="row">
              <span>Tokens da conversa</span>
              <b>{compact(tokens.total + liveTokens)}{liveTokens > 0 && <em> ~ao vivo</em>}</b>
            </div>
            <div className="bar" title={`entrada ${tokens.prompt} · saída ${tokens.completion}`}>
              <i style={{ width: `${tokens.total ? (tokens.prompt / tokens.total) * 100 : 0}%` }} />
            </div>
            <div className="row small">
              <span>entrada {compact(tokens.prompt)}</span>
              <span>saída {compact(tokens.completion)}</span>
            </div>
            {tokens.series.length > 1 && <Spark values={tokens.series} />}
            {savings && (
              <div className="row small total">
                <span>Acumulado: {compact(savings.total_tokens)} tokens · {savings.total_calls} chamadas</span>
                <span>
                  {savings.per_provider.slice(0, 2).map((p) => `${p.label} $${p.total_cost.toFixed(2)}`).join(' · ')}
                </span>
              </div>
            )}
          </section>

          <div
            ref={listRef}
            className="cortex-messages"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {messages.length === 0 && !streaming ? (
              <div className="cortex-chat-empty">
                <Sparkles size={20} />
                <p>Pergunte sobre suas notas. As fontes citadas acendem no grafo.</p>
              </div>
            ) : (
              messages.map((m, i) => (
                <MessageBubble key={m.id} message={m} isLive={streaming && i === messages.length - 1 && m.role === 'assistant'} />
              ))
            )}
            {streaming && streamState.content === '' && (
              <div className="flex justify-start mb-4"><StreamingDots phase={streamState.phase} /></div>
            )}
          </div>

          <InputArea />
        </aside>
      )}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const w = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * w).toFixed(1)},${(20 - (v / max) * 18).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
