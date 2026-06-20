package reviewfixer

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"
)

// exit codes returned by Main.
const (
	exitOK    = 0
	exitError = 1
	exitUsage = 2
)

const usage = `review-fixer — minimize the tokens spent handling PR review threads.

Workflow:  list  ->  (you read each comment, then edit the code yourself)  ->  apply
Each reviewer comment is a HINT to EVALUATE, not to apply verbatim: fix it, explain
why it doesn't apply, or push back — and make the reply body reflect that judgment.

usage: review-fixer [global flags] <subcommand> [flags]
global flags (must precede the subcommand):
  -token string      GitHub token (else $GH_TOKEN, $GITHUB_TOKEN, or ` + "`gh auth token`" + `)
  -api-base string   GitHub API base URL (default https://api.github.com)
  -format text|json  output format (default text)
subcommands:
  list     [-pr N] [-repo o/n] [-author SUBSTR]   print unresolved threads with full comment bodies
  apply    [-pr N] [-repo o/n] [-author SUBSTR]   reads STDIN JSON [{threadId,body}]; replies + resolves each
  verify   [-pr N] [-repo o/n] [-author SUBSTR]   count threads still unresolved
  reply    -thread-id PRRT_… -body STR [-pr N] [-repo o/n]
  resolve  -thread-id PRRT_…
examples:
  review-fixer list -repo o/n -pr 5
  echo '[{"threadId":"PRRT_…","body":"Fixed: added the nil check."}]' | review-fixer apply -repo o/n -pr 5
  review-fixer verify -repo o/n -pr 5
Run "<subcommand> -h" for details (e.g. "list -h" documents the -format=json schema).`

// Main is the CLI entry point. It wires the real exec Runner and HTTP client and
// dispatches to the requested subcommand, returning a process exit code.
func Main(args []string, stdout, stderr io.Writer, stdin io.Reader) int {
	hc := &http.Client{Timeout: 30 * time.Second}

	return run(args, stdout, stderr, stdin, execRunner{}, hc)
}

// globals holds pointers to the global flags shared by every subcommand.
type globals struct {
	token   *string
	apiBase *string
	format  *string
}

// run parses the global flags first (stopping at the first non-flag token, which is the
// subcommand), then dispatches. The TS plugin emits globals before the subcommand, e.g.
// ["-format=text","list","-pr","5"]; this ordering is the authoritative contract.
func run(args []string, stdout, stderr io.Writer, stdin io.Reader, r Runner, hc *http.Client) int {
	fs := flag.NewFlagSet("review-fixer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { _, _ = fmt.Fprintln(fs.Output(), usage) }
	g := globals{
		token:   fs.String("token", "", "GitHub token"),
		apiBase: fs.String("api-base", "https://api.github.com", "GitHub API base URL"),
		format:  fs.String("format", "text", "output format: text or json"),
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}

		return exitUsage
	}

	if *g.format != "text" && *g.format != "json" {
		_, _ = fmt.Fprintf(stderr, "review-fixer: invalid -format %q: want text or json\n", *g.format)

		return exitUsage
	}

	rest := fs.Args()
	if len(rest) == 0 {
		_, _ = fmt.Fprintln(stderr, usage)

		return exitUsage
	}

	return dispatch(rest[0], rest[1:], stdout, stderr, stdin, r, hc, g)
}

// dispatch routes a resolved subcommand to its handler.
func dispatch(sub string, subArgs []string, stdout, stderr io.Writer, stdin io.Reader, r Runner, hc *http.Client, g globals) int {
	ctx := context.Background()

	switch sub {
	case "list":
		return runList(ctx, subArgs, stdout, stderr, r, hc, g)
	case "apply":
		return runApply(ctx, subArgs, stdout, stderr, stdin, r, hc, g)
	case "verify":
		return runVerify(ctx, subArgs, stdout, stderr, r, hc, g)
	case "reply":
		return runReply(ctx, subArgs, stdout, stderr, r, hc, g)
	case "resolve":
		return runResolve(ctx, subArgs, stdout, stderr, r, hc, g)
	default:
		_, _ = fmt.Fprintf(stderr, "review-fixer: unknown subcommand %q\n", sub)

		return exitUsage
	}
}

// parseSub parses a subcommand's flags, mapping -h/-help to a clean exit and any other
// parse error to a usage exit.
func parseSub(fs *flag.FlagSet, args []string) (int, bool) {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK, false
		}

		return exitUsage, false
	}

	return exitOK, true
}

// buildClient resolves the token and returns a configured Client.
func buildClient(ctx context.Context, r Runner, hc *http.Client, g globals) (*Client, error) {
	token, err := resolveToken(ctx, r, *g.token)
	if err != nil {
		return nil, err
	}

	return &Client{httpClient: hc, token: token, apiBase: *g.apiBase}, nil
}

// fail writes a concise error to stderr and returns the error exit code. Raw API
// response bodies are never dumped to stdout.
func fail(stderr io.Writer, err error) int {
	_, _ = fmt.Fprintf(stderr, "review-fixer: %v\n", err)

	return exitError
}

// scope bundles the resolved client and PR/repo coordinates shared by every networked
// subcommand.
type scope struct {
	cl    *Client
	owner string
	repo  string
	pr    int
}

// resolveScope builds the client and resolves repo + PR. The returned int is the exit
// code to use when ok is false.
func resolveScope(ctx context.Context, r Runner, hc *http.Client, g globals, repoFlag string, prFlag int, stderr io.Writer) (scope, int, bool) {
	cl, err := buildClient(ctx, r, hc, g)
	if err != nil {
		return scope{}, fail(stderr, err), false
	}

	owner, name, err := resolveRepo(ctx, r, repoFlag)
	if err != nil {
		return scope{}, fail(stderr, err), false
	}

	prNum, err := resolvePR(ctx, r, prFlag)
	if err != nil {
		return scope{}, fail(stderr, err), false
	}

	return scope{cl: cl, owner: owner, repo: name, pr: prNum}, exitOK, true
}

// listJSONSchema documents the exact shape `-format=json list` emits, so a programmatic
// consumer never has to guess it. It mirrors the listItem struct in report.go.
const listJSONSchema = `
-format=json output: a bare JSON array (no envelope), one object per unresolved thread:
  [{"threadId":"PRRT_…","path":"file.go","line":42,"author":"login","body":"full comment text"}]
fields:
  threadId  string  thread id (pass to apply/reply/resolve)
  path      string  file path ("" when the thread has no file)
  line      int     line number (0 when absent)
  author    string  originator (first comment) login
  body      string  full originator comment body (all lines)
(text output shows the same threads with full, indented comment bodies.)
`

func runList(ctx context.Context, args []string, stdout, stderr io.Writer, r Runner, hc *http.Client, g globals) int {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		out := fs.Output()
		_, _ = fmt.Fprintln(out, "usage: review-fixer [globals] list [-pr N] [-repo o/n] [-author SUBSTR]")
		_, _ = fmt.Fprintln(out, "flags:")
		fs.PrintDefaults()
		_, _ = fmt.Fprint(out, listJSONSchema)
	}
	pr := fs.Int("pr", 0, "pull request number (0 = autodetect from branch)")
	repo := fs.String("repo", "", "owner/name (default: gh repo view)")
	author := fs.String("author", "", "only threads whose originator login contains this")
	if code, ok := parseSub(fs, args); !ok {
		return code
	}

	sc, code, ok := resolveScope(ctx, r, hc, g, *repo, *pr, stderr)
	if !ok {
		return code
	}

	threads, err := sc.cl.listThreads(ctx, sc.owner, sc.repo, sc.pr)
	if err != nil {
		return fail(stderr, err)
	}

	matched := filterThreads(threads, *author)
	_, _ = io.WriteString(stdout, renderList(*g.format, sc.pr, sc.owner, sc.repo, matched))

	return exitOK
}

func runVerify(ctx context.Context, args []string, stdout, stderr io.Writer, r Runner, hc *http.Client, g globals) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	pr := fs.Int("pr", 0, "pull request number (0 = autodetect from branch)")
	repo := fs.String("repo", "", "owner/name (default: gh repo view)")
	author := fs.String("author", "", "only threads whose originator login contains this")
	if code, ok := parseSub(fs, args); !ok {
		return code
	}

	sc, code, ok := resolveScope(ctx, r, hc, g, *repo, *pr, stderr)
	if !ok {
		return code
	}

	threads, err := sc.cl.listThreads(ctx, sc.owner, sc.repo, sc.pr)
	if err != nil {
		return fail(stderr, err)
	}

	remaining := filterThreads(threads, *author)
	_, _ = io.WriteString(stdout, renderVerify(*g.format, sc.pr, sc.owner, sc.repo, remaining))

	if len(remaining) > 0 {
		return exitError
	}

	return exitOK
}

func runReply(ctx context.Context, args []string, stdout, stderr io.Writer, r Runner, hc *http.Client, g globals) int {
	fs := flag.NewFlagSet("reply", flag.ContinueOnError)
	fs.SetOutput(stderr)
	pr := fs.Int("pr", 0, "pull request number (0 = autodetect from branch)")
	repo := fs.String("repo", "", "owner/name (default: gh repo view)")
	threadID := fs.String("thread-id", "", "review thread id (PRRT_…) to reply to")
	body := fs.String("body", "", "reply body")
	if code, ok := parseSub(fs, args); !ok {
		return code
	}

	if *threadID == "" || *body == "" {
		_, _ = fmt.Fprintln(stderr, "review-fixer: -thread-id and -body are required")

		return exitUsage
	}

	sc, code, ok := resolveScope(ctx, r, hc, g, *repo, *pr, stderr)
	if !ok {
		return code
	}

	threads, err := sc.cl.listThreads(ctx, sc.owner, sc.repo, sc.pr)
	if err != nil {
		return fail(stderr, err)
	}

	t, found := findThread(threads, *threadID)
	if !found {
		return fail(stderr, fmt.Errorf("thread %s not found on PR #%d", *threadID, sc.pr))
	}

	if err := sc.cl.replyToComment(ctx, sc.owner, sc.repo, sc.pr, t.RootCommentID, *body); err != nil {
		return fail(stderr, err)
	}

	_, _ = io.WriteString(stdout, renderReply(*g.format, *threadID))

	return exitOK
}

func runResolve(ctx context.Context, args []string, stdout, stderr io.Writer, r Runner, hc *http.Client, g globals) int {
	fs := flag.NewFlagSet("resolve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	threadID := fs.String("thread-id", "", "review thread id (PRRT_…) to resolve")
	if code, ok := parseSub(fs, args); !ok {
		return code
	}

	if *threadID == "" {
		_, _ = fmt.Fprintln(stderr, "review-fixer: -thread-id is required")

		return exitUsage
	}

	cl, err := buildClient(ctx, r, hc, g)
	if err != nil {
		return fail(stderr, err)
	}

	if err := cl.resolveThread(ctx, *threadID); err != nil {
		return fail(stderr, err)
	}

	_, _ = io.WriteString(stdout, renderResolve(*g.format, *threadID))

	return exitOK
}

// findThread returns the thread with the given id.
func findThread(threads []Thread, id string) (Thread, bool) {
	for _, t := range threads {
		if t.ID == id {
			return t, true
		}
	}

	return Thread{}, false
}

// renderReply formats the `reply` confirmation.
func renderReply(format, threadID string) string {
	if format == "json" {
		//nolint:errchkjson // concrete string field cannot error
		b, _ := json.Marshal(struct {
			ThreadID string `json:"threadId"`
		}{threadID})

		return string(b) + "\n"
	}

	return fmt.Sprintf("replied to %s.\n", threadID)
}

// renderResolve formats the `resolve` confirmation.
func renderResolve(format, threadID string) string {
	if format == "json" {
		//nolint:errchkjson // concrete string field cannot error
		b, _ := json.Marshal(struct {
			ThreadID string `json:"threadId"`
		}{threadID})

		return string(b) + "\n"
	}

	return fmt.Sprintf("resolved %s.\n", threadID)
}
