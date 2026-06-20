// Package gogate runs a Go quality gate (build, test, lint) in a single pass and
// produces a structured, machine-readable report. The command in cmd/gogate is a
// thin wrapper around this package; all logic lives here so it can be tested on its
// own without invoking the real toolchain.
package gogate

import (
	"fmt"
	"strconv"
	"strings"
)

// SchemaVersion is the version of the JSON report schema emitted by this package.
const SchemaVersion = 1

// Status is the outcome of a single step.
type Status string

const (
	// StatusPass means the step ran and succeeded.
	StatusPass Status = "pass"
	// StatusFail means the step ran and reported problems.
	StatusFail Status = "fail"
	// StatusSkipped means the step did not run (e.g. build failed first).
	StatusSkipped Status = "skipped"
	// StatusError means the step could not run (e.g. tool not installed).
	StatusError Status = "error"
)

// Diagnostic is a single problem located in the source.
type Diagnostic struct {
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Col      int    `json:"col,omitempty"`
	Severity string `json:"severity,omitempty"`
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

// TestCounts summarizes test outcomes.
type TestCounts struct {
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
}

// PackageCoverage is statement coverage for one package.
type PackageCoverage struct {
	Package string  `json:"package"`
	Pct     float64 `json:"pct"`
}

// LineRange is an inclusive span of source lines.
type LineRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// FuncCoverage is statement coverage for a single function below 100%, pointing the
// reader at where to add tests. UncoveredLines are the exact line ranges of code the
// tests never ran (each is a basic block — an if/else arm shows as its own range).
type FuncCoverage struct {
	File           string      `json:"file"`
	Line           int         `json:"line"`
	Function       string      `json:"function"`
	Pct            float64     `json:"pct"`
	UncoveredLines []LineRange `json:"uncoveredLines,omitempty"`
}

// Coverage is aggregate coverage. TotalPct is the statement-weighted total from
// `go tool cover -func`; ByPackage is per-package coverage from `go test -cover`;
// Uncovered lists functions below 100% (most-uncovered first) so the model knows where
// to focus.
type Coverage struct {
	TotalPct  *float64          `json:"totalPct,omitempty"`
	ByPackage []PackageCoverage `json:"byPackage"`
	Uncovered []FuncCoverage    `json:"uncovered,omitempty"`
}

// Step is the result of one stage of the gate.
type Step struct {
	Name         string       `json:"name"`
	Status       Status       `json:"status"`
	DurationMs   int64        `json:"durationMs"`
	Summary      string       `json:"summary"`
	Diagnostics  []Diagnostic `json:"diagnostics,omitempty"`
	Tests        *TestCounts  `json:"tests,omitempty"`
	Flaky        []string     `json:"flaky,omitempty"` // tests that failed initially but passed on re-run
	Error        string       `json:"error,omitempty"`
	Truncated    bool         `json:"truncated,omitempty"`
	OmittedCount int          `json:"omittedCount,omitempty"`
}

// Report is the full result of a gate run.
type Report struct {
	SchemaVersion int       `json:"schemaVersion"`
	OK            bool      `json:"ok"`
	DurationMs    int64     `json:"durationMs"`
	Steps         []Step    `json:"steps"`
	Coverage      *Coverage `json:"coverage,omitempty"`
}

// maxDiagnostics caps how many diagnostics a single step reports, keeping the JSON
// result token-bounded.
const maxDiagnostics = 50

// capDiagnostics truncates d to maxDiagnostics, reporting whether truncation happened
// and how many were omitted.
func capDiagnostics(d []Diagnostic) (kept []Diagnostic, truncated bool, omitted int) {
	if len(d) <= maxDiagnostics {
		return d, false, 0
	}
	return d[:maxDiagnostics], true, len(d) - maxDiagnostics
}

// diagLoc renders the "<file>:<line>:<col>" location of a diagnostic (parts absent are
// dropped); empty when the diagnostic has no file.
func diagLoc(d Diagnostic) string {
	loc := d.File
	if d.Line > 0 {
		loc += ":" + strconv.Itoa(d.Line)
	}
	if d.Col > 0 {
		loc += ":" + strconv.Itoa(d.Col)
	}

	return loc
}

// diagLabel renders the "<source> [severity]: <message>" part of a diagnostic.
func diagLabel(d Diagnostic) string {
	prefix := d.Source
	if d.Severity != "" && d.Severity != "error" {
		prefix += " " + d.Severity // surface warnings; errors are the default
	}
	if prefix == "" {
		return d.Message
	}

	return prefix + ": " + d.Message
}

// diagLine renders one diagnostic as "<loc>  <source> [severity]: <message>".
func diagLine(d Diagnostic) string {
	loc := diagLoc(d)
	if loc == "" {
		return diagLabel(d)
	}

	return loc + "  " + diagLabel(d)
}

// diagGroup collects diagnostics that share a source/severity/message.
type diagGroup struct {
	label string
	locs  []string
	count int
}

// renderDiagnostics writes diagnostics, collapsing repeats of the same source+message
// into one label plus a list of locations (e.g. the same linter finding across many
// lines), so identical errors don't each take a line. Singletons stay one line.
func renderDiagnostics(b *strings.Builder, diags []Diagnostic) {
	order := make([]string, 0, len(diags))
	groups := map[string]*diagGroup{}
	for _, d := range diags {
		k := d.Source + "\x00" + d.Severity + "\x00" + d.Message
		g := groups[k]
		if g == nil {
			g = &diagGroup{label: diagLabel(d)}
			groups[k] = g
			order = append(order, k)
		}
		g.count++
		if loc := diagLoc(d); loc != "" {
			g.locs = append(g.locs, loc)
		}
	}

	for _, k := range order {
		g := groups[k]
		if g.count == 1 {
			if len(g.locs) == 1 {
				fmt.Fprintf(b, "  %s  %s\n", g.locs[0], g.label)
			} else {
				fmt.Fprintf(b, "  %s\n", g.label)
			}

			continue
		}
		fmt.Fprintf(b, "  %s (%d)\n", g.label, g.count)
		if len(g.locs) > 0 {
			fmt.Fprintf(b, "    %s\n", strings.Join(g.locs, ", "))
		}
	}
}

// renderStep writes one step's status line plus its error, diagnostics, truncation note,
// and flaky tests.
func renderStep(b *strings.Builder, s Step) {
	fmt.Fprintf(b, "\n%-5s %-7s %s\n", s.Name, s.Status, s.Summary)
	if s.Error != "" {
		fmt.Fprintf(b, "  error: %s\n", s.Error)
	}
	renderDiagnostics(b, s.Diagnostics)
	if s.Truncated {
		fmt.Fprintf(b, "  … (+%d more)\n", s.OmittedCount)
	}
	if len(s.Flaky) > 0 {
		fmt.Fprintf(b, "  flaky (passed on re-run): %s\n", strings.Join(s.Flaky, ", "))
	}
}

// renderCoverage writes the coverage total, per-package, and under-100% functions.
func renderCoverage(b *strings.Builder, cov *Coverage) {
	if cov == nil {
		return
	}
	if cov.TotalPct != nil {
		fmt.Fprintf(b, "\ncoverage: %.1f%%\n", *cov.TotalPct)
	}
	for _, p := range cov.ByPackage {
		fmt.Fprintf(b, "  %s  %.1f%%\n", p.Package, p.Pct)
	}
	if len(cov.Uncovered) > 0 {
		b.WriteString("  uncovered (add tests here):\n")
		for _, f := range cov.Uncovered {
			fmt.Fprintf(b, "    %s  %.1f%%  %s:%d", f.Function, f.Pct, f.File, f.Line)
			if lines := rangesStr(f.UncoveredLines); lines != "" {
				fmt.Fprintf(b, "  uncovered lines: %s", lines)
			}
			b.WriteByte('\n')
		}
	}
}

// rangesStr renders line ranges as "90-92, 95" (single lines collapse to one number).
func rangesStr(rs []LineRange) string {
	parts := make([]string, len(rs))
	for i, r := range rs {
		if r.Start == r.End {
			parts[i] = strconv.Itoa(r.Start)
		} else {
			parts[i] = strconv.Itoa(r.Start) + "-" + strconv.Itoa(r.End)
		}
	}

	return strings.Join(parts, ", ")
}

// renderText renders a Report as a compact, complete plain-text summary: every step that
// ran with its status and detail, all diagnostics, coverage, and flaky tests — so no
// context from the JSON is lost.
func renderText(rep Report) string {
	var b strings.Builder

	status := "OK"
	if !rep.OK {
		status = "FAIL"
	}
	fmt.Fprintf(&b, "gogate: %s (%dms)\n", status, rep.DurationMs)

	for _, s := range rep.Steps {
		renderStep(&b, s)
	}
	renderCoverage(&b, rep.Coverage)

	return b.String()
}
