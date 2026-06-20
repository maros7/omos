package gogate

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func Test_parseCoverTotal(t *testing.T) {
	out := "github.com/x/y/a.go:1:\tFoo\t100.0%\ntotal:\t(statements)\t81.4%\n"
	pct, ok := parseCoverTotal(out)
	require.True(t, ok)
	assert.InDelta(t, 81.4, pct, 0.001)

	_, ok = parseCoverTotal("no total here")
	assert.False(t, ok)
}

func Test_uncoveredFuncs(t *testing.T) {
	out := strings.Join([]string{
		"pkg/b.go:1:\tBar\t0.0%",
		"pkg/a.go:10:\tFoo\t50.0%",
		"pkg/a.go:99:\tFooB\t50.0%", // same pct + file as Foo, later line
		"pkg/z.go:5:\tQux\t50.0%",   // same pct as Foo, later file
		"pkg/c.go:3:\tBaz\t100.0%",  // 100% -> excluded
		"total:\t(statements)\t60.0%",
	}, "\n")
	fns := uncoveredFuncs(out, "")
	require.Len(t, fns, 4) // Baz excluded; total line ignored

	// most-uncovered first, then by file, then line
	assert.Equal(t, "Bar", fns[0].Function)
	assert.InDelta(t, 0.0, fns[0].Pct, 0.001)
	assert.Equal(t, []string{"Foo", "FooB", "Qux"}, []string{fns[1].Function, fns[2].Function, fns[3].Function})
	assert.Equal(t, "pkg/b.go", fns[0].File)
	assert.Equal(t, 1, fns[0].Line)

	// cap
	var b strings.Builder
	for i := range maxUncoveredFuncs + 5 {
		fmt.Fprintf(&b, "f.go:%d:\tF%d\t1.0%%\n", i, i)
	}
	assert.Len(t, uncoveredFuncs(b.String(), ""), maxUncoveredFuncs)
}

func Test_uncoveredFuncsWithProfile(t *testing.T) {
	funcOut := strings.Join([]string{
		"a.go:10:\tFoo\t40.0%",
		"a.go:30:\tBar\t0.0%",
	}, "\n")
	// blocks: count 0 = uncovered. Foo (start 10): lines 12-13 and 14 (adjacent → merge to
	// 12-14), plus 20 (separate). Bar (start 30): line 31. A covered block is ignored, and
	// a block before any function (line 1) maps nowhere.
	profile := strings.Join([]string{
		"mode: set",
		"a.go:12.2,13.10 2 0",
		"a.go:14.2,14.20 1 0",
		"a.go:18.2,18.5 1 1", // covered -> ignored
		"a.go:20.2,20.9 1 0",
		"a.go:31.2,31.9 1 0",
		"a.go:1.1,1.10 1 0", // before any func -> unmapped
	}, "\n")
	fns := uncoveredFuncs(funcOut, profile)
	require.Len(t, fns, 2)

	// Bar is most-uncovered (0%) first
	assert.Equal(t, "Bar", fns[0].Function)
	assert.Equal(t, []LineRange{{Start: 31, End: 31}}, fns[0].UncoveredLines)

	assert.Equal(t, "Foo", fns[1].Function)
	assert.Equal(t, []LineRange{{Start: 12, End: 14}, {Start: 20, End: 20}}, fns[1].UncoveredLines)
}

func Test_parseDiagnostics(t *testing.T) {
	out := strings.Join([]string{
		"# github.com/x/y",
		"pkg/a.go:12:5: undefined: Foo",
		"pkg/b.go:3: syntax error: unexpected }",
		"this line does not match",
		"",
	}, "\n")
	diags := parseDiagnostics(out, "compiler")
	require.Len(t, diags, 2)

	assert.Equal(t, "pkg/a.go", diags[0].File)
	assert.Equal(t, 12, diags[0].Line)
	assert.Equal(t, 5, diags[0].Col)
	assert.Equal(t, "compiler", diags[0].Source)
	assert.Equal(t, "error", diags[0].Severity)

	assert.Equal(t, "pkg/b.go", diags[1].File)
	assert.Equal(t, 3, diags[1].Line)
	assert.Zero(t, diags[1].Col)

	// source is parameterized (vet reuses this parser)
	vet := parseDiagnostics("x.go:1:1: bad", "vet")
	require.Len(t, vet, 1)
	assert.Equal(t, "vet", vet[0].Source)
}

func Test_parseTestJSON(t *testing.T) {
	lines := []string{
		`not json`,
		`{bad json`,
		`{"Action":"run","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Test":"TestA","Output":"ok\n"}`,
		`{"Action":"pass","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Test":"TestB","Output":"    foo_test.go:7: boom\n"}`,
		`{"Action":"fail","Package":"p","Test":"TestB"}`,
		`{"Action":"skip","Package":"p","Test":"TestC"}`,
		`{"Action":"output","Package":"p","Output":"coverage: 75.0% of statements\n"}`,
		`{"Action":"pass","Package":"p"}`,
		`{"Action":"output","Package":"q","Output":"coverage: 50.0% of statements\n"}`,
		`{"Action":"output","Package":"q","Output":"coverage: 50.0% of statements\n"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))

	assert.Equal(t, TestCounts{Passed: 1, Failed: 1, Skipped: 1}, p.Counts)

	require.Len(t, p.Failures, 1)
	assert.Equal(t, "foo_test.go", p.Failures[0].File)
	assert.Equal(t, 7, p.Failures[0].Line)

	require.Len(t, p.Coverage, 2)
	assert.Equal(t, PackageCoverage{Package: "p", Pct: 75.0}, p.Coverage[0])
	assert.Equal(t, PackageCoverage{Package: "q", Pct: 50.0}, p.Coverage[1])
}

func Test_parseTestJSONPanickingTest(t *testing.T) {
	// A test that panics: go test emits run + output(panic) but no fail event. The
	// parser must recover it as a failure (gotestsum Package.end).
	lines := []string{
		`{"Action":"run","Package":"p","Test":"TestPanic"}`,
		`{"Action":"output","Package":"p","Test":"TestPanic","Output":"panic: boom\n"}`,
		`{"Action":"output","Package":"p","Test":"TestPanic","Output":"\tfoo_test.go:9 +0x1a\n"}`,
		`{"Action":"fail","Package":"p"}`, // package-level fail only
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	assert.Equal(t, 1, p.Counts.Failed)
	require.Len(t, p.Failures, 1)
	assert.Contains(t, p.Failures[0].Message, "TestPanic")
}

func Test_parseTestJSONMultipleRunningSorted(t *testing.T) {
	// Several tests left running (a timeout killed the binary): recovered as failures in
	// a stable package/test order.
	lines := []string{
		`{"Action":"run","Package":"b","Test":"T1"}`,
		`{"Action":"run","Package":"a","Test":"T2"}`,
		`{"Action":"run","Package":"a","Test":"T1"}`,
		`{"Action":"output","Package":"a","Output":"panic: test timed out after 30s\n"}`,
		`{"Action":"fail","Package":"a"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	assert.Equal(t, 3, p.Counts.Failed)
	require.Len(t, p.Failures, 3)
	assert.Contains(t, p.Failures[0].Message, "T1 failed in a")
	assert.Contains(t, p.Failures[1].Message, "T2 failed in a")
	assert.Contains(t, p.Failures[2].Message, "T1 failed in b")
}

func Test_parseTestJSONTestMainPanic(t *testing.T) {
	// Panic with no running test (e.g. TestMain/init) -> package-level failure surfaced.
	lines := []string{
		`{"Action":"output","Package":"p","Output":"panic: init boom\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	require.Len(t, p.Failures, 1)
	assert.Equal(t, "panic: init boom", p.Failures[0].Message)
}

func Test_parseTestJSONDataRace(t *testing.T) {
	lines := []string{
		`{"Action":"output","Package":"p","Output":"WARNING: DATA RACE\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	require.Len(t, p.Failures, 1)
	assert.Equal(t, "data race detected", p.Failures[0].Message)
}

func Test_parseTestJSONTestTimeoutMarksPkgFailed(t *testing.T) {
	// `panic: test timed out` recovers the running test as a failure but is not isolable;
	// PkgFailed must be set so the rerun guard skips it.
	lines := []string{
		`{"Action":"run","Package":"p","Test":"TestSlow"}`,
		`{"Action":"output","Package":"p","Test":"TestSlow","Output":"panic: test timed out after 10s\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	require.Len(t, p.Failed, 1)
	assert.True(t, p.PkgFailed)
}

func Test_parseTestJSONBuildFailNotMistakenForPanic(t *testing.T) {
	// Package fail with no panic/race -> left for the compile-error path (no synthetic
	// failure), so the real file:line diagnostics survive.
	lines := []string{
		`{"Action":"output","Package":"p","Output":"p/z.go:3:1: undefined: Q\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}
	p := parseTestJSON(strings.Join(lines, "\n"))
	assert.Empty(t, p.Failures)
}

func Test_parseTestJSONFailNoFileLine(t *testing.T) {
	p := parseTestJSON(`{"Action":"fail","Package":"p","Test":"TestX"}`)
	require.Len(t, p.Failures, 1)
	assert.Empty(t, p.Failures[0].File)
}

func Test_parseLintJSON(t *testing.T) {
	in := `{"Issues":[
	  {"FromLinter":"errcheck","Text":"unchecked error","Severity":"error","Pos":{"Filename":"a.go","Line":1,"Column":2}},
	  {"FromLinter":"govet","Text":"shadow","Pos":{"Filename":"b.go","Line":5,"Column":0}}
	]}`
	diags, err := parseLintJSON(in)
	require.NoError(t, err)
	require.Len(t, diags, 2)
	assert.Equal(t, "errcheck", diags[0].Source)
	assert.Equal(t, "error", diags[0].Severity)
	assert.Equal(t, "a.go", diags[0].File)
	assert.Equal(t, "warning", diags[1].Severity)

	_, err = parseLintJSON("not json")
	assert.Error(t, err)

	diags, err = parseLintJSON(`{"Issues":[]}`)
	require.NoError(t, err)
	assert.Empty(t, diags)

	// golangci-lint v2 appends a trailing summary line after the JSON object.
	diags, err = parseLintJSON("{\"Issues\":[]}\n0 issues.\n")
	require.NoError(t, err)
	assert.Empty(t, diags)
}
