.\" Manpage for `kanban run` (Open Kanban CLI runner).
.\" Companion page to kanban(1); see that page for shared concepts.
.TH KANBAN\-RUN 1 "2026-09-12" "0.1.0" "Open Kanban CLI"

.SH NAME
kanban\-run \- run the Open Kanban runner loop (claim → spawn agent → heartbeat → finish)

.SH SYNOPSIS
.B kanban run
[\fI\-\-config\fR \fIFILE\fR]
[{\fI\-\-board\fR \fIID\fR \fI\-\-status\fR \fIS\fR | \fI\-\-mine\fR}]
[\fI\-\-once\fR]
[\fI\-\-api\-url\fR \fIURL\fR]
[\fI\-\-profile\fR \fINAME\fR]
[\fI\-\-h\fR]

.SH DESCRIPTION
.B kanban run
drives the long\-lived runner loop described in
\fIdevDoc/CLI_RUNNER_PLAN_2026-09-12.md\fR.
On startup the command walks up from the current working directory
looking for a runner config file (see
.SS "CONFIGURATION"
below), validates it, then enters a loop that:

.IP \(bu 4
Calls
.B POST /api/v1/runs/claim
to atomically acquire the next eligible task whose column advertises
the runner's agent type.
.IP \(bu 4
Spawns the configured agent binary, passing it a rendered markdown
prompt that includes the board / column / task context, with the
task's own description appended as a closing \fB## Task Content\fR
section so the agent's last-read block is the actionable
instruction itself.
.IP \(bu 4
Calls
.B POST /api/v1/runs/:taskId/heartbeat
every
.IR heartbeatIntervalMs
milliseconds while the agent runs.
.IP \(bu 4
On exit, calls
.B POST /api/v1/runs/:taskId/finish
with \fBstatus\fR \fBcompleted\fR (exit code 0) or \fBfailed\fR
(non\-zero / timeout / signal). Failures also leave a comment via
.BR POST /api/v1/comments .

The loop is graceful on SIGINT and SIGTERM: the in\-flight agent is
sent SIGTERM and the runner releases its locks via
.B POST /api/v1/runs/release
before exiting.

.SH OPTIONS
.TP
.BR \-\-config " " \fIFILE\fR
Read the runner config from
.I FILE
instead of walking up from the current directory. Accepts the same
schema as the discovery files; useful for CI / cron jobs that pin a
specific config.
.TP
.BR \-\-board " " \fIID\fR
Mode\-1 (board\-bound): the board id to watch. Must be paired with
.B \-\-status
on the same command line. Mutually exclusive with
.BR \-\-mine .
.TP
.BR \-\-status " " \fIS\fR
Mode\-1 (board\-bound): the column status to watch. Allowed values:
\fBtodo\fR, \fBin_progress\fR, \fBreview\fR, \fBdone\fR. Must be paired
with
.B \-\-board
on the same command line.
.TP
.B \-\-mine
Mode\-2 (identity\-bound): pick from tasks assigned to (or routed to)
the authenticated agent, regardless of board or column. Mutually
exclusive with
.B \-\-board
and
.BR \-\-status .
When set, the active CLI profile must be logged in.
.TP
.B \-\-once
Process a single task and exit. The loop still installs SIGINT /
SIGTERM handlers, but does not poll for new claims once the first
task has been drained (or if no claim is available within the
configured poll interval). Handy for cron jobs and smoke tests.
.TP
.BR \-\-api\-url " " \fIURL\fR
See
.BR kanban (1).
.TP
.BR \-\-profile " " \fINAME\fR
See
.BR kanban (1).

.SH "CONFIGURATION"
The runner reads its settings from a YAML or JSON file. The discovery
walker (skipped when
.B \-\-config
is supplied) consults the following files in priority order, taking
the first hit:

.RS
.IP 1. 4
.I ./.kanban\-runner.local.yaml
(machine\-local override; should be gitignored)
.IP 2. 4
.I ./.kanban\-runner.yaml
(project\-shared config; checked in)
.IP 3. 4
.I ~/.config/kanban\-cli/runner.json
(global fallback)
.RE

When both a local override and a project file exist at the same
directory, they are deep\-merged (local wins on conflict; arrays are
replaced wholesale).

.SS "Schema (YAML, versioned)"
.PP
.RS
.nf
version: 1
apiUrl: http://localhost:8080
profile: opencoder
boardId: sys
status: todo
# mode: mine
agent:
  bin: opencode
  promptMode: arg          # arg | stdin | file | argv | acp
  promptArg: --prompt
  cwd: .
  args: ["--non-interactive"]
  env:
    KANBAN_API_URL: http://localhost:8080
  timeoutMs: 1800000
runner:
  runnerId: ""             # default: <host>\-<pid>\-<uuid>
  pollIntervalMs: 5000
  heartbeatIntervalMs: 30000
  lockTimeoutMs: 120000
  maxConcurrent: 1
  mode: claim              # claim | move
.fi
.RE

.SS "Validation"
The runner fails fast on startup when:
.IP \(bu 4
Both \fBboardId\fR + \fBstatus\fR are missing AND \fBmode\fR is not
\fBmine\fR.
.IP \(bu 4
\fBagent.bin\fR is not an absolute path on disk and is not resolvable
via \fBPATH\fR.
.IP \(bu 4
\fBrunner.lockTimeoutMs\fR is not strictly greater than 2× the
\fBrunner.heartbeatIntervalMs\fR (otherwise an in-flight task could
be reaped before its next heartbeat).
.IP \(bu 4
\fBmode: mine\fR is selected but the active CLI profile is not logged
in.
.IP \(bu 4
\fBagent.args\fR contains a \fB$name\fR token that does not match
one of the supported variables below.

.SS "Variable substitution in agent.args"
The runner recognises a narrow set of \fB$name\fR tokens anywhere in
\fBagent.args\fR (s-1187) and substitutes them with the corresponding
field of the in-flight task right before spawning the agent binary.
This lets operators compose argv shapes that depend on per-task data
without writing a wrapper script.

.RS
.IP \fB$taskId\fR 4
The claimed task id, e.g. \fBs-1187\fR.
.IP \fB$title\fR
The task's \fBtitle\fR field (empty when unset).
.IP \fB$body\fR
The task's description (empty when unset). The runner's internal
key is \fBbody\fR, matching how operators usually refer to the
free-form task content.
.IP \fB$priority\fR
The task's priority as a string (\fBhigh\fR / \fBmedium\fR / \fBlow\fR,
empty when unset).
.IP \fB$assignee\fR
The task's \fBassignee\fR (empty when unset).
.IP \fBcolumnId\fR
The task's current column id.
.IP \fBboardId\fR
The board id the runner is bound to (\fBboardId\fR from the config).
.RE

Unknown tokens (\fB$bogus\fR) fail at config-validation time with a
\fBRunnerConfigError\fR pointing at \fBagent.args\fR. Missing values
render as empty strings, so \fB--title=$title\fR becomes
\fB--title=\fR when the task has no title \-\- the operator's flag
indices stay stable across heterogeneous tasks.

Only the narrow \fB$name\fR form is recognised. POSIX shell-style
references (\fB${HOME}\fR, \fB$1\fR, \fB$$\fR, \fB$?\fR) pass through
unchanged.

.SS "Shell-style tokenisation of agent.args (s-1238)"
Each entry in \fBagent.args\fR is run through a POSIX shell-style
tokeniser before variable substitution and the prompt splice. This
lets operators write a multi-token CLI invocation as a single YAML
scalar instead of one entry per flag:

.RS
.IP
.nf
agent:
  args:
    - --auto true run "do-kanban $taskId"
.fi

.IP
becomes the four argv entries
\fB--auto\fR, \fBtrue\fR, \fBrun\fR, \fBdo-kanban <taskId>\fR at spawn
time, with single/double quotes honoured (text inside \fB'...\fR is
literal; \fB\\"\fR and \fB\\\\\fR escape inside \fB"..."\fR), and a
backslash outside quotes escaping the next character (so
\fB--key=a\\ b\fR produces \fB--key=a b\fR as one argv slot).

.RE

Entries with no whitespace and no quoting are returned untouched,
so the common \fBargs: ["--flag", "value"]\fR shape has zero
behaviour change. Unterminated quotes fail loudly with a
\fBRunnerConfigError\fR pointing at \fBagent.args\fR rather than
silently handing a malformed string to the agent binary.

.SS "Agent Client Protocol (s-1235)"
The runner speaks the
.IR "Agent Client Protocol"
(https://agentclientprotocol.com/) when
.B agent.promptMode
is set to
.BR acp .
The runner appends
.B agent.acpFlag
(default
.BR --acp )
to the agent's argv, opens the child's stdio as pipe/pipe/pipe,
and drives the full handshake over a line-delimited JSON-RPC
channel:

.RS
.IP \(bu 4
.B initialize
\- capability handshake (the runner advertises
.BR "open-kanban-cli" ).
.IP \(bu 4
.B session/new
\- opens a fresh session rooted at
.BR agent.cwd .
.IP \(bu 4
.B session/prompt
\- sends the rendered prompt (the same markdown the
non-ACP modes ship). Streamed
.B session/update
notifications with
.B sessionUpdate=agent_message_chunk
and
.B content.type=text
are concatenated into
.B result.stdout
and forwarded to
.B /api/v1/runs/:taskId/finish
as the agent's reply. The prompt itself never reaches disk or
argv, so the OS argv cap is irrelevant.
.RE

Use
.B acp
for mainstream agents that ship an
.B --acp
opt-in:

.RS
.IP \(bu 4
.B "claude --acp"
.IP \(bu 4
.B "opencode acp"
.IP \(bu 4
.B "gemini --acp"
.RE

Override
.B agent.acpFlag
when your binary uses a different opt-in (e.g.
.B --agent-client-protocol
or a positional subcommand):

.RS
.RS
.PP
.RS
.nf
agent:
  bin: my-agent
  promptMode: acp
  acpFlag: --agent-client-protocol
  args: ["--non-interactive"]
.fi
.RE
.RE

Cancel / SIGTERM behaviour: closing the child's stdin (the
.B "abortSignal"
the runner wires up) sends
.B "session/cancel"
before SIGTERM, so the agent can flush a clean stop notification
instead of being killed mid-sentence. Streamed text chunks up to
the 64 KiB cap are concatenated into the final reply.

.SH "EXIT STATUS"
.TP
.B 0
Success (loop terminated gracefully with no in\-flight task, or
\fB\-\-once\fR completed normally).
.TP
.B 1
Invalid usage (missing / conflicting flags, malformed config,
validation failure).
.TP
.B 2
Not logged in. Triggered when
\fBmode: mine\fR is configured but the active profile has no stored
credentials.
.TP
.B 3
HTTP 404 from a server endpoint.
.TP
.B 4
Server error (HTTP 5xx); the runner logs the failure and either
retries (transient) or exits (after exhausting retries).
.TP
.B 6
Network error (DNS failure, TLS error, server unreachable).

.SH FILES
.TP
.I ./.kanban\-runner.yaml
Project\-shared runner configuration. Checked into the repository.
.TP
.I ./.kanban\-runner.local.yaml
Machine\-local override. Add this filename to
.I .gitignore
when committing the project file.
.TP
.I ~/.config/kanban\-cli/runner.json
Global fallback when no project file is present.

.SH ENVIRONMENT
.TP
.B KANBAN_RUNNER_AGENT_TYPE
Override the
.B agentType
the runner advertises to the server (default \fBopencode\fR). The
server uses this to filter eligible columns.

.SH EXAMPLES
.TP
.B "Watch the sys board's todo column, run forever:"
.PP
.RS
.nf
$ kanban run --board sys --status todo
.fi
.RE

.TP
.B "Process one task from the agent's inbox and exit (cron-friendly):"
.PP
.RS
.nf
$ kanban run --mine --once
.fi
.RE

.TP
.B "Use an explicit config file (CI):"
.PP
.RS
.nf
$ kanban run --config /etc/kanban-runner.yaml \-\-once
.fi
.RE

.SH "kanban run init"
.PP
The
.B init
subcommand scaffolds a
.I .kanban-runner.yaml
(or
.IR .kanban-runner.local.yaml )
interactively. The wizard walks through mode selection (board-bound
vs. identity-bound), the agent block (bin / binPath / prompt delivery
/ args / env / timeout), and the runner cadences. Boards and columns
are fetched live from
.B GET /api/v1/boards
and
.BR GET /api/v1/columns ,
so the user never has to copy/paste an id. The wizard refuses to
overwrite an existing file unless explicitly confirmed, and the
resulting YAML is round-tripped through the same parser the runner
uses, so a freshly-scaffolded config always loads.

.SH "SEE ALSO"
.BR kanban (1),
.BR kanban\-tasks (1),
.IR devDoc/CLI_RUNNER_PLAN_2026-09-12.md ,
.IR devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml .

GitHub: <https://github.com/songkl/open\-kanban>
