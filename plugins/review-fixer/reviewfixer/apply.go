package reviewfixer

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// applyInput is one token-minimal write request read from stdin: just the thread to
// resolve and the reply body. No comment id — the root comment is derived server-side
// from the thread list.
type applyInput struct {
	ThreadID string `json:"threadId"`
	Body     string `json:"body"`
}

// applyItemResult records what happened to one requested thread.
type applyItemResult struct {
	ThreadID string `json:"threadId"`
	Reply    string `json:"reply"`   // ok|fail|skip
	Resolve  string `json:"resolve"` // ok|skip|fail
	Error    string `json:"error,omitempty"`
}

// applyReport is the full outcome of an apply run.
type applyReport struct {
	Results   []applyItemResult `json:"results"`
	Applied   int               `json:"applied"`
	Requested int               `json:"requested"`
	Remaining int               `json:"remaining"`
}

func runApply(ctx context.Context, args []string, stdout, stderr io.Writer, stdin io.Reader, r Runner, hc *http.Client, g globals) int {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	fs.SetOutput(stderr)
	pr := fs.Int("pr", 0, "pull request number (0 = autodetect from branch)")
	repo := fs.String("repo", "", "owner/name (default: gh repo view)")
	author := fs.String("author", "", "only threads whose originator login contains this")
	if code, ok := parseSub(fs, args); !ok {
		return code
	}

	items, code, ok := readApplyInput(stdin, stderr)
	if !ok {
		return code
	}

	// Empty input is a no-op: emit a zero report without touching the network.
	if len(items) == 0 {
		_, _ = io.WriteString(stdout, renderApply(*g.format, applyReport{Results: []applyItemResult{}}))

		return exitOK
	}

	sc, code, ok := resolveScope(ctx, r, hc, g, *repo, *pr, stderr)
	if !ok {
		return code
	}

	threads, err := sc.cl.listThreads(ctx, sc.owner, sc.repo, sc.pr)
	if err != nil {
		return fail(stderr, err)
	}

	rep := sc.applyItems(ctx, threads, *author, items)
	_, _ = io.WriteString(stdout, renderApply(*g.format, rep))

	if rep.Applied+countSkipsOK(rep, items) < rep.Requested {
		return exitError
	}

	return exitOK
}

// readApplyInput reads and decodes the stdin JSON array. A decode failure is a usage
// error (exit 2); the returned bool is false when the caller should return code.
func readApplyInput(stdin io.Reader, stderr io.Writer) ([]applyInput, int, bool) {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "review-fixer: read stdin: %v\n", err)

		return nil, exitError, false
	}

	var items []applyInput
	if err := json.Unmarshal(raw, &items); err != nil {
		_, _ = fmt.Fprintf(stderr, "review-fixer: invalid stdin JSON: %v\n", err)

		return nil, exitUsage, false
	}

	return items, exitOK, true
}

// applyItems performs the batch reply+resolve. It fetches nothing more: the thread list
// is passed in. unresolvedAtStart is the count of unresolved threads under the active
// filter; remaining is derived from it minus the threads resolved this run.
func (s scope) applyItems(ctx context.Context, threads []Thread, author string, items []applyInput) applyReport {
	byID := make(map[string]Thread, len(threads))
	for _, t := range threads {
		byID[t.ID] = t
	}

	unresolvedAtStart := len(filterThreads(threads, author))

	rep := applyReport{Results: make([]applyItemResult, 0, len(items)), Requested: len(items)}
	for _, item := range items {
		res := s.applyOne(ctx, byID, item)
		if res.Resolve == "ok" {
			rep.Applied++
		}

		rep.Results = append(rep.Results, res)
	}

	rep.Remaining = max(unresolvedAtStart-rep.Applied, 0)

	return rep
}

// applyOne handles a single requested item against the pre-fetched thread map.
func (s scope) applyOne(ctx context.Context, byID map[string]Thread, item applyInput) applyItemResult {
	res := applyItemResult{ThreadID: item.ThreadID}

	t, found := byID[item.ThreadID]
	switch {
	case !found:
		res.Reply, res.Resolve, res.Error = "skip", "skip", "unknown thread"

		return res
	case t.IsResolved:
		// Idempotent: already resolved, do nothing and report success.
		res.Reply, res.Resolve = "skip", "skip"

		return res
	}

	if err := s.cl.replyToComment(ctx, s.owner, s.repo, s.pr, t.RootCommentID, item.Body); err != nil {
		res.Reply, res.Resolve, res.Error = "fail", "skip", err.Error()

		return res
	}

	res.Reply = "ok"
	if err := s.cl.resolveThread(ctx, t.ID); err != nil {
		res.Resolve, res.Error = "fail", err.Error()

		return res
	}

	res.Resolve = "ok"

	return res
}

// countSkipsOK counts items that were skipped because they were already resolved (an
// idempotent success), distinguishing them from skipped-unknown failures.
func countSkipsOK(rep applyReport, _ []applyInput) int {
	n := 0
	for _, res := range rep.Results {
		if res.Reply == "skip" && res.Resolve == "skip" && res.Error == "" {
			n++
		}
	}

	return n
}

// renderApply formats an apply report.
func renderApply(format string, rep applyReport) string {
	if format == "json" {
		//nolint:errchkjson // concrete string/int fields cannot error
		b, _ := json.Marshal(rep)

		return string(b) + "\n"
	}

	var b strings.Builder
	for _, res := range rep.Results {
		_, _ = fmt.Fprintf(&b, "%s\n", applyLine(res))
	}

	_, _ = fmt.Fprintf(&b, "applied %d/%d; remaining unresolved: %d\n", rep.Applied, rep.Requested, rep.Remaining)

	return b.String()
}

// applyLine renders one result as a terse status line.
func applyLine(res applyItemResult) string {
	switch {
	case res.Reply == "fail":
		return fmt.Sprintf("reply-fail %s: %s", res.ThreadID, res.Error)
	case res.Resolve == "fail":
		return fmt.Sprintf("resolve-fail %s: %s", res.ThreadID, res.Error)
	case res.Reply == "skip":
		note := res.Error
		if note == "" {
			note = "already resolved"
		}

		return fmt.Sprintf("skip %s (%s)", res.ThreadID, note)
	default:
		return "ok " + res.ThreadID
	}
}
