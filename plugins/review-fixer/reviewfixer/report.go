package reviewfixer

import (
	"encoding/json"
	"fmt"
	"strings"
)

// maxBodyLen caps how much of an originator comment body appears in compact output.
const maxBodyLen = 200

// threadLoc renders a thread's "<path>:<line>" location, dropping the line when absent
// and using "-" when there is no path at all.
func threadLoc(t Thread) string {
	if t.Path == "" {
		return "-"
	}

	if t.Line > 0 {
		return fmt.Sprintf("%s:%d", t.Path, t.Line)
	}

	return t.Path
}

// firstLine returns the first non-empty, trimmed line of s, capped at maxBodyLen.
func firstLine(s string) string {
	for ln := range strings.SplitSeq(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln != "" {
			return clip(ln, maxBodyLen)
		}
	}

	return ""
}

// clip truncates s to at most n bytes.
func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}

	return s
}

// filterThreads keeps unresolved threads, optionally restricting to those whose
// ORIGINATOR (first comment) author login contains author (case-insensitive); an empty
// author keeps every unresolved thread.
func filterThreads(threads []Thread, author string) []Thread {
	want := strings.ToLower(author)

	out := make([]Thread, 0, len(threads))
	for _, t := range threads {
		if t.IsResolved {
			continue
		}

		if want != "" && !strings.Contains(strings.ToLower(t.Author), want) {
			continue
		}

		out = append(out, t)
	}

	return out
}

// listItem is the JSON shape for one thread in `list -format json`.
type listItem struct {
	ThreadID string `json:"threadId"`
	Path     string `json:"path"`
	Line     int    `json:"line"`
	Author   string `json:"author"`
	Body     string `json:"body"`
}

// renderList formats the matching threads for the `list` subcommand.
func renderList(format string, pr int, owner, repo string, threads []Thread) string {
	if format == "json" {
		items := make([]listItem, 0, len(threads))
		for _, t := range threads {
			items = append(items, listItem{
				ThreadID: t.ID,
				Path:     t.Path,
				Line:     t.Line,
				Author:   t.Author,
				Body:     t.Body,
			})
		}

		//nolint:errchkjson // concrete string/int fields cannot error
		b, _ := json.Marshal(items)

		return string(b) + "\n"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "PR #%d %s/%s: %d unresolved thread(s)\n", pr, owner, repo, len(threads))
	for i, t := range threads {
		fmt.Fprintf(&b, "[%d] %s  %s  (%s)%s\n", i+1, t.ID, threadLoc(t), t.Author, replyMarker(t.Replies))
		fmt.Fprintf(&b, "    %s\n", firstLine(t.Body))
	}

	return b.String()
}

// replyMarker renders "  +N" when a thread has reply comments, else "".
func replyMarker(n int) string {
	if n > 0 {
		return fmt.Sprintf("  +%d", n)
	}

	return ""
}

// verifyResult is the JSON shape for the `verify` subcommand.
type verifyResult struct {
	Unresolved int      `json:"unresolved"`
	ThreadIDs  []string `json:"threadIds"`
}

// renderVerify formats the unresolved threads for the `verify` subcommand.
func renderVerify(format string, pr int, owner, repo string, threads []Thread) string {
	ids := make([]string, 0, len(threads))
	for _, t := range threads {
		ids = append(ids, t.ID)
	}

	if format == "json" {
		//nolint:errchkjson // concrete string/int fields cannot error
		b, _ := json.Marshal(verifyResult{Unresolved: len(ids), ThreadIDs: ids})

		return string(b) + "\n"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "PR #%d %s/%s: %d unresolved thread(s)\n", pr, owner, repo, len(ids))
	for _, id := range ids {
		fmt.Fprintf(&b, "%s\n", id)
	}

	return b.String()
}
