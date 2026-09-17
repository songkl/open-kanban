// `kanban comments add / list` commands.
//
// `comments add <taskId> --body <text> [--author <name>]` POSTs
// { taskId, content, author } to /api/v1/comments and prints the created
// record. The backend's CreateComment handler derives the author from the
// authenticated user (user.Nickname), so the optional --author is sent
// for parity with the MCP `add_comment` tool but the server may override
// it. The endpoint lives behind RequireAuth in backend/cmd/server/main.go
// so the command needs an OAuth session.
//
// `comments list <taskId>` GETs /api/v1/comments?taskId=<id> and renders
// id / author / createdAt / content as a table (or raw JSON). The list is
// always ordered by createdAt ASC by the backend, matching the
// `comments` array embedded in GET /api/v1/tasks/:id?include=comments.
//
// `--body -` reads the body from stdin (full stream, trimmed) so callers
// can pipe multi-line content:
//   echo "LGTM" | kanban comments add s-1061 --body -
//   pbpaste | kanban comments add s-1061 --body -
// The stdin stream is injectable via the `io.stdin` option so tests can
// feed scripted payloads without touching process.stdin.

import chalk from "chalk";
import Table from "cli-table3";
import { Readable } from "node:stream";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";

export type OutputFormat = "table" | "json" | "yaml";

export interface CommentRecord {
  id?: string;
  content?: string;
  author?: string;
  taskId?: string;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommentsReport {
  apiUrl: string;
  taskId: string;
  comments: CommentRecord[];
}

export interface CommentResult {
  apiUrl: string;
  comment: CommentRecord;
}

export interface RunCommentsAddOptions {
  apiUrl: string;
  body: string;
  author?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  };
  http: HttpClient;
}

export interface RunCommentsListOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// STDIN_BODY_SENTINEL is the literal value the CLI accepts in --body to
// request "read the comment body from stdin". Keeping it as a named
// constant makes the matching logic obvious to reviewers and easy to
// reference from tests.
export const STDIN_BODY_SENTINEL = "-";

// runCommentsAdd POSTs { taskId, content, author? } to /api/v1/comments
// and prints the resulting record. When body === STDIN_BODY_SENTINEL the
// function slurps the entire stdin stream (UTF-8 decoded, trimmed) and
// uses that as the content. An empty / whitespace-only body after the
// stdin read is rejected with InvalidUsageError so callers don't silently
// post blank comments.
export async function runCommentsAdd(
  opts: RunCommentsAddOptions,
  taskId: string
): Promise<CommentResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdin = opts.io?.stdin ?? process.stdin;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (taskId ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban comments add requires a task id");
  }

  const content = await resolveBody(opts.body, stdin);
  if (!content || !content.trim()) {
    throw new InvalidUsageError(
      "kanban comments add requires a non-empty --body (or piped stdin)"
    );
  }

  const payload: { taskId: string; content: string; author?: string } = {
    taskId: trimmedId,
    content,
  };
  if (opts.author && opts.author.trim()) {
    payload.author = opts.author.trim();
  }

  let comment: CommentRecord;
  try {
    comment = await opts.http.apiPost<CommentRecord>("/api/v1/comments", payload);
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${trimmedId}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: CommentResult = { apiUrl, comment };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(
      `${chalk.green("Added comment")} ${comment.id ?? ""} to task ${trimmedId}\n`
    );
  }
  return result;
}

// runCommentsList GETs /api/v1/comments?taskId=<id> and renders the
// response as a table (id / author / createdAt / content) or raw JSON.
// An empty list is rendered with the same "(no comments)" hint used by
// the other list commands.
export async function runCommentsList(
  opts: RunCommentsListOptions,
  taskId: string
): Promise<CommentsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (taskId ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban comments list requires a task id");
  }

  let raw: CommentRecord[];
  try {
    raw = await opts.http.apiGet<CommentRecord[]>(
      "/api/v1/comments",
      { query: { taskId: trimmedId } }
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${trimmedId}\n`));
    } else if (err instanceof AuthError) {
      // AuthError is re-mapped by mapAuthError below; the early branch
      // here just keeps the human-readable hint consistent.
      stderr.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
    }
    throw await mapAuthError(err, stderr);
  }
  const comments = Array.isArray(raw) ? raw : [];
  const report: CommentsReport = {
    apiUrl,
    taskId: trimmedId,
    comments,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatCommentsTable(report) + "\n");
  }
  return report;
}

// resolveBody returns the literal body when it isn't the stdin sentinel,
// otherwise it drains the supplied readable stream and returns the
// decoded UTF-8 text (trimmed). The stream is consumed even when the
// value isn't "-" so callers can pass a known-empty Readable in tests
// without leaking file descriptors.
async function resolveBody(
  body: string,
  stdin: NodeJS.ReadableStream
): Promise<string> {
  if (body !== STDIN_BODY_SENTINEL) return body;
  return readAll(stdin);
}

// readAll consumes a Readable stream and returns the concatenated
// UTF-8 text. It tolerates chunks split mid-codepoint because Readable
// chunks are always Buffer instances in Node, and we join them with
// setEncoding("utf8") so multi-byte characters survive the boundary.
// An empty stream resolves to "" so the caller can raise
// InvalidUsageError with the same message it would have for a missing
// --body flag.
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  // Treat a missing / already-destroyed stream as an empty body. This
  // happens in vitest when the test doesn't inject io.stdin and the
  // global process.stdin has no readable source (e.g. when the test
  // runner detaches the TTY).
  if (!stream) return "";
  const readable = stream as Readable;
  if (readable.readableEnded || readable.destroyed) return "";

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const joined = Buffer.concat(chunks).toString("utf8");
      resolve(joined.trim());
    };
    const onData = (chunk: Buffer | string): void => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk, "utf8"));
      } else {
        chunks.push(chunk);
      }
    };
    const cleanup = (): void => {
      readable.off("error", onError);
      readable.off("end", onEnd);
      readable.off("data", onData);
    };

    readable.on("error", onError);
    readable.on("end", onEnd);
    readable.on("data", onData);
    // If the stream is paused (the common case for piped stdin) nudge it
    // back into flowing mode so the data/end events fire.
    if (typeof (readable as Readable & { resume?: () => void }).resume === "function") {
      (readable as Readable & { resume?: () => void }).resume?.();
    }
  });
}

function formatCommentsTable(r: CommentsReport): string {
  const lines: string[] = [];
  lines.push(
    `${chalk.bold("Comments")}  ${chalk.cyan(r.apiUrl)}  ${chalk.gray(
      `task=${r.taskId}`
    )}`
  );
  if (r.comments.length === 0) {
    lines.push(chalk.gray("  (no comments)"));
    return lines.join("\n");
  }
  const headers = ["id", "author", "createdAt", "content"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
    wordWrap: true,
    colWidths: [12, 14, 22, 60],
  });
  for (const c of r.comments) {
    table.push([
      c.id ?? "",
      c.author ?? "",
      c.createdAt ?? "",
      c.content ?? "",
    ]);
  }
  lines.push(table.toString());
  return lines.join("\n");
}

async function mapAuthError(
  err: unknown,
  stderr?: NodeJS.WritableStream
): Promise<never> {
  if (err instanceof AuthError) {
    stderr?.write(
      chalk.red("Not logged in. Run 'kanban auth login' first.\n")
    );
    throw new NotLoggedInError(err.message);
  }
  throw err as Error;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
