// `kanban completion <shell>` and the hidden `kanban __complete <line>`
// command.
//
// The completion command prints a self-contained shell snippet to stdout
// that the user can `source` (fish / zsh) or install under
// /etc/bash_completion.d (bash) to wire Commander's tree into the shell's
// own completion machinery. Static suggestions (subcommands, flags) are
// baked into the script so completion is instantaneous even when the API
// is unreachable; dynamic values (boardId / columnId / taskId) are pulled
// lazily through `kanban __complete <line>`, which fetches the latest
// list of ids from the Kanban server.
//
// The dynamic protocol follows the de-facto convention shared by kubectl,
// gh, and similar CLI tools: `__complete <line>` prints one candidate per
// line as `<completion>\t<description>`; the static script consumes that
// stream when the user is completing a position where dynamic ids make
// sense (e.g. `kanban tasks get <TAB>`).
//
// Like the rest of the codebase, the file avoids comments at the
// bottom of functions and keeps exported names narrowly typed so tests
// can plug in a fake `http` to drive every branch without a live server.

import { HttpClient, NetworkError, AuthError, ApiError } from "../http/client.js";

// TOP_LEVEL_COMMANDS mirrors the commands attached to the root program in
// cli/src/program.ts. It is duplicated rather than imported so the
// generated completion script stays self-contained (a fresh user can
// `curl | bash` the snippet without the JS bundle).
export const TOP_LEVEL_COMMANDS = [
  "auth",
  "status",
  "dashboard",
  "boards",
  "columns",
  "tasks",
  "drafts",
  "archived",
  "comments",
  "subtasks",
  "mine",
  "runs",
  "workspace",
  "shell",
  "completion",
  "config",
  "help",
  "version",
] as const;

// SUBCOMMANDS is a static map of `<command>` → its children, with two
// levels of nesting where Commander uses them (`tasks batch …`).
export const SUBCOMMANDS: Record<string, readonly string[]> = {
  auth: ["login", "status", "logout", "whoami"],
  boards: ["list", "get"],
  columns: ["list", "get"],
  tasks: ["list", "get", "create", "update", "delete", "complete", "move", "batch"],
  "tasks batch": ["create", "update", "delete"],
  drafts: ["list", "publish", "unpublish"],
  archived: ["list", "archive", "restore"],
  comments: ["add", "list"],
  subtasks: ["list", "create", "update", "delete"],
  runs: ["list"],
  workspace: ["upload", "batch-upload", "list", "read", "delete", "stats"],
  completion: ["bash", "zsh", "fish"],
};

// GLOBAL_FLAGS are surfaced whenever the user starts typing `--`. Keep
// this list aligned with `program.option(...)` in cli/src/program.ts.
export const GLOBAL_FLAGS = [
  "--api-url",
  "--profile",
  "--output",
  "--color",
  "--no-color",
] as const;

// COMMON_FLAG_VALUES supplies canned flag-value candidates for flags
// whose argument set is closed (`--output`, `--color`, `--priority`,
// `--status`, `--since`, `--fields`). Surfacing them gives the user
// instant feedback even when the API is offline.
export const COMMON_FLAG_VALUES: Record<string, readonly string[]> = {
  "--output": ["table", "json", "yaml"],
  "--color": ["on", "off", "auto"],
  "--priority": ["low", "medium", "high"],
  "--status": ["todo", "in_progress", "review", "done"],
  "--since": ["today", "thisWeek", "thisMonth"],
  "--fields": ["id", "id+updated"],
};

// FLAG_VALUES_PER_COMMAND overrides the default `COMMON_FLAG_VALUES`
// candidates on a per-command-path basis. Some flags (notably
// `--status`) have *different* closed sets depending on the
// command — `runs list --status` accepts terminal run states
// (`completed` / `failed` / `released`), while the task-level
// commands accept column states (`todo` / `in_progress` / `review`
// / `done`). Entries here win over COMMON_FLAG_VALUES when the
// active subcommand path matches.
export const FLAG_VALUES_PER_COMMAND: Record<
  string,
  Record<string, readonly string[]>
> = {
  "runs list": {
    "--status": ["completed", "failed", "released"],
  },
};

// FLAGS_PER_COMMAND records the per-command flag set. Keeping it
// declarative lets the bash / zsh / fish generators stay identical and
// keeps the dynamic `__complete` runner's logic tiny.
export const FLAGS_PER_COMMAND: Record<string, readonly string[]> = {
  "": GLOBAL_FLAGS,
  status: GLOBAL_FLAGS,
  dashboard: GLOBAL_FLAGS,
  boards: GLOBAL_FLAGS,
  "boards list": [
    "--fields",
    ...GLOBAL_FLAGS,
  ],
  "boards get": [
    "--fields",
    ...GLOBAL_FLAGS,
  ],
  columns: GLOBAL_FLAGS,
  "columns list": ["--board", "--positions", "--fields", ...GLOBAL_FLAGS],
  "columns get": ["--fields", ...GLOBAL_FLAGS],
  tasks: GLOBAL_FLAGS,
  "tasks list": [
    "--board",
    "--column",
    "--status",
    "--agent-type",
    "--priority",
    "--assignee",
    "--search",
    "--since",
    "--tag",
    "--lightweight",
    "--fields",
    ...GLOBAL_FLAGS,
  ],
  "tasks get": GLOBAL_FLAGS,
  "tasks create": [
    "--title",
    "--description",
    "--column",
    "--status",
    "--board",
    "--priority",
    "--assignee",
    "--meta",
    "--no-publish",
    ...GLOBAL_FLAGS,
  ],
  "tasks update": [
    "--title",
    "--description",
    "--priority",
    "--assignee",
    "--meta",
    "--column",
    "--status",
    ...GLOBAL_FLAGS,
  ],
  "tasks delete": ["--yes", ...GLOBAL_FLAGS],
  "tasks complete": GLOBAL_FLAGS,
  "tasks move": ["--column", "--status", ...GLOBAL_FLAGS],
  "tasks batch": GLOBAL_FLAGS,
  "tasks batch create": [
    "--file",
    "--title",
    "--description",
    "--column",
    "--status",
    "--priority",
    "--assignee",
    "--published",
    ...GLOBAL_FLAGS,
  ],
  "tasks batch update": [
    "--file",
    "--column",
    "--status",
    "--priority",
    "--assignee",
    ...GLOBAL_FLAGS,
  ],
  "tasks batch delete": ["--file", "--yes", ...GLOBAL_FLAGS],
  drafts: GLOBAL_FLAGS,
  "drafts list": ["--board", ...GLOBAL_FLAGS],
  "drafts publish": GLOBAL_FLAGS,
  "drafts unpublish": GLOBAL_FLAGS,
  archived: GLOBAL_FLAGS,
  "archived list": ["--board", ...GLOBAL_FLAGS],
  "archived archive": ["--yes", ...GLOBAL_FLAGS],
  "archived restore": GLOBAL_FLAGS,
  "comments add": ["--body", "--author", ...GLOBAL_FLAGS],
  "comments list": GLOBAL_FLAGS,
  subtasks: GLOBAL_FLAGS,
  "subtasks list": GLOBAL_FLAGS,
  "subtasks create": ["--title", ...GLOBAL_FLAGS],
  "subtasks update": ["--title", "--completed", "--no-completed", ...GLOBAL_FLAGS],
  "subtasks delete": ["--yes", ...GLOBAL_FLAGS],
  runs: GLOBAL_FLAGS,
  "runs list": [
    "--runner-id",
    "--since",
    "--status",
    "--task",
    "--board",
    "--limit",
    "--offset",
    ...GLOBAL_FLAGS,
  ],
  mine: ["--board", "--lightweight", ...GLOBAL_FLAGS],
  workspace: GLOBAL_FLAGS,
  "workspace upload": ["--path", ...GLOBAL_FLAGS],
  "workspace batch-upload": GLOBAL_FLAGS,
  "workspace list": ["--path", ...GLOBAL_FLAGS],
  "workspace read": GLOBAL_FLAGS,
  "workspace delete": ["--yes", ...GLOBAL_FLAGS],
  "workspace stats": GLOBAL_FLAGS,
  auth: GLOBAL_FLAGS,
  "auth login": GLOBAL_FLAGS,
  "auth status": GLOBAL_FLAGS,
  "auth logout": GLOBAL_FLAGS,
  "auth whoami": ["--path", ...GLOBAL_FLAGS],
  completion: GLOBAL_FLAGS,
  "completion bash": GLOBAL_FLAGS,
  "completion zsh": GLOBAL_FLAGS,
  "completion fish": GLOBAL_FLAGS,
  config: GLOBAL_FLAGS,
};

// FetcherId names the dynamic-id resolution strategy. The runner maps
// each command path to one of these; the implementation pulls the
// candidate rows from the matching Kanban endpoint.
export type FetcherId = "boards" | "columns" | "tasks" | "subtasks" | "workspace";

export interface DynamicIdTask {
  command: string;
  argIndex: number;
  fetcher: FetcherId;
  // extraTokens lists flag names whose values should be used as query
  // parameters for the corresponding endpoint. The runner scans the
  // token list for these so `tasks create --board <id>` constrains the
  // dynamic candidates to that board's columns.
  extraTokens?: readonly string[];
}

// DYNAMIC_ID_TASKS describes where a dynamic id candidate list makes
// sense. Each entry maps "<command path>" → a fetcher plus optional
// flags. The `__complete` runner only fires the API request when the
// cursor sits in one of these positions so a tab-completion never costs
// the user more than one round-trip per completion.
export const DYNAMIC_ID_TASKS: readonly DynamicIdTask[] = [
  { command: "boards get", argIndex: 0, fetcher: "boards" },
  { command: "columns get", argIndex: 0, fetcher: "columns" },
  {
    command: "columns list",
    argIndex: 0,
    fetcher: "columns",
    extraTokens: ["--board"],
  },
  { command: "tasks get", argIndex: 0, fetcher: "tasks" },
  { command: "tasks update", argIndex: 0, fetcher: "tasks" },
  { command: "tasks delete", argIndex: 0, fetcher: "tasks" },
  { command: "tasks complete", argIndex: 0, fetcher: "tasks" },
  { command: "tasks move", argIndex: 0, fetcher: "tasks" },
  {
    command: "tasks create",
    argIndex: 0,
    fetcher: "columns",
    extraTokens: ["--board", "--status"],
  },
  {
    command: "tasks update",
    argIndex: 0,
    fetcher: "columns",
    extraTokens: ["--board", "--status"],
  },
  { command: "drafts publish", argIndex: 0, fetcher: "tasks" },
  { command: "drafts unpublish", argIndex: 0, fetcher: "tasks" },
  { command: "archived archive", argIndex: 0, fetcher: "tasks" },
  { command: "archived restore", argIndex: 0, fetcher: "tasks" },
  { command: "comments add", argIndex: 0, fetcher: "tasks" },
  { command: "comments list", argIndex: 0, fetcher: "tasks" },
  { command: "subtasks list", argIndex: 0, fetcher: "tasks" },
  { command: "subtasks create", argIndex: 0, fetcher: "tasks" },
  { command: "subtasks update", argIndex: 0, fetcher: "subtasks" },
  { command: "subtasks delete", argIndex: 0, fetcher: "subtasks" },
  { command: "workspace read", argIndex: 0, fetcher: "workspace" },
  { command: "workspace delete", argIndex: 0, fetcher: "workspace" },
];

export type SupportedShell = "bash" | "zsh" | "fish";

export class UnsupportedShellError extends Error {
  constructor(shell: string) {
    super(
      `unsupported shell: '${shell}' (expected one of: bash, zsh, fish)`
    );
    this.name = "UnsupportedShellError";
  }
}

export interface RunCompletionOptions {
  shell: string;
  // binName overrides the installed binary name embedded in the script.
  // Tests default it to `kanban` so the generator's output matches what
  // users see on disk.
  binName?: string;
  // io lets the bootstrap layer and the tests redirect stdout/stderr.
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
}

// runCompletion writes the requested completion script to stdout. The
// returned string is the same bytes that hit the stream so tests can
// assert on it without redirecting output.
export function runCompletion(opts: RunCompletionOptions): string {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const shell = normaliseShell(opts.shell);
  if (!shell) {
    throw new UnsupportedShellError(opts.shell);
  }
  const bin = opts.binName ?? "kanban";
  const script = renderShell(shell, bin);
  stdout.write(script);
  // Tell the user how to install — printed to stderr so `eval "$(...)"`
  // in shell snippets stays clean.
  stderr.write(
    `# kanban completion ${shell} script generated. Install per the README.\n`
  );
  return script;
}

// renderShell is the pure generator the tests exercise directly. It
// doesn't touch any streams, so unit tests can call it without standing
// up fakes.
export function renderShell(shell: SupportedShell, bin: string = "kanban"): string {
  if (shell === "bash") return bashScript(bin);
  if (shell === "zsh") return zshScript(bin);
  return fishScript(bin);
}

// normaliseShell returns the canonical shell name or empty string for
// unknown inputs. Comparison is case-insensitive so `BASH` and `Fish`
// resolve to the same generator.
export function normaliseShell(input: string): SupportedShell | "" {
  const t = input.trim().toLowerCase();
  if (t === "bash" || t === "zsh" || t === "fish") return t;
  return "";
}

// listShells returns the supported shell names so the help / error
// paths can show a single source of truth.
export function listShells(): readonly SupportedShell[] {
  return ["bash", "zsh", "fish"];
}

// shellQuote wraps a string in single quotes with the embedded `'
// escaped per the POSIX rules. It is intentionally a helper rather than
// inline so test code can call it directly to assert quoting behaviour.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// serialiseSubcommandsMap / serialiseFlagMap turn the in-memory tables
// into bash-compatible shell variables. Each entry becomes a single
// `__<bin>__SUBCM_<encoded>=...` (or `__<bin>__FLAGS_<encoded>=...`)
// assignment; spaces in keys are replaced with `__` so bash 3.2 —
// which has no associative arrays — can still index them. The
// generated `_${bin}_lookup` helper rebuilds the encoded name at
// runtime and reads the variable back via `${!v}`.
//
// The "" key always carries the top-level command list, so a lookup
// with `path=""` (the initial cursor position) returns the right
// suggestions without the completer having to special-case the root.
function serialiseSubcommandsMap(bin: string): string {
  const topLevel = TOP_LEVEL_COMMANDS.filter((c) => !c.includes(" "));
  const entries: Array<[string, readonly string[]]> = [
    ["", topLevel],
    ...Object.entries(SUBCOMMANDS),
  ];
  const lines = entries.map(
    ([k, v]) =>
      `__${bin}__SUBCM_${encodeKey(k)}=${shellQuote(v.join(" "))}`
  );
  return lines.join("\n");
}

function serialiseFlagMap(bin: string): string {
  const lines = Object.entries(FLAGS_PER_COMMAND).map(
    ([k, v]) => `__${bin}__FLAGS_${encodeKey(k)}=${shellQuote(v.join(" "))}`
  );
  return lines.join("\n");
}

// serialiseFlagValueMap turns FLAG_VALUES_PER_COMMAND into a flat
// sequence of `__<bin>__FLAGVALS_<encoded_key>=<entries>` lines.
// Each entry is the literal flag name (with the leading `--`),
// followed by an `=` and the space-separated candidate values, all
// joined with `;` so a single map can hold overrides for every
// flag of the command. Example:
//
//   __kanban__FLAGVALS_runs_list=--status=completed failed released
//
// The bash / zsh scripts consult this map *before* the static
// `COMMON_FLAG_VALUES` so a per-command override always wins when
// the active path matches.
function serialiseFlagValueMap(bin: string): string {
  const lines = Object.entries(FLAG_VALUES_PER_COMMAND).map(([k, perFlag]) => {
    const entries = Object.entries(perFlag)
      .map(([flag, vals]) => `${flag}=${vals.join(" ")}`)
      .join(";");
    return `__${bin}__FLAGVALS_${encodeKey(k)}=${shellQuote(entries)}`;
  });
  return lines.join("\n");
}

// FLAGVALS_PER_FLAG is the inverse of FLAG_VALUES_PER_COMMAND,
// indexed by flag name. The dynamic `__complete` runner consults
// this map to discover which command paths have an override for
// the flag the user is currently completing. Built once at module
// load.
const FLAGVALS_PER_FLAG: Record<string, Record<string, readonly string[]>> =
  (() => {
    const out: Record<string, Record<string, readonly string[]>> = {};
    for (const [path, perFlag] of Object.entries(FLAG_VALUES_PER_COMMAND)) {
      for (const [flag, vals] of Object.entries(perFlag)) {
        const bucket = (out[flag] ??= {});
        bucket[path] = vals;
      }
    }
    return out;
  })();

// encodeKey turns a path like `tasks batch` into a bash-identifier-safe
// suffix. Any character that's not a letter / digit / underscore is
// collapsed to `_`; consecutive non-id runs collapse to a single `_`.
// Bash 3.2 forbids `-` in identifier names so the encoding has to be
// strict.
function encodeKey(k: string): string {
  return k
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// bashScript returns a bash-completion snippet for the supplied binary
// name. The implementation follows the standard `complete -F` pattern:
// a single function registered against the binary that walks the parsed
// tokens, computes the active subcommand path, and emits the right
// candidate list. Dynamic ids come from `__complete` which the script
// spawns via `eval`.
//
// Maps are stored as plain shell variables (one per subcommand / flag
// path) so the script works on bash 3.2 (the version Apple still ships
// in /bin/bash) as well as bash 4+. Lookups go through `eval` + an
// indirect reference — cheap, and avoids the `declare -gA` syntax
// bash 3.2 rejects.
function bashScript(bin: string): string {
  const subcommandMap = serialiseSubcommandsMap(bin);
  const flagMap = serialiseFlagMap(bin);
  const flagValueMap = serialiseFlagValueMap(bin);
  const globalWords = GLOBAL_FLAGS.slice().sort().join(" ");
  return `# bash completion for ${bin}
# Generated by: ${bin} completion bash
# Do not edit by hand; re-run the generator when the command tree changes.

_${bin}_lookup() {
  # _${bin}_lookup <var_prefix> <key>
  # Sets the global variable REPLY to the value mapped under
  # "<var_prefix><encoded_key>". Encoding collapses every non-id char
  # to "_" and trims leading/trailing underscores — bash 3.2 rejects
  # "-" in variable names, so this stays identifier-safe across the
  # whole command tree.
  local prefix="$1" key="$2" enc
  enc="\${key//[^A-Za-z0-9_]/_}"
  enc="\${enc//__/_}"
  local v="\${prefix}\${enc}"
  if [[ -n "\${!v+x}" ]]; then
    REPLY="\${!v}"
  else
    REPLY=""
  fi
}

_${bin}_completion() {
  local cur prev cword path
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=$(( COMP_CWORD - 1 ))

  # Compute the subcommand path before the cursor.
  local path=""
  local i=1
  while (( i < COMP_CWORD )); do
    local t="\${COMP_WORDS[i]}"
    if [[ "\${t}" == --* ]]; then
      case "\${t}" in
        --api-url|--profile|--output|--color) i=$(( i + 2 )); continue ;;
      esac
    fi
    _${bin}_lookup "__${bin}__SUBCM_" "\${path}"
    local subs="\${REPLY}"
    if [[ " \${subs} " == *" \${t} "* ]]; then
      if [[ -z "\${path}" ]]; then
        path="\${t}"
      else
        path="\${path} \${t}"
      fi
      i=$(( i + 1 ))
    else
      break
    fi
  done

  # Flag completion: any partial starting with --.
  if [[ "\${cur}" == --* ]]; then
    _${bin}_lookup "__${bin}__FLAGS_" "\${path}"
    local flags="\${REPLY:-${globalWords}}"
    COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
    return 0
  fi

  # Flag-value completion for the previous flag. Per-command overrides
  # take precedence over the COMMON_FLAG_VALUES fall-back so commands
  # with command-specific closed sets (e.g. \`runs list --status\`
  # accepting terminal run states instead of task column states) win.
  local prev_vals=""
  case "\${prev}" in
    --output) prev_vals="table json yaml" ;;
    --color) prev_vals="on off auto" ;;
    --priority) prev_vals="low medium high" ;;
    --status) prev_vals="todo in_progress review done" ;;
    --since) prev_vals="today thisWeek thisMonth" ;;
    --fields) prev_vals="id id+updated" ;;
  esac
  if [[ -n "\${path}" ]]; then
    _${bin}_lookup "__${bin}__FLAGVALS_" "\${path}"
    local override="\${REPLY}"
    if [[ -n "\${override}" ]]; then
      # Entries are "flag=value1 value2 ..." joined by ";". Extract
      # the entry whose prefix matches \${prev} (literal, so the
      # trailing "=" matters).
      local entry=""
      local IFS=';'
      for entry in \${override}; do
        case "\${entry}" in
          "\${prev}="*) prev_vals="\${entry#\${prev}=}" ; break ;;
        esac
      done
    fi
  fi
  if [[ -n "\${prev_vals}" ]]; then
    COMPREPLY=( $(compgen -W "\${prev_vals}" -- "\${cur}") )
    return 0
  fi

  # Subcommand completion: only while still on a subcommand token.
  _${bin}_lookup "__${bin}__SUBCM_" "\${path}"
  local subs="\${REPLY}"
  if [[ -n "\${subs}" ]]; then
    COMPREPLY=( $(compgen -W "\${subs}" -- "\${cur}") )
    return 0
  fi

  # Dynamic id completion via __complete.
  if type "${bin}" >/dev/null 2>&1; then
    local line=""
    for ((i = 1; i < COMP_CWORD; i++)); do
      line+="\${COMP_WORDS[i]} "
    done
    local out
    out=$("${bin}" __complete "\${line}\${cur}" 2>/dev/null)
    COMPREPLY=( \${out} )
  fi
}

${subcommandMap}

${flagMap}

${flagValueMap}

complete -F _${bin}_completion ${bin}
`;
}

// zshScript returns a `#compdef kanban` snippet for zsh. The script
// registers a `_kanban` completion function that mirrors the bash
// implementation; dynamic values still come from `__complete`. Like
// the bash script, maps are stored as plain variables (`__<bin>__SUBCM_<enc>`)
// so the lookup works in any zsh version without `typeset -A` quirks.
function zshScript(bin: string): string {
  const subcommandMap = serialiseSubcommandsMap(bin);
  const flagMap = serialiseFlagMap(bin);
  const flagValueMap = serialiseFlagValueMap(bin);
  return `#compdef ${bin}
# zsh completion for ${bin}
# Generated by: ${bin} completion zsh
# Save as "${bin}" somewhere on \$fpath (e.g. "\${fpath[1]}/_${bin}").

_${bin}() {
  local -a words
  words=(\${words[2,-1]})
  local cur="\${words[CURRENT-1]}"
  local path=""
  local i=1
  while (( i < CURRENT )); do
    local t="\${words[i]}"
    if [[ "\${t}" == --* ]]; then
      case "\${t}" in
        --api-url|--profile|--output|--color) i=$(( i + 2 )); continue ;;
      esac
    fi
    if [[ -z "\${path}" ]]; then
      path="\${t}"
    else
      path="\${path} \${t}"
    fi
    i=$(( i + 1 ))
  done

  if (( CURRENT == 1 )); then
    local -a top
    top=( ${TOP_LEVEL_COMMANDS.slice().sort().join(" ")} )
    _describe -t commands "${bin} commands" top
    return
  fi

  if [[ "\${cur}" == --* ]]; then
    local enc="\${path//[^A-Za-z0-9_]/_}"
    enc="\${enc//__/_}"
    local v="__${bin}__FLAGS_\${enc}"
    local -a flags
    flags=( \${(z)\${(P)v}} )
    _describe -t flags "flags" flags
    return
  fi

  local -a vals
  case "\${words[CURRENT-1]}" in
    --output) vals=( table json yaml ) ;;
    --color) vals=( on off auto ) ;;
    --priority) vals=( low medium high ) ;;
    --status) vals=( todo in_progress review done ) ;;
    --since) vals=( today thisWeek thisMonth ) ;;
    --fields) vals=( id id+updated ) ;;
  esac
  # Per-command override: consult __<bin>__FLAGVALS_<enc> for the
  # active path; if a matching entry for the current prev token
  # exists, it wins over the COMMON fallback above.
  if [[ -n "\${path}" ]]; then
    local enc="\${path//[^A-Za-z0-9_]/_}"
    enc="\${enc//__/_}"
    local vv="__${bin}__FLAGVALS_\${enc}"
    if (( \${+parameters[\${vv}]} )); then
      local override="\${(P)vv}"
      local entry
      for entry in \${(s:;:)override}; do
        case "\${entry}" in
          "\${words[CURRENT-1]}="*) vals=( \${(z)\${entry#\${words[CURRENT-1]}=}} ) ; break ;;
        esac
      done
    fi
  fi
  if (( \${#vals} )); then
    _describe -t values "values" vals
    return
  fi

  local enc="\${path//[^A-Za-z0-9_]/_}"
  enc="\${enc//__/_}"
  local v="__${bin}__SUBCM_\${enc}"
  local -a subs
  subs=( \${(z)\${(P)v}} )
  if (( \${#subs} )); then
    _describe -t subcommands "subcommands" subs
    return
  fi

  # Dynamic ids.
  if (( \${+commands[${bin}]} )); then
    local line=""
    for ((i = 1; i < CURRENT; i++)); do line+="\${words[i]} "; done
    local -a out
    out=( \${(f)"\$(${bin} __complete "\${line}\${cur}" 2>/dev/null)"} )
    _describe -t ids "ids" out
  fi
}

${subcommandMap}

${flagMap}

${flagValueMap}

_${bin} "\$@"
`;
}

// fishScript returns a fish completion snippet that pipes `__complete`
// output through. Fish has the simplest completion API, so the script
// stays short.
function fishScript(bin: string): string {
  const flagLines = Object.values(FLAGS_PER_COMMAND)
    .flat()
    .filter((f, idx, arr) => arr.indexOf(f) === idx)
    .map((f) => `complete -c ${bin} -l "${f.replace(/^--/, "")}"`)
    .join("\n");
  const flagValueLines = Object.entries(COMMON_FLAG_VALUES)
    .flatMap(([flag, vals]) =>
      vals.map(
        (v) =>
          `complete -c ${bin} -n "__fish_contains_opt ${flag}" -fa "${v}"`
      )
    )
    .join("\n");
  // Per-command flag-value overrides. Each entry registers the
  // candidate values for a single flag on a single command path;
  // the more-specific rule wins because fish evaluates `complete`
  // directives in source order and the per-command lines come
  // after the COMMON ones.
  const flagOverrideLines = Object.entries(FLAG_VALUES_PER_COMMAND)
    .flatMap(([path, perFlag]) =>
      Object.entries(perFlag).flatMap(([flag, vals]) => {
        const re = path
          .split(/\s+/)
          .map((t) => t.replace(/[^A-Za-z0-9_-]/g, ""))
          .join(" ");
        return vals.map(
          (v) =>
            `complete -c ${bin} -n "__${bin}_resolve_path | string match -rq '^${re}\$'; and __fish_contains_opt ${flag}" -fa "${v}"`
        );
      })
    )
    .join("\n");
  const subLines = Object.entries(SUBCOMMANDS)
    .map(([path, subs]) => {
      const re = path
        .split(/\s+/)
        .map((t) => t.replace(/[^A-Za-z0-9_-]/g, ""))
        .join(" ");
      return `complete -c ${bin} -n "__${bin}_resolve_path | string match -rq '^${re}\$'" -fa "(${subs.join(" ")})"`;
    })
    .join("\n");
  const topLines = TOP_LEVEL_COMMANDS.map(
    (c) => `complete -c ${bin} -n "__${bin}_resolve_path | string match -rq '^$'" -fa "${c}"`
  ).join("\n");
  return `# fish completion for ${bin}
# Generated by: ${bin} completion fish
# Usage: ${bin} completion fish | source

function __${bin}_resolve_path
  set -l tokens (commandline -opc)
  set -l path ""
  set -l skip_next 0
  set -l i 1
  while test \$i -le (count \$tokens)
    set -l t \$tokens[\$i]
    if test \$skip_next -gt 0
      set skip_next (math \$skip_next - 1)
      set i (math \$i + 1)
      continue
    end
    switch "\$t"
      case '--api-url' '--profile' '--output' '--color'
        set skip_next 1
        set i (math \$i + 1)
        continue
      case '--*'
        set i (math \$i + 1)
        continue
    end
    if test -z "\$path"
      set path "\$t"
    else
      set path "\$path \$t"
    end
    set i (math \$i + 1)
  end
  echo "\$path"
end

function __${bin}_dynamic
  set -l line (commandline -cp)
  set -l cur (commandline -ct)
  ${bin} __complete "\$line\$cur" 2>/dev/null
end

# Top-level commands.
${topLines}

# Per-subcommand completion: suggest children.
${subLines}

# Flags for every command.
${flagLines}

# Flag values for the common closed-set flags.
${flagValueLines}

# Per-command flag-value overrides. Listed after the COMMON block so
# the more-specific path constraint wins in fish's source-order rule
# resolution.
${flagOverrideLines}

# Dynamic ids.
complete -c ${bin} -f -a "(__${bin}_dynamic)"
`;
}

export interface CompleteOptions {
  // line is the full command line (including the leading `kanban`
  // token). The runner uses words[1..] to locate the active subcommand
  // path.
  line: string;
  // point is the cursor offset within `line`. Defaults to `line.length`
  // so the legacy CLI usage (no `--point`) keeps working.
  point?: number;
  // apiUrl / profile override the defaults so the bootstrap layer can
  // honour the same priority chain used everywhere else in the CLI.
  apiUrl?: string;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// CompleteResult is the structured view the `__complete` runner
// returns. The runner also prints the candidates (joined by `\n`, with
// `<word>\t<description>` per line) to stdout so a shell can `eval`
// or pipe the stream directly.
export interface CompleteResult {
  path: string;
  candidates: CompleteCandidate[];
}

export interface CompleteCandidate {
  value: string;
  description?: string;
}

// runComplete is the hidden `__complete <line>` entry point. It returns
// the structured result *and* writes the bash/zsh/fish consumable
// stream to stdout.
export async function runComplete(opts: CompleteOptions): Promise<CompleteResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const point = opts.point ?? opts.line.length;
  const safeLine = clampLine(opts.line, point);
  const tokens = tokenise(safeLine);
  // Drop the leading `kanban` token if present. The runner is invoked
  // from inside the completion script with the full line, so this is
  // the common case.
  if (tokens.length > 0 && tokens[0] === "kanban") {
    tokens.shift();
  }
  const path = pathForTokens(tokens);
  const last = tokens[tokens.length - 1] ?? "";
  const candidates = await computeCandidates({
    tokens,
    path,
    last,
    http: opts.http,
    stderr,
  });
  stdout.write(formatCandidates(candidates));
  return { path, candidates };
}

// computeCandidates is the core dispatcher: it inspects the token list
// to decide whether the cursor sits on a flag, a flag-value, a
// subcommand, or a dynamic id. Network failures degrade gracefully —
// the runner still returns the static candidates so a flaky API never
// disables completion entirely.
async function computeCandidates(input: {
  tokens: string[];
  path: string;
  last: string;
  http: HttpClient;
  stderr: NodeJS.WritableStream;
}): Promise<CompleteCandidate[]> {
  const { tokens, path, last, http, stderr } = input;
  // Flag completion.
  if (last.startsWith("--")) {
    const flags = FLAGS_PER_COMMAND[path] ?? GLOBAL_FLAGS;
    return flags.map((f) => ({ value: f }));
  }
  // Flag-value completion for a closed-set flag. Per-command overrides
  // win over the COMMON fallback so commands with command-specific
  // closed sets (e.g. `runs list --status` accepting terminal run
  // states) override the default column-state list.
  if (tokens.length >= 2) {
    const prev = tokens[tokens.length - 2];
    const perCommand = FLAGVALS_PER_FLAG[prev]?.[path];
    const vals = perCommand ?? COMMON_FLAG_VALUES[prev];
    if (vals) {
      return vals.map((v) => ({ value: v }));
    }
  }
  // Subcommand completion. At the top level (path="") fall back to
  // TOP_LEVEL_COMMANDS; otherwise consult SUBCOMMANDS[path]. Skip the
  // check when the cursor is sitting on a partial token (e.g. "ta")
  // that doesn't match a known subcommand — those tokens should flow
  // through to the dynamic fetcher below.
  if (!last.startsWith("-")) {
    const candidates =
      path === ""
        ? (TOP_LEVEL_COMMANDS as readonly string[]).filter((c) => !c.includes(" "))
        : SUBCOMMANDS[path] ?? [];
    if (candidates.length > 0) {
      // If the cursor already holds a finished child of `path` (e.g.
      // `tasks get`), don't suggest the same child back — let the
      // dynamic fetcher below take over instead.
      const lastIsChild =
        path !== "" &&
        tokens.length > 0 &&
        (SUBCOMMANDS[path] ?? []).includes(tokens[tokens.length - 1]);
      if (!lastIsChild) {
        return candidates.map((c) => ({ value: c }));
      }
    }
  }
  // Dynamic id completion.
  const task = DYNAMIC_ID_TASKS.find((t) => t.command === path);
  if (task) {
    try {
      const ids = await fetchIds(task, tokens, http);
      return ids.map((id) => ({ value: id.id, description: id.description }));
    } catch (err) {
      // Surface the error on stderr (so the user's terminal isn't
      // flooded with tracebacks) but return an empty list so the
      // completion itself stays silent.
      stderr.write(`kanban __complete: ${describeError(err)}\n`);
      return [];
    }
  }
  return [];
}

// fetchIds resolves the dynamic candidate list for one DYNAMIC_ID_TASKS
// entry. It honours the `extraTokens` (e.g. `--board <id>`) so the
// runner can scope the request when the user already typed a parent
// selector.
async function fetchIds(
  task: DynamicIdTask,
  tokens: string[],
  http: HttpClient
): Promise<Array<{ id: string; description?: string }>> {
  const extra = extractFlagValues(tokens, task.extraTokens ?? []);
  if (task.fetcher === "boards") {
    const rows = await http.apiGet<Array<{ id?: string; name?: string }>>(
      "/api/v1/boards"
    );
    return rows
      .filter((r): r is { id?: string; name?: string } => Boolean(r?.id))
      .map((r) => ({ id: r.id as string, description: r.name }));
  }
  if (task.fetcher === "columns") {
    const query: Record<string, string> = {};
    if (extra["--board"]) query.boardId = extra["--board"];
    const rows = await http.apiGet<Array<{ id?: string; name?: string }>>(
      "/api/v1/columns",
      { query }
    );
    return rows
      .filter((r): r is { id?: string; name?: string } => Boolean(r?.id))
      .map((r) => ({ id: r.id as string, description: r.name }));
  }
  if (task.fetcher === "tasks") {
    const query: Record<string, string> = {};
    if (extra["--column"]) query.columnId = extra["--column"];
    if (extra["--board"]) query.boardId = extra["--board"];
    const rows = await http.apiGet<Array<{ id?: string; title?: string }>>(
      "/api/v1/tasks",
      { query }
    );
    return rows
      .filter((r): r is { id?: string; title?: string } => Boolean(r?.id))
      .map((r) => ({ id: r.id as string, description: r.title }));
  }
  if (task.fetcher === "subtasks") {
    // Subtasks need a parent task id. Without one, fall back to the
    // first non-flag positional argument as a best-effort default.
    const taskId =
      extra["--task"] ?? extra["--taskId"] ?? firstPositional(tokens) ?? "";
    if (!taskId) return [];
    const rows = await http.apiGet<Array<{ id?: string; title?: string }>>(
      "/api/v1/subtasks",
      { query: { taskId } }
    );
    return rows
      .filter((r): r is { id?: string; title?: string } => Boolean(r?.id))
      .map((r) => ({ id: r.id as string, description: r.title }));
  }
  // workspace file ids.
  const rows = await http.apiGet<Array<{ id?: string; name?: string }>>(
    "/api/v1/workspace/files"
  );
  return rows
    .filter((r): r is { id?: string; name?: string } => Boolean(r?.id))
    .map((r) => ({ id: r.id as string, description: r.name }));
}

// extractFlagValues walks the token list looking for `--flag value`
// pairs and returns the most recent value for each requested flag. The
// caller scopes the search by passing the flag names it cares about.
function extractFlagValues(
  tokens: readonly string[],
  flags: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const f of flags) {
      if (t === f && i + 1 < tokens.length) {
        out[f] = tokens[i + 1];
      } else if (t.startsWith(`${f}=`)) {
        out[f] = t.slice(f.length + 1);
      }
    }
  }
  return out;
}

// firstPositional returns the first token that doesn't start with `-`,
// skipping the leading `kanban` and any subcommand tokens.
function firstPositional(tokens: readonly string[]): string | undefined {
  let skippedFirst = false;
  for (const t of tokens) {
    if (!skippedFirst && t === "kanban") {
      skippedFirst = true;
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return undefined;
}

// pathForTokens walks the token list, skipping global flags + their
// values, and returns the dotted subcommand path (e.g. `tasks batch`).
export function pathForTokens(tokens: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      // Skip the value of any global that takes one so the path walker
      // doesn't mistake it for a subcommand.
      switch (t) {
        case "--api-url":
        case "--profile":
        case "--output":
        case "--color":
          i += 1;
          continue;
        default:
          continue;
      }
    }
    if (t.startsWith("-")) continue;
    const parent = out.join(" ");
    // Top-level command tokens are matched against TOP_LEVEL_COMMANDS;
    // nested ones are matched against SUBCOMMANDS[parent].
    const allowed =
      parent === ""
        ? (TOP_LEVEL_COMMANDS as readonly string[])
        : (SUBCOMMANDS[parent] ?? []);
    if (allowed.includes(t)) {
      out.push(t);
    } else {
      break;
    }
  }
  return out.join(" ");
}

// tokenise is a tiny whitespace splitter. Quoting is intentionally
// simple — completion only needs to recognise word boundaries; values
// with spaces are extremely rare in this CLI. A trailing space
// produces an empty final token so the caller can tell the user is
// about to type the next argument (and supply flag-value candidates
// for the previous flag).
function tokenise(line: string): string[] {
  const trimmed = line.replace(/^\s+/, "").replace(/\s+$/, "");
  if (trimmed === "") return [];
  const parts = trimmed.split(/\s+/);
  if (/\s$/.test(line)) parts.push("");
  return parts;
}

// clampLine honours the cursor offset so a partial token isn't
// accidentally consumed. Without it, `kanban tasks get t` with
// point=10 would treat `t` as a finished id and skip the dynamic
// completion path.
function clampLine(line: string, point: number): string {
  if (point >= line.length) return line;
  if (point <= 0) return "";
  // Drop the partial token at the cursor so tokenise() doesn't surface
  // it as a "completed" word.
  const head = line.slice(0, point);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace === -1) return "";
  return line.slice(0, lastSpace + 1);
}

// formatCandidates renders candidates as `<value>\t<description>` lines
// with `:` appended so bash / zsh show the description. Empty
// descriptions drop the tab so the output stays compact.
function formatCandidates(candidates: CompleteCandidate[]): string {
  if (candidates.length === 0) return "";
  return candidates.map(formatCandidate).join("\n") + "\n";
}

function formatCandidate(c: CompleteCandidate): string {
  if (c.description && c.description.length > 0) {
    // Escape tabs / newlines in the description so the downstream shell
    // parser doesn't choke on them.
    const desc = c.description.replace(/[\t\n]/g, " ");
    return `${c.value}\t${desc}`;
  }
  return c.value;
}

function describeError(err: unknown): string {
  if (err instanceof NetworkError) return `network unreachable: ${err.message}`;
  if (err instanceof AuthError) return `auth required: ${err.message}`;
  if (err instanceof ApiError) return err.message;
  return (err as Error)?.message ?? String(err);
}