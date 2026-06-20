package reviewfixer

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// maxBodyLen is a generous, UTF-8-safe safety cap on how much of an originator comment
// body is shown in text output. Normal review comments are well under this and are never
// truncated; the cap only guards against a pathological comment dumping unbounded text.
const maxBodyLen = 4000

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

// clip truncates s to at most n bytes without splitting a multi-byte UTF-8 rune,
// backing off to the nearest rune boundary at or before n so the output stays valid.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}

	b := n
	for b > 0 && !utf8.RuneStart(s[b]) {
		b--
	}

	return s[:b]
}

// threadMatchesAuthor reports whether a thread's ORIGINATOR (first comment) author login
// contains author (case-insensitive). An empty author matches every thread. This is the
// single source of truth for the -author filter, shared by filterThreads and applyItems.
func threadMatchesAuthor(t Thread, author string) bool {
	want := strings.ToLower(author)

	return want == "" || strings.Contains(strings.ToLower(t.Author), want)
}

// filterThreads keeps unresolved threads, optionally restricting to those whose
// ORIGINATOR (first comment) author login contains author (case-insensitive); an empty
// author keeps every unresolved thread.
func filterThreads(threads []Thread, author string) []Thread {
	out := make([]Thread, 0, len(threads))
	for _, t := range threads {
		if t.IsResolved {
			continue
		}

		if !threadMatchesAuthor(t, author) {
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
		renderBody(&b, t.Body)
	}

	return b.String()
}

// renderBody writes the FULL originator comment body under its thread entry, indenting
// every line by four spaces so a multi-paragraph comment stays visually attached. The
// body is shown in full (so the agent never needs the JSON detour just to read it),
// bounded only by the UTF-8-safe maxBodyLen safety cap.
func renderBody(b *strings.Builder, body string) {
	if firstLine(body) == "" {
		fmt.Fprintln(b, "    (no comment body)")

		return
	}

	capped := strings.TrimRight(clip(body, maxBodyLen), "\n")
	for ln := range strings.SplitSeq(capped, "\n") {
		ln = strings.TrimRight(ln, " \t\r")
		if ln == "" {
			fmt.Fprintln(b)

			continue
		}

		fmt.Fprintf(b, "    %s\n", ln)
	}
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
