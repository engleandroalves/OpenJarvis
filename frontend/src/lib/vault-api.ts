import { apiFetch } from './api';

export interface VaultNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  words: number;
  mtime: number;
  excerpt: string;
  degree: number;
}

export interface VaultEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  configured: boolean;
  roots?: string[];
  nodes: VaultNode[];
  edges: VaultEdge[];
  total_notes: number;
  truncated: boolean;
}

export async function fetchVaultGraph(maxNodes?: number): Promise<VaultGraph> {
  const qs = maxNodes ? `?max_nodes=${maxNodes}` : '';
  const res = await apiFetch(`/v1/vault/graph${qs}`);
  if (!res.ok) {
    let detail = `Falha ao ler o vault (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // keep the status-based message
    }
    throw new Error(detail);
  }
  return res.json();
}
