# plane-agent

A command-line tool for AI coding agents that work from a [Plane](https://plane.so) backlog.
You pass names in and get compact JSON back, and every write is checked.

## The problem

There are two usual ways to connect an agent to Plane, and both cost more than they should.

The official MCP server has 30 tools, and their schemas come to about 18k tokens. Its replies are full API objects, with states and labels given as UUIDs. All of it stays in the agent's context and gets paid for again on every later turn.

Calling the REST API directly is even worse. Every state, label and module is a UUID you have to look up first. Lists are paginated, and you get rate limited. A write can return 200 and still fail to stick. For example, a markdown comment can be stored as literal text, or a label can be dropped. The agent reports success either way.

There's also no "what should I work on next" call. Working out which Todo items have no open blockers takes one request per item, so agents tend to skip it.

## What this does

- **Names in, compact JSON out.** `state ABC-12 "In Progress"` works without any UUIDs. `show` returns six fields, not the whole object.
- **Every write is read back.** States, labels, descriptions, blockers, module moves and comments are fetched again after the write. A mismatch exits with a nonzero code and doesn't claim success.
- **`ready` gives the queue.** It lists Todo items whose blockers are all closed, ranked by priority, then by issue number. A blocker in another project counts as open.
- **Safe to run unattended.** It honors `Retry-After`, times out after 30 s, rejects redirects and never prints your key. A failed module move puts the issue back in the module it came from.
- **One file, no dependencies.** It needs Node 18 or later. There's no build step and no server to keep running.

## Numbers

Tokens each task adds to the agent's context:

| Task | Official MCP server | plane-agent |
|---|---|---|
| Tool definitions | 18,464 for all 30 tools (1,530 for `workitem` alone if your client loads tools on demand) | 546 for `plane-agent help`, read once |
| Read one issue | 926 with IDs only, 6,097 after looking up state and label names | 183 |
| Read its comments (4) | 1,945 | 514 |
| What can I work on next (4 Todo items) | 4,874 to list states, list Todo items and get each item's relations. Blocker states are still unresolved at that point | 146 |

Measured on 2026-10-13 against `plane-mcp-server` 0.3.4 and a self-hosted Plane, using read-only calls on the same issue, counted with tiktoken `o200k_base`. Other tokenizers give different absolute counts. To rerun it on your own project: `python bench/run.py KEY-N`.

## Install

```
npm install -g github:ollo12-prog/plane-agent-cli
```

## Configure

| Variable | Required | Meaning |
|---|---|---|
| `PLANE_API_KEY` | yes | Personal API token |
| `PLANE_WORKSPACE_SLUG` | yes | Workspace slug from the URL |
| `PLANE_PROJECT_ID` | yes | Project UUID |
| `PLANE_PROJECT_PREFIX` | yes | Issue prefix, e.g. `ABC` |
| `PLANE_API_BASE` | no | Defaults to `https://api.plane.so/api/v1`. For self-hosted, use `https://your-host/api/v1` |
| `PLANE_SKIP_LABELS` | no | Labels that `ready` hides, e.g. `blocked:owner`. `ready --label X` brings one back |
| `PLANE_CLOSED_STATES` | no | States that count as closed for blockers. Default `Done,Cancelled` |
| `PLANE_COMMENT_CAP` | no | Maximum comment length in characters. Default 400, `0` turns it off |
| `PLANE_MODULE_ALIAS` | no | A regex that gives modules short names, e.g. `\bP\d+\b` so "Phase 2 (P2)" also answers to `P2` |

Run `plane-agent selftest` to check the connection. It only reads.

## How an agent learns it

Add one line to your `AGENTS.md` or `CLAUDE.md`:

> Plane: use the `plane-agent` CLI for every tracker operation. Run `plane-agent help` once per session before the first call.

That's the whole setup. `plane-agent help` is written for an agent that has never seen the tool. It's organised by intent ("what should I work on next?" points to `ready`), gives the output shape of every verb, and lists the typical loop:

```
ready -> state KEY "In Progress" -> (work) -> comment KEY "what changed" -> state KEY Done
```

It costs about 500 tokens, once, and the agent never has to read the code. The help text ships inside the binary, so it always matches the installed version.

Some examples:

```
plane-agent ready                              # [{key,name,priority,labels}], best first
plane-agent ready --label frontend             # a queue for an agent that only does frontend work
plane-agent show ABC-12
plane-agent state ABC-12 "In Progress"
plane-agent comment ABC-12 "Fixed in a1b2c3d. Tests **green**."
plane-agent block ABC-12 add ABC-9             # ABC-12 is blocked by ABC-9
plane-agent create "Fix login" --priority high --labels bug --desc -   # description from stdin
```

## License

MIT
