"""Token cost of the same read-only tasks: official Plane MCP server vs plane-agent.

    pip install tiktoken
    python bench/run.py KEY-N        # needs uvx, node, and the PLANE_* variables from the README

Only reads. Counts the text each call would put in an agent's context (o200k_base).
"""
import json, os, subprocess, sys
from pathlib import Path
import tiktoken

MCP_VERSION = "0.3.4"
enc = tiktoken.get_encoding("o200k_base")
tok = lambda s: len(enc.encode(s if isinstance(s, str) else json.dumps(s)))
key, project = sys.argv[1], os.environ["PLANE_PROJECT_ID"]
base = os.environ.get("PLANE_API_BASE", "https://api.plane.so/api/v1").removesuffix("/api/v1")

mcp = subprocess.Popen(["uvx", f"plane-mcp-server@{MCP_VERSION}", "stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, env=dict(os.environ, PLANE_BASE_URL=base), text=True, encoding="utf-8")
seq = 0
def rpc(method, params=None, notify=False):
    global seq
    msg = {"jsonrpc": "2.0", "method": method, **({"params": params} if params is not None else {})}
    if not notify: seq += 1; msg["id"] = seq
    mcp.stdin.write(json.dumps(msg) + "\n"); mcp.stdin.flush()
    while not notify:
        r = json.loads(mcp.stdout.readline())
        if r.get("id") == seq: return r
def call(name, **args):
    r = rpc("tools/call", {"name": name, "arguments": args})["result"]
    if r.get("isError"): sys.exit(f"MCP {name} failed: {r}")
    text = "".join(c.get("text", "") for c in r["content"])  # content only: structuredContent would double it
    return tok(text), json.loads(text)
rows = lambda d: d["results"] if isinstance(d, dict) else d

def cli(*args):
    out = subprocess.run(["node", str(Path(__file__).parent.parent / "plane-agent.mjs"), *args], capture_output=True, text=True, encoding="utf-8", check=True).stdout
    return tok(out), (out if args[0] == "help" else json.loads(out))

rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "bench", "version": "0"}})
rpc("notifications/initialized", notify=True)
tools = rpc("tools/list")["result"]["tools"]
workitem_schema = tok(next(t for t in tools if t["name"] == "workitem"))

show_t, issue = call("workitem", action="retrieve_by_identifier", workitem_identifier=key)
states_t, states = call("state", action="list", project_id=project)
labels_t, _ = call("label", action="list", project_id=project)
comments_t, _ = call("workitem_comment", action="list", project_id=project, workitem_id=issue["id"])
todo_id = next(s["id"] for s in rows(states) if s["name"] == "Todo")
todo_t, todo = call("workitem", action="list", project_id=project, pql=f'state = "{todo_id}"')
rel_t = sum(call("workitem_relation", action="list", project_id=project, workitem_id=w["id"])[0] for w in rows(todo))
mcp.kill()

c_show, _ = cli("show", key)
c_comments, comments = cli("comments", key)
c_ready, _ = cli("ready")
verbs = cli("help")[0]

print(f"| Task | Official MCP server {MCP_VERSION} | plane-agent |\n|---|---|---|")
print(f"| Tool definitions | {tok(tools):,} for all {len(tools)} tools ({workitem_schema:,} for `workitem` alone) | {verbs:,} for `plane-agent help`, read once |")
print(f"| Read one issue | {show_t:,} IDs only, {show_t + states_t + labels_t:,} with state and label names | {c_show:,} |")
print(f"| Read its comments ({len(comments)}) | {comments_t:,} | {c_comments:,} |")
print(f"| What can I work on next ({len(rows(todo))} Todo items) | {states_t + todo_t + rel_t:,}, blocker states still unresolved | {c_ready:,} |")
