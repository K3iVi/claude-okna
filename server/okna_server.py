"""Reference sync server for the okna panel: python okna_server.py (stdlib only, Python 3.9+).

Each PC posts its windows to POST /<pc> about every 10 s and gets the other PCs' windows back.
Keys come from OKNA_KEYS (comma-separated); every key is one user, and PCs that share a key see
each other. State lives in memory: a restart forgets it, the next poll fills it again.

The panel only talks https: put this behind a reverse proxy (Caddy, nginx) or `tailscale serve`.
Listens on 127.0.0.1:8787 unless OKNA_HOST / OKNA_PORT say otherwise.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEYS = [k.strip() for k in os.environ.get("OKNA_KEYS", "").split(",") if k.strip()]
STALE_S = 15 * 60
MAX_BODY = 256 * 1024
PC = re.compile(r"^/([A-Za-z0-9_.-]{1,40})$")
RC_LINK = re.compile(r"^claude://claude\.ai/code/session_[A-Za-z0-9]{8,64}$")
FIELDS = {"title": 300, "snippet": 400, "lastActivityAt": 40, "rcLink": 120}

state: dict[str, dict[str, dict]] = {}  # key -> pc -> {"at": unix seconds, "rows": [...]}


def user_of(header: str) -> str | None:
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    return next((k for k in KEYS if token and hmac.compare_digest(k, token)), None)


def clean(row: dict) -> dict:
    out = {f: str(row.get(f, ""))[:n] for f, n in FIELDS.items()}
    out.update({f: bool(row.get(f)) for f in ("isRunning", "waiting", "unread")})
    if not RC_LINK.match(out["rcLink"]):  # the other PC opens this link: only a Remote Control link
        out["rcLink"] = ""
    return out


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        user = user_of(self.headers.get("Authorization", ""))
        match = PC.match(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if not user:
            return self.answer(401, {"error": "bad key"})
        if not match or length > MAX_BODY:
            return self.answer(400, {"error": "bad request"})
        try:
            rows = json.loads(self.rfile.read(length) or b"{}").get("rows", [])
            rows = [clean(r) for r in rows[:80] if isinstance(r, dict)]
        except (ValueError, AttributeError):
            return self.answer(400, {"error": "bad json"})
        now = int(time.time())
        pcs = state.setdefault(user, {})
        pcs[match.group(1)] = {"at": now, "rows": rows}
        others = [
            {"pc": pc, "at": s["at"], "rows": s["rows"]}
            for pc, s in sorted(pcs.items())
            if pc != match.group(1) and s["at"] >= now - STALE_S
        ]
        self.answer(200, {"pcs": others})

    def answer(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # no access log: titles are private
        pass


if __name__ == "__main__":
    if not KEYS:
        raise SystemExit("Set OKNA_KEYS, e.g. OKNA_KEYS=$(python -c \"import secrets; print(secrets.token_urlsafe(32))\")")
    host, port = os.environ.get("OKNA_HOST", "127.0.0.1"), int(os.environ.get("OKNA_PORT", "8787"))
    print(f"okna sync server on http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
