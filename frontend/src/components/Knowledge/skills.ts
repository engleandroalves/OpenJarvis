import type { ToolInfo } from '../../lib/api';
import type { ChatMessage, ToolCallInfo } from '../../types';

export type SkillState = 'active' | 'ready' | 'locked';

export interface SkillGroup {
  id: string;
  label: string;
  tools: ToolInfo[];
  state: SkillState;
  lastCall?: ToolCallInfo;
}

const LABELS: Record<string, string> = {
  math: 'CÁLCULO',
  reasoning: 'RACIOCÍNIO',
  memory: 'MEMÓRIA',
  inference: 'INFERÊNCIA',
  filesystem: 'ARQUIVOS',
  search: 'PESQUISA',
  code: 'CÓDIGO',
  storage: 'ARMAZENAMENTO',
  channel: 'CANAIS',
  network: 'REDE',
  system: 'SISTEMA',
  weather: 'CLIMA',
  finance: 'FINANÇAS',
  knowledge: 'CONHECIMENTO',
};

const MAX_GROUPS = 10;

/** Groups the tool catalog by category and derives each group's live state from the session's tool calls. */
export function buildSkillGroups(tools: ToolInfo[], messages: ChatMessage[]): SkillGroup[] {
  const byCategory = new Map<string, ToolInfo[]>();
  for (const tool of tools) {
    const key = (tool.category || 'outras').toLowerCase();
    const list = byCategory.get(key);
    if (list) list.push(tool);
    else byCategory.set(key, [tool]);
  }

  const ordered = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const head = ordered.slice(0, MAX_GROUPS - 1);
  const tail = ordered.slice(MAX_GROUPS - 1);
  const entries: Array<[string, ToolInfo[]]> =
    tail.length > 1 ? [...head, ['outras', tail.flatMap(([, list]) => list)]] : ordered.slice(0, MAX_GROUPS);

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const recent = new Set((lastAssistant?.toolCalls ?? []).map((c) => c.tool));
  const calls = messages.flatMap((m) => m.toolCalls ?? []);

  return entries.map(([id, list]) => {
    const names = new Set(list.map((t) => t.name));
    const groupCalls = calls.filter((c) => names.has(c.tool));
    const lastCall = groupCalls[groupCalls.length - 1];
    const isActive = groupCalls.some((c) => c.status === 'running') || list.some((t) => recent.has(t.name));
    const locked = list.every((t) => t.requires_credentials && !t.configured);
    return {
      id,
      label: LABELS[id] ?? id.toUpperCase(),
      tools: list,
      state: isActive ? 'active' : locked ? 'locked' : 'ready',
      lastCall,
    };
  });
}
