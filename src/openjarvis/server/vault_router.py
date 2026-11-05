"""HTTP route: ``GET /v1/vault/graph`` — note graph of the connected vault(s).

Builds a lightweight graph (notes as nodes, ``[[wikilinks]]`` as edges) from the
roots already configured on the Obsidian connector. Roots are re-authorized
against ``security.allowed_dirs`` on every request, so this endpoint never
widens the filesystem boundary enforced by the connector itself.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from openjarvis.connectors.obsidian import _SKIP_DIRS, _parse_frontmatter

router = APIRouter(prefix="/v1/vault", tags=["vault"])

_NOTE_EXTENSIONS = {".md", ".markdown"}
_MAX_READ_BYTES = 64 * 1024
_DEFAULT_MAX_NODES = 2000
_HARD_MAX_NODES = 5000

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z][\w/-]*)")
_MARKUP_RE = re.compile(r"!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|[#>*_`~]|\[([^\]]*)\]\([^)]*\)")


def _excerpt(body: str, limit: int = 180) -> str:
    def _plain(match: re.Match[str]) -> str:
        return match.group(2) or match.group(1) or match.group(3) or ""

    text = _MARKUP_RE.sub(_plain, body)
    text = " ".join(text.split())
    return text[:limit]


def _frontmatter_tags(value: Any) -> List[str]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        items = value.split(",")
    else:
        return []
    return [str(t).strip().lstrip("#") for t in items if str(t).strip()]


def build_vault_graph(
    roots: Sequence[Path], max_nodes: int = _DEFAULT_MAX_NODES
) -> Dict[str, Any]:
    """Return ``{nodes, edges, ...}`` for the Markdown notes under *roots*."""
    notes: List[Dict[str, Any]] = []
    raw_links: Dict[str, List[str]] = {}
    by_key: Dict[str, List[str]] = {}

    for root_index, root in enumerate(roots):
        root_name = root.name or f"root-{root_index}"
        for walk_root, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
            for filename in files:
                path = Path(walk_root) / filename
                if path.suffix.lower() not in _NOTE_EXTENSIONS or path.is_symlink():
                    continue
                try:
                    stat = path.stat()
                    with path.open("r", encoding="utf-8", errors="replace") as fh:
                        text = fh.read(_MAX_READ_BYTES)
                except OSError:
                    continue

                rel = path.relative_to(root).as_posix()
                note_id = rel if root_index == 0 else f"{root_name}/{rel}"
                meta, body = _parse_frontmatter(text)
                stripped = _FENCE_RE.sub("", body)

                tags = _frontmatter_tags(meta.get("tags"))
                for tag in _TAG_RE.findall(stripped):
                    if tag not in tags:
                        tags.append(tag)

                folder = rel.split("/", 1)[0] if "/" in rel else ""
                notes.append(
                    {
                        "id": note_id,
                        "title": str(meta.get("title") or path.stem),
                        "folder": folder or root_name,
                        "tags": tags[:6],
                        "words": len(stripped.split()),
                        "mtime": int(stat.st_mtime),
                        "excerpt": _excerpt(stripped),
                    }
                )
                raw_links[note_id] = _WIKILINK_RE.findall(stripped)
                by_key.setdefault(path.stem.lower(), []).append(note_id)
                by_key.setdefault(note_id.rsplit(".", 1)[0].lower(), []).append(note_id)

    edges: set[Tuple[str, str]] = set()
    for source, targets in raw_links.items():
        for raw in targets:
            key = raw.strip().replace("\\", "/").lower()
            key = key.rsplit(".", 1)[0] if key.endswith((".md", ".markdown")) else key
            candidates = by_key.get(key) or by_key.get(key.rsplit("/", 1)[-1])
            if not candidates:
                continue
            target = candidates[0]
            if target != source:
                edges.add((source, target) if source < target else (target, source))

    degree: Dict[str, int] = {}
    for a, b in edges:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1

    total = len(notes)
    truncated = total > max_nodes
    if truncated:
        notes.sort(key=lambda n: (-degree.get(n["id"], 0), -n["mtime"]))
        notes = notes[:max_nodes]
        kept = {n["id"] for n in notes}
        edges = {(a, b) for a, b in edges if a in kept and b in kept}
        degree = {k: v for k, v in degree.items() if k in kept}

    for note in notes:
        note["degree"] = degree.get(note["id"], 0)

    return {
        "nodes": notes,
        "edges": [{"source": a, "target": b} for a, b in sorted(edges)],
        "total_notes": total,
        "truncated": truncated,
    }


def _configured_roots(config: Any) -> List[Path]:
    from openjarvis.connectors.obsidian import ObsidianConnector
    from openjarvis.server import connectors_router

    connector = connectors_router._instances.get("obsidian") or ObsidianConnector()
    roots = [
        connectors_router._authorize_filesystem_connector_path(p, config)
        for p in getattr(connector, "_vault_paths", [])
    ]
    return roots


@router.get("/graph")
async def vault_graph(request: Request, max_nodes: Optional[int] = None):
    """Return the note graph for the configured Obsidian vault(s)."""
    limit = min(max(max_nodes or _DEFAULT_MAX_NODES, 1), _HARD_MAX_NODES)
    try:
        roots = _configured_roots(getattr(request.app.state, "config", None))
    except PermissionError as exc:
        return JSONResponse(status_code=403, content={"detail": str(exc)})
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    if not roots:
        return {
            "configured": False,
            "nodes": [],
            "edges": [],
            "total_notes": 0,
            "truncated": False,
        }

    graph = await run_in_threadpool(build_vault_graph, roots, limit)
    return {"configured": True, "roots": [r.name for r in roots], **graph}
