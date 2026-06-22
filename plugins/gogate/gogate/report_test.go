package gogate

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func Test_capDiagnostics(t *testing.T) {
	kept, trunc, omitted := capDiagnostics(make([]Diagnostic, 3))
	assert.Len(t, kept, 3)
	assert.False(t, trunc)
	assert.Zero(t, omitted)

	kept, trunc, omitted = capDiagnostics(make([]Diagnostic, maxDiagnostics+5))
	assert.Len(t, kept, maxDiagnostics)
	assert.True(t, trunc)
	assert.Equal(t, 5, omitted)
}

func Test_diagLine(t *testing.T) {
	// full location + source
	assert.Equal(t, "a.go:12:5  errcheck: unchecked error",
		diagLine(Diagnostic{File: "a.go", Line: 12, Col: 5, Severity: "error", Source: "errcheck", Message: "unchecked error"}))

	// warning severity is surfaced; no column
	assert.Equal(t, "b.go:3  govet warning: shadow",
		diagLine(Diagnostic{File: "b.go", Line: 3, Severity: "warning", Source: "govet", Message: "shadow"}))

	// no location (e.g. package-level panic)
	assert.Equal(t, "go test: panic: boom",
		diagLine(Diagnostic{Severity: "error", Source: "go test", Message: "panic: boom"}))

	// no source and no location -> bare message
	assert.Equal(t, "mystery", diagLine(Diagnostic{Message: "mystery"}))
}

func Test_renderDiagnostics(t *testing.T) {
	var b strings.Builder
	renderDiagnostics(&b, []Diagnostic{
		{Source: "errcheck", Severity: "error", Message: "unchecked", File: "a.go", Line: 1},
		{Source: "errcheck", Severity: "error", Message: "unchecked", File: "b.go", Line: 5}, // same → grouped
		{Source: "govet", Severity: "error", Message: "shadow", File: "c.go", Line: 3},       // singleton w/ loc
		{Source: "go test", Severity: "error", Message: "panic: x"},                          // singleton, no loc
		{Source: "go test", Severity: "error", Message: "boom"},
		{Source: "go test", Severity: "error", Message: "boom"}, // grouped, no loc
	})
	out := b.String()

	assert.Contains(t, out, "errcheck: unchecked (2)\n")
	assert.Contains(t, out, "    a.go:1, b.go:5\n")
	assert.Contains(t, out, "  c.go:3  govet: shadow\n")
	assert.Contains(t, out, "  go test: panic: x\n")
	assert.Contains(t, out, "  go test: boom (2)\n")
}

func Test_renderText(t *testing.T) {
	total := 73.0
	rep := Report{
		OK:         false,
		DurationMs: 1200,
		Steps: []Step{
			{Name: "build", Status: StatusPass, Summary: "ok"},
			{
				Name: "test", Status: StatusFail, Summary: "1 passed, 1 failed, 0 skipped",
				Tests:        &TestCounts{Passed: 1, Failed: 1},
				Diagnostics:  []Diagnostic{{File: "x_test.go", Line: 9, Severity: "error", Source: "go test", Message: "TestB failed in p"}},
				Flaky:        []string{"TestFlaky"},
				Truncated:    true,
				OmittedCount: 3,
			},
			{Name: "lint", Status: StatusError, Summary: "lint unavailable", Error: "golangci-lint not found"},
		},
		Coverage: &Coverage{
			TotalPct:  &total,
			ByPackage: []PackageCoverage{{Package: "p", Pct: 73.0}},
			Uncovered: []FuncCoverage{
				{File: "p.go", Line: 3, Function: "Bar", Pct: 0, UncoveredLines: []LineRange{{Start: 3, End: 3}, {Start: 7, End: 9}}},
			},
		},
	}
	out := renderText(rep)

	// every step that ran is present, with status and detail
	assert.Contains(t, out, "gogate: FAIL (1200ms)")
	assert.Contains(t, out, "build") // all three steps named
	assert.Contains(t, out, "test")
	assert.Contains(t, out, "lint")
	assert.Contains(t, out, "1 passed, 1 failed, 0 skipped")
	assert.Contains(t, out, "x_test.go:9  go test: TestB failed in p")
	assert.Contains(t, out, "… (+3 more)")
	assert.Contains(t, out, "flaky (passed on re-run): TestFlaky")
	assert.Contains(t, out, "error: golangci-lint not found")
	assert.Contains(t, out, "coverage: 73.0%")
	assert.Contains(t, out, "p  73.0%")
	assert.Contains(t, out, "uncovered (add tests here):")
	assert.Contains(t, out, "Bar  0.0%  p.go:3  uncovered lines: 3, 7-9")

	// a passing run with no coverage renders without a coverage block
	ok := renderText(Report{OK: true, Steps: []Step{{Name: "build", Status: StatusPass, Summary: "ok"}}})
	assert.Contains(t, ok, "gogate: OK")
	assert.NotContains(t, ok, "coverage:")

	// coverage with an unknown total (nil) omits the total line but keeps per-package
	noTotal := renderText(Report{OK: true, Coverage: &Coverage{
		ByPackage: []PackageCoverage{{Package: "p", Pct: 50.0}},
	}})
	assert.NotContains(t, noTotal, "coverage:")
	assert.Contains(t, noTotal, "p  50.0%")
}

func Test_renderCoverageScoped(t *testing.T) {
	total := 3.2
	out := renderText(Report{OK: true, Coverage: &Coverage{
		TotalPct:  &total,
		Scoped:    true,
		ByPackage: []PackageCoverage{{Package: "p", Pct: 3.2}},
	}})
	assert.Contains(t, out, "coverage: 3.2% (scoped to -run; not whole-package)")
	assert.Contains(t, out, "p  3.2%")
	assert.NotContains(t, out, "uncovered (add tests here):")
}

func Test_renderCoverageScopedNoTotal(t *testing.T) {
	out := renderText(Report{OK: true, Coverage: &Coverage{
		Scoped:    true,
		ByPackage: []PackageCoverage{{Package: "p", Pct: 50.0}},
	}})
	assert.Contains(t, out, "coverage (scoped to -run):")
	assert.Contains(t, out, "p  50.0%")
}
