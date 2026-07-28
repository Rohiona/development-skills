#!/usr/bin/env python3
"""
memory_tool.py - Claude Code memory CLI with semantic search.

Directly accesses claude-mem's SQLite + ChromaDB databases.
No MCP server required - runs as a standalone CLI via uv.

Usage:
    uv run --with chromadb python3 memory_tool.py save --title "..." --text "..." [--type discovery] [--project myproject]
    uv run --with chromadb python3 memory_tool.py search "query" [--limit 10] [--project myproject]
    uv run --with chromadb python3 memory_tool.py recent [--limit 10] [--project myproject]
    uv run --with chromadb python3 memory_tool.py stats [--project myproject]
    uv run --with chromadb python3 memory_tool.py deprecate --old 15,25,26 --new 1741
    uv run --with chromadb python3 memory_tool.py save --title "..." --text "..." --replaces 15,25,26
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

CLAUDE_MEM_DIR = Path.home() / ".claude-mem"
SQLITE_DB = CLAUDE_MEM_DIR / "claude-mem.db"
CHROMA_DIR = CLAUDE_MEM_DIR / "chroma"
COLLECTION_NAME = "cm__claude-mem"
SUPPORTED_SEARCH_DOC_TYPES = ["observation", "session_summary"]


def extract_notion_id(url_or_id: str) -> str:
    """Extract a Notion page UUID from a URL or raw ID.

    Accepts:
      - Full URL: https://www.notion.so/workspace/Page-Title-abc123...
      - UUID with dashes: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      - Raw 32-char hex: abc123def456...
    Returns a dash-formatted UUID.
    """
    # Strip whitespace
    s = url_or_id.strip().rstrip("/")

    # If it's a URL, take the last path segment and extract hex from the end
    if "/" in s:
        last_segment = s.split("/")[-1]
        # Query params
        last_segment = last_segment.split("?")[0]
        # Notion URLs: Title-<32hex> or just <32hex>
        match = re.search(r"([0-9a-f]{32})$", last_segment.replace("-", ""))
        if match:
            h = match.group(1)
            return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"

    # Already a UUID with dashes
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", s):
        return s

    # Raw 32-char hex
    h = s.replace("-", "")
    if re.match(r"^[0-9a-f]{32}$", h):
        return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"

    # Return as-is if it doesn't match any pattern (user might pass a custom key)
    return s


def get_sqlite_conn():
    if not SQLITE_DB.exists():
        print(f"Error: Database not found at {SQLITE_DB}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(str(SQLITE_DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS superseded (
               old_id INTEGER PRIMARY KEY,
               new_id INTEGER NOT NULL,
               marked_at TEXT NOT NULL)"""
    )
    return conn


def parse_id_list(csv_str):
    """Parse comma-separated integer IDs."""
    if not csv_str or not csv_str.strip():
        return []
    return [int(x.strip()) for x in csv_str.split(",") if x.strip()]


def record_exists(conn, record_id):
    """Check whether a record ID exists in observations or session_summaries."""
    row = conn.execute("SELECT 1 FROM observations WHERE id = ?", (record_id,)).fetchone()
    if row:
        return True
    row = conn.execute("SELECT 1 FROM session_summaries WHERE id = ?", (record_id,)).fetchone()
    return row is not None


def get_superseded_map(conn):
    """Return mapping of superseded old_id -> new_id."""
    rows = conn.execute("SELECT old_id, new_id FROM superseded").fetchall()
    return {row["old_id"]: row["new_id"] for row in rows}


def mark_superseded(conn, old_ids, new_id, warn_missing=False):
    """Insert superseded rows. Returns list of old_ids successfully marked."""
    now_iso = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    marked = []
    for old_id in old_ids:
        if warn_missing and not record_exists(conn, old_id):
            print(f"Warning: old_id {old_id} not found, skipping", file=sys.stderr)
            continue
        conn.execute(
            "INSERT OR REPLACE INTO superseded (old_id, new_id, marked_at) VALUES (?, ?, ?)",
            (old_id, new_id, now_iso),
        )
        marked.append(old_id)
    conn.commit()
    return marked


def apply_superseded_filter(output, superseded_map, include_superseded=False):
    """Filter or annotate output based on superseded status. Returns (output, suppressed_count)."""
    if include_superseded:
        for item in output:
            sid = item.get("id")
            if sid in superseded_map:
                item["superseded_by"] = superseded_map[sid]
        return output, 0

    filtered = []
    suppressed = 0
    for item in output:
        if item.get("id") in superseded_map:
            suppressed += 1
        else:
            filtered.append(item)
    return filtered, suppressed


def get_chroma_collection():
    try:
        import chromadb

        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        return client.get_collection(COLLECTION_NAME)
    except Exception as e:
        print(f"Error: Failed to open ChromaDB: {e}", file=sys.stderr)
        sys.exit(1)


def build_chroma_where_filter(project=None, notion_id="", doc_types=None):
    """Build a Chroma where filter with valid single-operator shape."""
    conditions = []
    if project:
        conditions.append({"project": project})
    if notion_id:
        conditions.append({"notion_id": notion_id})
    if doc_types:
        conditions.append({"doc_type": {"$in": doc_types}})

    if len(conditions) == 0:
        return None
    if len(conditions) == 1:
        return conditions[0]
    return {"$and": conditions}


def build_fts_query(query):
    """Convert arbitrary user text into a conservative FTS5 OR query."""
    tokens = []
    for token in re.findall(r"[^\W_]+", query, flags=re.UNICODE):
        if token not in tokens:
            tokens.append(token)
    if not tokens:
        return ""
    return " OR ".join(f'"{token}"' for token in tokens)


def add_candidate(candidates, item):
    """Merge candidates by table-aware key, keeping the strongest score."""
    key = (item["doc_type"], item["sqlite_id"])
    existing = candidates.get(key)
    if not existing or item["score"] > existing["score"]:
        candidates[key] = item


def search_observations_fts(conn, query, project, limit):
    fts_query = build_fts_query(query)
    if not fts_query:
        return []

    sql = """
        SELECT
            o.id,
            bm25(observations_fts, 5.0, 2.0, 1.0, 1.0, 3.0, 1.0) AS rank
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
    """
    params = [fts_query]
    if project:
        sql += " AND o.project = ?"
        params.append(project)
    sql += " ORDER BY rank LIMIT ?"
    params.append(limit)

    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []

    return [
        {
            "sqlite_id": row["id"],
            "doc_type": "observation",
            "score": 2.0 + (1.0 / (1.0 + index)),
            "source": "fts",
            "matched_field": "fts",
            "distance": None,
        }
        for index, row in enumerate(rows)
    ]


def search_session_summaries_fts(conn, query, project, limit):
    fts_query = build_fts_query(query)
    if not fts_query:
        return []

    sql = """
        SELECT
            s.id,
            bm25(session_summaries_fts, 5.0, 1.0, 3.0, 3.0, 2.0, 1.0) AS rank
        FROM session_summaries_fts
        JOIN session_summaries s ON s.id = session_summaries_fts.rowid
        WHERE session_summaries_fts MATCH ?
    """
    params = [fts_query]
    if project:
        sql += " AND s.project = ?"
        params.append(project)
    sql += " ORDER BY rank LIMIT ?"
    params.append(limit)

    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []

    return [
        {
            "sqlite_id": row["id"],
            "doc_type": "session_summary",
            "score": 1.8 + (1.0 / (1.0 + index)),
            "source": "fts",
            "matched_field": "fts",
            "distance": None,
        }
        for index, row in enumerate(rows)
    ]


# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------


def cmd_save(args):
    """Save a new observation to SQLite and ChromaDB."""
    conn = get_sqlite_conn()
    collection = get_chroma_collection()

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    now_epoch = int(now.timestamp() * 1000)

    # Ensure a session record exists (required by FK constraint)
    memory_session_id = args.session_id or f"cli-{uuid.uuid4()}"
    content_session_id = f"cli-content-{uuid.uuid4()}"

    existing = conn.execute(
        "SELECT id FROM sdk_sessions WHERE memory_session_id = ?",
        (memory_session_id,),
    ).fetchone()
    if not existing:
        conn.execute(
            """INSERT INTO sdk_sessions
               (content_session_id, memory_session_id, project, user_prompt,
                started_at, started_at_epoch, status)
               VALUES (?, ?, ?, ?, ?, ?, 'completed')""",
            (content_session_id, memory_session_id, args.project, args.title, now_iso, now_epoch),
        )

    # Resolve Notion ID if provided
    notion_id = ""
    if args.notion_id:
        notion_id = extract_notion_id(args.notion_id)

    content_hash = sha256(args.text.encode()).hexdigest()[:16]

    # Parse facts: accept JSON array or newline-separated text
    facts_text = args.facts or ""
    facts_list = []
    if facts_text:
        try:
            facts_list = json.loads(facts_text)
        except json.JSONDecodeError:
            facts_list = [f.strip() for f in facts_text.split("\n") if f.strip()]
        facts_text = json.dumps(facts_list, ensure_ascii=False)

    concepts = args.concepts or ""

    # --- SQLite insert ---
    cursor = conn.execute(
        """INSERT INTO observations
           (memory_session_id, project, text, type, title, subtitle,
            facts, narrative, concepts, files_read, files_modified,
            prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            memory_session_id,
            args.project,
            args.text,
            args.type,
            args.title,
            args.subtitle or "",
            facts_text,
            args.text,  # narrative = text
            concepts,
            args.files_read or "",
            args.files_modified or "",
            0,  # prompt_number
            0,  # discovery_tokens
            now_iso,
            now_epoch,
            content_hash,
        ),
    )
    obs_id = cursor.lastrowid
    conn.commit()

    # --- ChromaDB insert ---
    metadata_base = {
        "sqlite_id": obs_id,
        "memory_session_id": memory_session_id,
        "type": args.type,
        "title": args.title,
        "subtitle": args.subtitle or "",
        "doc_type": "observation",
        "created_at_epoch": now_epoch,
        "concepts": concepts,
        "project": args.project,
    }
    if args.files_read:
        metadata_base["files_read"] = args.files_read
    if args.files_modified:
        metadata_base["files_modified"] = args.files_modified
    if notion_id:
        metadata_base["notion_id"] = notion_id

    chroma_ids = []
    chroma_docs = []
    chroma_metas = []

    # title/subtitle embeddings improve recall for ticket IDs, short labels, and Japanese summaries.
    chroma_ids.append(f"obs_{obs_id}_title")
    chroma_docs.append(args.title)
    chroma_metas.append({**metadata_base, "field_type": "title"})

    if args.subtitle:
        chroma_ids.append(f"obs_{obs_id}_subtitle")
        chroma_docs.append(args.subtitle)
        chroma_metas.append({**metadata_base, "field_type": "subtitle"})

    # narrative embedding
    chroma_ids.append(f"obs_{obs_id}_narrative")
    chroma_docs.append(args.text)
    chroma_metas.append({**metadata_base, "field_type": "narrative"})

    # fact embeddings
    for i, fact in enumerate(facts_list):
        chroma_ids.append(f"obs_{obs_id}_fact_{i}")
        chroma_docs.append(fact if isinstance(fact, str) else str(fact))
        chroma_metas.append({**metadata_base, "field_type": "fact", "fact_index": i})

    collection.add(ids=chroma_ids, documents=chroma_docs, metadatas=chroma_metas)

    result = {"status": "saved", "id": obs_id, "chroma_docs": len(chroma_ids)}
    if notion_id:
        result["notion_id"] = notion_id
    if args.replaces:
        replace_ids = parse_id_list(args.replaces)
        marked = mark_superseded(conn, replace_ids, obs_id, warn_missing=True)
        result["replaces"] = marked
    print(json.dumps(result, ensure_ascii=False))
    conn.close()


# ---------------------------------------------------------------------------
# search (semantic)
# ---------------------------------------------------------------------------


def cmd_search(args):
    """Hybrid search via ChromaDB semantic search and SQLite FTS."""
    collection = get_chroma_collection()
    conn = get_sqlite_conn()

    notion_id = ""
    if args.notion_id:
        notion_id = extract_notion_id(args.notion_id)

    where_filter = build_chroma_where_filter(
        project=args.project,
        notion_id=notion_id,
        doc_types=SUPPORTED_SEARCH_DOC_TYPES,
    )

    results = collection.query(
        query_texts=[args.query],
        n_results=max(args.limit * 10, 50),
        where=where_filter,
        include=["metadatas", "documents", "distances"],
    )

    candidates = {}
    for i, meta in enumerate(results["metadatas"][0]):
        doc_type = meta.get("doc_type", "observation")
        if doc_type not in SUPPORTED_SEARCH_DOC_TYPES:
            continue

        sid = meta.get("sqlite_id")
        if sid is None:
            continue

        dist = results["distances"][0][i]
        add_candidate(
            candidates,
            {
                "sqlite_id": sid,
                "distance": dist,
                "doc_type": doc_type,
                "matched_field": meta.get("field_type", ""),
                "matched_text": results["documents"][0][i][:200],
                "score": 1.0 / (1.0 + dist),
                "source": "semantic",
            },
        )

    # Notion IDs are stored only in Chroma metadata, so SQLite FTS cannot safely apply that filter.
    if not notion_id:
        fts_limit = max(args.limit * 3, 20)
        for item in search_observations_fts(conn, args.query, args.project, fts_limit):
            add_candidate(candidates, item)
        for item in search_session_summaries_fts(conn, args.query, args.project, fts_limit):
            add_candidate(candidates, item)

    ranked = sorted(candidates.values(), key=lambda x: x["score"], reverse=True)[: args.limit]

    output = []
    for item in ranked:
        sid = item["sqlite_id"]
        doc_type = item["doc_type"]

        if doc_type == "observation":
            row = conn.execute(
                "SELECT id, project, type, title, subtitle, narrative, created_at FROM observations WHERE id = ?",
                (sid,),
            ).fetchone()
            if row:
                output.append(
                    {
                        "id": row["id"],
                        "doc_type": "observation",
                        "project": row["project"],
                        "type": row["type"],
                        "title": row["title"],
                        "subtitle": row["subtitle"],
                        "narrative": row["narrative"][:500] if row["narrative"] else "",
                        "created_at": row["created_at"],
                        "distance": round(item["distance"], 4) if item["distance"] is not None else None,
                        "matched_field": item["matched_field"],
                        "source": item["source"],
                    }
                )
        elif doc_type == "session_summary":
            row = conn.execute(
                "SELECT id, project, request, investigated, learned, completed, next_steps, created_at FROM session_summaries WHERE id = ?",
                (sid,),
            ).fetchone()
            if row:
                output.append(
                    {
                        "id": row["id"],
                        "doc_type": "session_summary",
                        "project": row["project"],
                        "request": row["request"][:300] if row["request"] else "",
                        "learned": row["learned"][:300] if row["learned"] else "",
                        "completed": row["completed"][:300] if row["completed"] else "",
                        "created_at": row["created_at"],
                        "distance": round(item["distance"], 4) if item["distance"] is not None else None,
                        "matched_field": item["matched_field"],
                        "source": item["source"],
                    }
                )

    superseded_map = get_superseded_map(conn)
    output, suppressed = apply_superseded_filter(output, superseded_map, args.include_superseded)

    if suppressed > 0:
        print(json.dumps({"results": output, "suppressed_superseded": suppressed}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(output, indent=2, ensure_ascii=False))
    conn.close()


# ---------------------------------------------------------------------------
# recent
# ---------------------------------------------------------------------------


def cmd_recent(args):
    """Show recent observations from SQLite."""
    conn = get_sqlite_conn()

    query = "SELECT id, project, type, title, subtitle, created_at FROM observations"
    params = []
    if args.project:
        query += " WHERE project = ?"
        params.append(args.project)
    query += " ORDER BY created_at_epoch DESC LIMIT ?"
    params.append(args.limit)

    rows = conn.execute(query, params).fetchall()
    output = [dict(row) for row in rows]

    superseded_map = get_superseded_map(conn)
    output, suppressed = apply_superseded_filter(output, superseded_map, args.include_superseded)

    if suppressed > 0:
        print(json.dumps({"results": output, "suppressed_superseded": suppressed}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(output, indent=2, ensure_ascii=False))
    conn.close()


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------


def cmd_stats(args):
    """Show database statistics."""
    conn = get_sqlite_conn()

    stats = {}
    for table in ["observations", "session_summaries", "sdk_sessions"]:
        query = f"SELECT COUNT(*) as cnt FROM {table}"  # noqa: S608 - trusted table names
        params = []
        if args.project and table != "sdk_sessions":
            query += " WHERE project = ?"
            params.append(args.project)
        row = conn.execute(query, params).fetchone()
        stats[table] = row["cnt"]

    try:
        collection = get_chroma_collection()
        stats["chroma_embeddings"] = collection.count()
    except Exception:
        stats["chroma_embeddings"] = "unavailable"

    print(json.dumps(stats, indent=2, ensure_ascii=False))
    conn.close()


# ---------------------------------------------------------------------------
# detail
# ---------------------------------------------------------------------------


def cmd_detail(args):
    """Show full detail of an observation or summary by ID."""
    conn = get_sqlite_conn()

    if args.doc_type == "observation":
        row = conn.execute("SELECT * FROM observations WHERE id = ?", (args.id,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM session_summaries WHERE id = ?", (args.id,)).fetchone()

    if not row:
        print(json.dumps({"error": f"Record {args.id} not found"}), file=sys.stderr)
        sys.exit(1)

    result = dict(row)
    superseded_map = get_superseded_map(conn)
    if args.id in superseded_map:
        result["superseded_by"] = superseded_map[args.id]

    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    conn.close()


# ---------------------------------------------------------------------------
# deprecate
# ---------------------------------------------------------------------------


def cmd_deprecate(args):
    """Mark old records as superseded by an existing record without creating a new one."""
    conn = get_sqlite_conn()

    old_ids = parse_id_list(args.old)
    new_id = args.new

    if not record_exists(conn, new_id):
        print(json.dumps({"error": f"new_id {new_id} not found"}), file=sys.stderr)
        sys.exit(1)

    for old_id in old_ids:
        if not record_exists(conn, old_id):
            print(json.dumps({"error": f"old_id {old_id} not found"}), file=sys.stderr)
            sys.exit(1)

    mark_superseded(conn, old_ids, new_id)
    print(json.dumps({"status": "deprecated", "old": old_ids, "new": new_id}, ensure_ascii=False))
    conn.close()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Claude Code memory tool")
    sub = parser.add_subparsers(dest="command", required=True)

    # save
    p_save = sub.add_parser("save", help="Save a new observation")
    p_save.add_argument("--title", required=True)
    p_save.add_argument("--text", required=True)
    p_save.add_argument("--type", default="discovery", choices=["discovery", "bugfix", "feature", "refactor", "change", "decision"])
    p_save.add_argument("--project", default="echo")
    p_save.add_argument("--subtitle", default="")
    p_save.add_argument("--facts", default="", help="JSON array or newline-separated facts")
    p_save.add_argument("--concepts", default="")
    p_save.add_argument("--files-read", default="", dest="files_read")
    p_save.add_argument("--files-modified", default="", dest="files_modified")
    p_save.add_argument("--session-id", default="", dest="session_id")
    p_save.add_argument("--notion-id", default="", dest="notion_id", help="Notion page URL or UUID to use as index")
    p_save.add_argument("--replaces", default="", help="Comma-separated record IDs to mark as superseded")
    p_save.set_defaults(func=cmd_save)

    # search
    p_search = sub.add_parser("search", help="Hybrid semantic + full-text search")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=10)
    p_search.add_argument("--project", default=None)
    p_search.add_argument("--notion-id", default="", dest="notion_id", help="Filter by Notion page UUID")
    p_search.add_argument(
        "--include-superseded",
        action="store_true",
        dest="include_superseded",
        help="Include superseded records (annotated with superseded_by)",
    )
    p_search.set_defaults(func=cmd_search)

    # recent
    p_recent = sub.add_parser("recent", help="Recent observations")
    p_recent.add_argument("--limit", type=int, default=10)
    p_recent.add_argument("--project", default=None)
    p_recent.add_argument(
        "--include-superseded",
        action="store_true",
        dest="include_superseded",
        help="Include superseded records (annotated with superseded_by)",
    )
    p_recent.set_defaults(func=cmd_recent)

    # stats
    p_stats = sub.add_parser("stats", help="Database statistics")
    p_stats.add_argument("--project", default=None)
    p_stats.set_defaults(func=cmd_stats)

    # detail
    p_detail = sub.add_parser("detail", help="Show full record detail")
    p_detail.add_argument("id", type=int)
    p_detail.add_argument("--type", dest="doc_type", default="observation", choices=["observation", "summary"])
    p_detail.set_defaults(func=cmd_detail)

    # deprecate
    p_deprecate = sub.add_parser("deprecate", help="Mark old records as superseded by an existing record")
    p_deprecate.add_argument("--old", required=True, help="Comma-separated old record IDs")
    p_deprecate.add_argument("--new", type=int, required=True, help="Replacement record ID")
    p_deprecate.set_defaults(func=cmd_deprecate)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
