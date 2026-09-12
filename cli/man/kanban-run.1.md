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
prompt that includes the board / column / task context.
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
  promptMode: arg          # arg | stdin | file
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
\fBrunner.heartbeatIntervalMs\fR (otherwise an in\-flight task could
be reaped before its next heartbeat).
.IP \(bu 4
\fBmode: mine\fR is selected but the active CLI profile is not logged
in.

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

.SH "SEE ALSO"
.BR kanban (1),
.BR kanban\-tasks (1),
.IR devDoc/CLI_RUNNER_PLAN_2026-09-12.md ,
.IR devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml .

GitHub: <https://github.com/songkl/open\-kanban>
