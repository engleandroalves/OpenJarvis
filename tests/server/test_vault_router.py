"""Tests for the /v1/vault graph router."""

from __future__ import annotations

from pathlib import Path

import pytest

from openjarvis.server.vault_router import build_vault_graph


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_graph_resolves_wikilinks_and_tags(tmp_path: Path):
    _write(tmp_path, "Alpha.md", "---\ntags: [ideas]\n---\nSee [[Beta]] and [[sub/Gamma|alias]] #inline\n")
    _write(tmp_path, "Beta.md", "# Beta\nBack to [[Alpha#Heading]]")
    _write(tmp_path, "sub/Gamma.md", "Orphan [[Missing]]")
    _write(tmp_path, ".obsidian/skip.md", "hidden")
    _write(tmp_path, "notes.txt", "not a note")

    graph = build_vault_graph([tmp_path])

    ids = {n["id"] for n in graph["nodes"]}
    assert ids == {"Alpha.md", "Beta.md", "sub/Gamma.md"}
    assert {(e["source"], e["target"]) for e in graph["edges"]} == {
        ("Alpha.md", "Beta.md"),
        ("Alpha.md", "sub/Gamma.md"),
    }
    alpha = next(n for n in graph["nodes"] if n["id"] == "Alpha.md")
    assert alpha["tags"] == ["ideas", "inline"]
    assert alpha["degree"] == 2
    assert graph["truncated"] is False


def test_graph_truncates_by_degree(tmp_path: Path):
    _write(tmp_path, "hub.md", "[[a]] [[b]]")
    _write(tmp_path, "a.md", "x")
    _write(tmp_path, "b.md", "x")
    _write(tmp_path, "lonely.md", "x")

    graph = build_vault_graph([tmp_path], max_nodes=3)

    assert graph["truncated"] is True
    assert graph["total_notes"] == 4
    assert "lonely.md" not in {n["id"] for n in graph["nodes"]}


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from openjarvis.server import connectors_router
    from openjarvis.server.vault_router import router

    _write(tmp_path, "One.md", "[[Two]]")
    _write(tmp_path, "Two.md", "hello")

    class _Fake:
        _vault_paths = [str(tmp_path)]

    monkeypatch.setitem(connectors_router._instances, "obsidian", _Fake())
    app = fastapi.FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_endpoint_returns_graph(client):
    resp = client.get("/v1/vault/graph")
    assert resp.status_code == 200
    data = resp.json()
    assert data["configured"] is True
    assert len(data["nodes"]) == 2
    assert len(data["edges"]) == 1


def test_endpoint_not_configured(monkeypatch):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from openjarvis.server import connectors_router
    from openjarvis.server.vault_router import router

    class _Empty:
        _vault_paths: list[str] = []

    monkeypatch.setitem(connectors_router._instances, "obsidian", _Empty())
    app = fastapi.FastAPI()
    app.include_router(router)
    data = TestClient(app).get("/v1/vault/graph").json()
    assert data["configured"] is False
    assert data["nodes"] == []
