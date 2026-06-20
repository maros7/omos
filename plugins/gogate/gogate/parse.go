package gogate

import (
	"bufio"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// atoi parses an int, returning 0 on failure (inputs come from validated regex groups).
func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// buildLineRe matches a Go compiler diagnostic line: "file.go:LINE[:COL]: message".
var buildLineRe = regexp.MustCompile(`^(.+?\.go):(\d+):(?:(\d+):)?\s*(.*)$`)

// parseDiagnostics extracts "file.go:line[:col]: message" diagnostics from `go build`
// or `go vet` output, tagging them with the given source. Package header lines
// (starting with '#') and non-matching lines are ignored.
func parseDiagnostics(out, source string) []Diagnostic {
	var diags []Diagnostic
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		m := buildLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		d := Diagnostic{
			File:     m[1],
			Line:     atoi(m[2]),
			Severity: "error",
			Source:   source,
			Message:  m[4],
		}
		if m[3] != "" {
			d.Col = atoi(m[3])
		}
		diags = append(diags, d)
	}

	return diags
}

// testEvent is a single `go test -json` event.
type testEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
	Output  string `json:"Output"`
}

// coverageRe matches "coverage: 81.4% of statements" lines.
var coverageRe = regexp.MustCompile(`coverage: ([0-9.]+)% of statements`)

// coverTotalRe matches the final "total:\t(statements)\t81.4%" line of `go tool cover
// -func` output.
var coverTotalRe = regexp.MustCompile(`total:\s+\(statements\)\s+([0-9.]+)%`)

// parseCoverTotal extracts the statement-weighted total from `go tool cover -func`.
func parseCoverTotal(out string) (float64, bool) {
	m := coverTotalRe.FindStringSubmatch(out)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	return f, err == nil
}

// coverFuncRe matches a per-function line of `go tool cover -func`:
// "path/file.go:12:\tFuncName\t83.3%".
var coverFuncRe = regexp.MustCompile(`^(.+\.go):(\d+):\s+(\S+)\s+([0-9.]+)%$`)

// coverBlockRe matches a coverprofile block line: "file:sL.sC,eL.eC numStmts count".
var coverBlockRe = regexp.MustCompile(`^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$`)

// maxUncoveredFuncs caps how many under-100% functions are reported, keeping the output
// token-bounded.
const maxUncoveredFuncs = 20

// coverBlock is an uncovered basic block (count 0) from a coverprofile.
type coverBlock struct {
	file       string
	start, end int
}

// parseUncoveredBlocks returns the never-executed blocks (count 0) of a coverprofile.
func parseUncoveredBlocks(profile string) []coverBlock {
	var blocks []coverBlock
	for line := range strings.SplitSeq(profile, "\n") {
		m := coverBlockRe.FindStringSubmatch(line)
		if m == nil || m[4] != "0" {
			continue
		}
		blocks = append(blocks, coverBlock{file: m[1], start: atoi(m[2]), end: atoi(m[3])})
	}

	return blocks
}

// enclosingFunc returns the index of the function containing blk — the one in the same
// file with the greatest declaration line at or before the block — or -1.
func enclosingFunc(fns []FuncCoverage, blk coverBlock) int {
	best := -1
	for i, f := range fns {
		if f.File == blk.file && f.Line <= blk.start && (best == -1 || f.Line > fns[best].Line) {
			best = i
		}
	}

	return best
}

// mergeRanges sorts and merges overlapping/adjacent line ranges.
func mergeRanges(rs []LineRange) []LineRange {
	if len(rs) < 2 {
		return rs
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].Start < rs[j].Start })
	merged := rs[:1]
	for _, r := range rs[1:] {
		last := &merged[len(merged)-1]
		switch {
		case r.Start > last.End+1:
			merged = append(merged, r)
		case r.End > last.End:
			last.End = r.End
		}
	}

	return merged
}

// uncoveredFuncs reports functions below 100% (from `go tool cover -func`), each with the
// exact uncovered line ranges (from the coverprofile blocks), sorted most-uncovered first
// and capped. profile may be empty (then only percentages are reported).
func uncoveredFuncs(funcOut, profile string) []FuncCoverage {
	var fns []FuncCoverage
	for line := range strings.SplitSeq(funcOut, "\n") {
		m := coverFuncRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pct, _ := strconv.ParseFloat(m[4], 64)
		if pct >= 100 {
			continue
		}
		fns = append(fns, FuncCoverage{File: m[1], Line: atoi(m[2]), Function: m[3], Pct: pct})
	}

	for _, blk := range parseUncoveredBlocks(profile) {
		if i := enclosingFunc(fns, blk); i >= 0 {
			fns[i].UncoveredLines = append(fns[i].UncoveredLines, LineRange{Start: blk.start, End: blk.end})
		}
	}
	for i := range fns {
		fns[i].UncoveredLines = mergeRanges(fns[i].UncoveredLines)
	}

	sort.Slice(fns, func(i, j int) bool {
		if fns[i].Pct != fns[j].Pct {
			return fns[i].Pct < fns[j].Pct
		}
		if fns[i].File != fns[j].File {
			return fns[i].File < fns[j].File
		}

		return fns[i].Line < fns[j].Line
	})
	if len(fns) > maxUncoveredFuncs {
		fns = fns[:maxUncoveredFuncs]
	}

	return fns
}

// testFileLineRe matches "foo_test.go:12:" references in failure output.
var testFileLineRe = regexp.MustCompile(`([\w./-]+_test\.go):(\d+):`)

// testParse is the parsed result of a `go test -json` stream.
type testParse struct {
	Counts    TestCounts
	Coverage  []PackageCoverage
	Failures  []Diagnostic
	Failed    []testRef // named failed tests (for re-running), excludes package-level failures
	PkgFailed bool      // a package-level failure (panic/timeout/race) that can't be isolated by name
	AllOutput string    // concatenated output, used to recover compile errors
}

// testRef identifies a test by package and name.
type testRef struct{ pkg, test string }

// testStream accumulates state while consuming a `go test -json` event stream.
//
// The running-test tracking and panic/race detection follow gotestsum's testjson model
// (github.com/gotestyourself/gotestsum, testjson/execution.go): `go test` omits the
// fail event for a test that panics or times out, so a test still "running" when the
// stream ends is treated as failed (their Package.end), and a package fail event with no
// failed tests indicates a TestMain/init panic or timeout (their Package.TestMainFailed).
type testStream struct {
	counts    TestCounts
	covSeen   map[string]float64
	covOrder  []string
	out       map[string]*strings.Builder // package/test -> buffered output
	running   map[string]testRef          // tests with a run but no terminal (pass/fail/skip) event
	failures  []Diagnostic
	failed    []testRef // named failed tests
	allOut    strings.Builder
	panicked  bool
	dataRace  bool
	pkgFail   bool   // a package-level fail event (Test == "") was seen
	pkgFailed bool   // a package-level failure was surfaced as a diagnostic (can't isolate by name)
	panicMsg  string // first "panic: ..." line, if any
}

func key(pkg, test string) string { return pkg + "\x00" + test }

// onOutput records output, detecting panic/race markers (by prefix, as gotestsum does),
// buffering per-test text, and capturing coverage lines.
func (s *testStream) onOutput(e testEvent) {
	s.allOut.WriteString(e.Output)

	if strings.HasPrefix(e.Output, "panic: ") {
		s.panicked = true
		if s.panicMsg == "" {
			s.panicMsg = strings.TrimSpace(e.Output)
		}
	}
	if strings.HasPrefix(e.Output, "WARNING: DATA RACE") {
		s.dataRace = true
	}

	if e.Test != "" {
		k := key(e.Package, e.Test)
		b := s.out[k]
		if b == nil {
			b = &strings.Builder{}
			s.out[k] = b
		}

		b.WriteString(e.Output)
	}

	if m := coverageRe.FindStringSubmatch(e.Output); m != nil {
		if _, ok := s.covSeen[e.Package]; !ok {
			s.covOrder = append(s.covOrder, e.Package)
		}

		s.covSeen[e.Package], _ = strconv.ParseFloat(m[1], 64)
	}
}

// failDiag builds a failure diagnostic, recovering file:line from the test's output.
func (s *testStream) failDiag(pkg, test string) Diagnostic {
	d := Diagnostic{Severity: "error", Source: "go test", Message: test + " failed in " + pkg}
	if b := s.out[key(pkg, test)]; b != nil {
		if m := testFileLineRe.FindStringSubmatch(b.String()); m != nil {
			d.File = m[1]
			d.Line = atoi(m[2])
		}
	}

	return d
}

// handle dispatches a single event, tracking running tests so panics/timeouts that omit
// a fail event can be recovered when the stream ends.
func (s *testStream) handle(e testEvent) {
	if e.Test == "" {
		if e.Action == "fail" {
			s.pkgFail = true
		}
		if e.Action == "output" {
			s.onOutput(e)
		}

		return
	}

	k := key(e.Package, e.Test)
	switch e.Action {
	case "output":
		s.onOutput(e)
	case "run":
		s.running[k] = testRef{e.Package, e.Test}
	case "pass":
		s.counts.Passed++
		delete(s.running, k)
	case "skip":
		s.counts.Skipped++
		delete(s.running, k)
	case "fail":
		s.counts.Failed++
		delete(s.running, k)
		s.failures = append(s.failures, s.failDiag(e.Package, e.Test))
		s.failed = append(s.failed, testRef{e.Package, e.Test})
	}
}

// sortedRunning returns the still-running tests in a stable order.
func (s *testStream) sortedRunning() []testRef {
	refs := make([]testRef, 0, len(s.running))
	for _, ref := range s.running {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].pkg != refs[j].pkg {
			return refs[i].pkg < refs[j].pkg
		}

		return refs[i].test < refs[j].test
	})

	return refs
}

// finish accounts for tests that never received a terminal event (panic/timeout) and for
// package-level failures with no failed test.
func (s *testStream) finish() {
	// Tests still running got no pass/fail/skip — `go test` dropped the fail event
	// because they panicked or the binary timed out. (gotestsum Package.end)
	for _, ref := range s.sortedRunning() {
		s.counts.Failed++
		s.failures = append(s.failures, s.failDiag(ref.pkg, ref.test))
		s.failed = append(s.failed, ref)
	}

	// A package failed with no failed test: a TestMain/init panic, a timeout, or a race
	// abort. Surface it; build-only failures have no panic/race and are left for the
	// compile-error path. (gotestsum Package.TestMainFailed). panicked implies panicMsg
	// is set, so the message is panicMsg unless it was a data race.
	if s.pkgFail && len(s.failures) == 0 && (s.panicked || s.dataRace) {
		msg := s.panicMsg
		if s.dataRace {
			msg = "data race detected"
		}
		s.failures = append(s.failures, Diagnostic{Severity: "error", Source: "go test", Message: msg})
		s.pkgFailed = true
	}

	// A `panic: test timed out` aborts the binary: the running tests are recovered above
	// as named failures, but they're not isolable — re-running them under -run would just
	// time out again. Mark the package failed so the rerun guard skips them.
	if strings.Contains(s.allOut.String(), "panic: test timed out") {
		s.pkgFailed = true
	}
}

// parseTestJSON consumes a `go test -json` stream and extracts pass/fail/skip counts,
// per-package coverage, and a diagnostic per failed test (including panicking/timed-out
// tests that go test reports without a fail event). Malformed or non-JSON lines are
// skipped.
func parseTestJSON(stream string) testParse {
	s := testStream{
		covSeen: map[string]float64{},
		out:     map[string]*strings.Builder{},
		running: map[string]testRef{},
	}

	sc := bufio.NewScanner(strings.NewReader(stream))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "{") {
			continue
		}

		var e testEvent
		if json.Unmarshal([]byte(line), &e) != nil {
			continue
		}

		s.handle(e)
	}
	s.finish()

	p := testParse{
		Counts:    s.counts,
		Failures:  s.failures,
		Failed:    s.failed,
		PkgFailed: s.pkgFailed,
		AllOutput: s.allOut.String(),
	}
	for _, pkg := range s.covOrder {
		p.Coverage = append(p.Coverage, PackageCoverage{Package: pkg, Pct: s.covSeen[pkg]})
	}

	return p
}

// lintReport is the subset of golangci-lint's JSON output we consume.
type lintReport struct {
	Issues []struct {
		FromLinter string `json:"FromLinter"`
		Text       string `json:"Text"`
		Severity   string `json:"Severity"`
		Pos        struct {
			Filename string `json:"Filename"`
			Line     int    `json:"Line"`
			Column   int    `json:"Column"`
		} `json:"Pos"`
	} `json:"Issues"`
}

// parseLintJSON parses golangci-lint JSON output into diagnostics. golangci-lint v2
// prints a trailing human summary line (e.g. "0 issues.") after the JSON object, so a
// streaming decoder is used to read just the first JSON value.
func parseLintJSON(stdout string) ([]Diagnostic, error) {
	var lr lintReport
	if err := json.NewDecoder(strings.NewReader(stdout)).Decode(&lr); err != nil {
		return nil, err
	}
	diags := make([]Diagnostic, 0, len(lr.Issues))
	for _, is := range lr.Issues {
		sev := is.Severity
		if sev == "" {
			sev = "warning"
		}
		diags = append(diags, Diagnostic{
			File:     is.Pos.Filename,
			Line:     is.Pos.Line,
			Col:      is.Pos.Column,
			Severity: sev,
			Message:  is.Text,
			Source:   is.FromLinter,
		})
	}

	return diags, nil
}
