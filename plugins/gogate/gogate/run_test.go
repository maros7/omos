package gogate

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func Test_clip(t *testing.T) {
	assert.Equal(t, "hi", clip("  hi  ", 10))
	assert.Equal(t, "abc… (truncated)", clip("abcdef", 3))
}

func Test_clipRuneBoundary(t *testing.T) {
	// "é" is 2 bytes; clipping at a byte that splits it must back off to a rune boundary.
	out := clip("aéb", 2)
	assert.True(t, utf8.ValidString(strings.TrimSuffix(out, "… (truncated)")))
	assert.Equal(t, "a… (truncated)", out)
}

func Test_hasCoverFlag(t *testing.T) {
	assert.True(t, hasCoverFlag([]string{"-cover"}))
	assert.True(t, hasCoverFlag([]string{"-coverprofile=x"}))
	assert.True(t, hasCoverFlag([]string{"--coverprofile=x"})) // double-dash form
	assert.True(t, hasCoverFlag([]string{"--cover"}))
	assert.False(t, hasCoverFlag([]string{"-race", "./pkg"}))
}

func Test_hasRunFlag(t *testing.T) {
	assert.True(t, hasRunFlag([]string{"-run", "TestFoo"}))
	assert.True(t, hasRunFlag([]string{"--run", "TestFoo"})) // double-dash form
	assert.True(t, hasRunFlag([]string{"-run=TestFoo"}))
	assert.True(t, hasRunFlag([]string{"--run=TestFoo"}))
	assert.False(t, hasRunFlag([]string{"-race", "./pkg"}))
	assert.False(t, hasRunFlag([]string{"-runner"})) // boundary: must NOT match
}

// Test_runTestScopedCoverage pins the -run-scoped coverage behavior: on a scoped run the
// per-function "uncovered" breakdown is suppressed (it would flag every untargeted
// function) and Coverage.Scoped is set, while the truthful total/per-package % stay.
func Test_runTestScopedCoverage(t *testing.T) {
	stream := strings.Join([]string{
		`{"Action":"pass","Package":"p","Test":"TestFoo"}`,
		`{"Action":"output","Package":"p","Output":"coverage: 50.0% of statements\n"}`,
	}, "\n")
	funcOut := strings.Join([]string{
		"p/a.go:3:\tBar\t0.0%",
		"total:\t(statements)\t50.0%",
	}, "\n")
	r := fakeRunner{fn: func(_ string, args []string) Result {
		if len(args) > 1 && args[0] == "tool" {
			return Result{Stdout: funcOut + "\n"}
		}
		return Result{ExitCode: 0, Stdout: stream}
	}}

	for _, tc := range []struct {
		name       string
		extra      []string
		wantScoped bool
	}{
		{"unscoped", []string{"./pkg"}, false},
		{"scoped space form", []string{"-run", "TestFoo", "./pkg"}, true},
		{"scoped equals form", []string{"-run=TestFoo", "./pkg"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, cov := runTest(t.Context(), r, ".", tc.extra, 0)
			require.NotNil(t, cov)
			require.NotNil(t, cov.TotalPct) // total stays either way
			assert.InDelta(t, 50.0, *cov.TotalPct, 0.001)
			assert.Equal(t, tc.wantScoped, cov.Scoped)
			if tc.wantScoped {
				assert.Empty(t, cov.Uncovered)
			} else {
				assert.NotEmpty(t, cov.Uncovered)
			}
		})
	}
}

func Test_withPkgs(t *testing.T) {
	assert.Equal(t, []string{"./..."}, withPkgs(nil))
	assert.Equal(t, []string{"-race", "./pkg"}, withPkgs([]string{"-race", "./pkg"}))
}

func Test_runBuild(t *testing.T) {
	// pass; default package is ./...
	var got []string
	r := fakeRunner{fn: func(_ string, args []string) Result { got = args; return Result{ExitCode: 0} }}
	s := runBuild(t.Context(), r, ".", nil)
	assert.Equal(t, StatusPass, s.Status)
	assert.Equal(t, "ok", s.Summary)
	assert.Equal(t, []string{"build", "./..."}, got)

	// extra args forwarded verbatim
	runBuild(t.Context(), r, ".", []string{"-race", "./pkg"})
	assert.Equal(t, []string{"build", "-race", "./pkg"}, got)

	// fail with diagnostics
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 1, Stderr: "a.go:1:2: bad"} }}
	s = runBuild(t.Context(), r, ".", nil)
	assert.Equal(t, StatusFail, s.Status)
	assert.Len(t, s.Diagnostics, 1)
	assert.Contains(t, s.Summary, "1 build error")

	// fail with no parseable diagnostics -> raw stderr surfaced in Error
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 2, Stderr: "linker exploded"} }}
	s = runBuild(t.Context(), r, ".", nil)
	assert.Equal(t, StatusFail, s.Status)
	assert.Empty(t, s.Diagnostics)
	assert.Equal(t, "build failed", s.Summary)
	assert.Equal(t, "linker exploded", s.Error)
}

func Test_runBuildTimeout(t *testing.T) {
	r := fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: -1, TimedOut: true} }}
	s := runBuild(t.Context(), r, ".", nil)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Summary, "timed out")
}

func Test_runTestTimeout(t *testing.T) {
	r := fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: -1, TimedOut: true} }}
	s, _ := runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Summary, "timed out")
}

func Test_runTestTimeoutSkipsRerun(t *testing.T) {
	// `panic: test timed out` recovers the running test as a failure but marks the package
	// failed, so the rerun guard skips it (re-running would just time out again).
	stream := strings.Join([]string{
		`{"Action":"run","Package":"p","Test":"TestSlow"}`,
		`{"Action":"output","Package":"p","Test":"TestSlow","Output":"panic: test timed out after 10s\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}, "\n")
	calls := 0
	r := fakeRunner{fn: func(_ string, args []string) Result {
		if isRerun(args) {
			t.Fatalf("rerun should be skipped on a test timeout")
		}
		calls++
		return Result{ExitCode: 1, Stdout: stream}
	}}
	s, _ := runTest(t.Context(), r, ".", nil, 3)
	assert.Equal(t, StatusFail, s.Status)
	assert.Equal(t, 1, calls) // ran once, no rerun
}

func Test_testArgsFor(t *testing.T) {
	// no command -> default gate
	args, ok := testArgsFor(nil)
	assert.True(t, ok)
	assert.Nil(t, args)

	// go test contributes its args; a package present is kept as-is
	args, ok = testArgsFor([]string{"go", "test", "-run=X", "./pkg"})
	assert.True(t, ok)
	assert.Equal(t, []string{"-run=X", "./pkg"}, args)

	// go test with flags but no package -> ./... appended
	args, ok = testArgsFor([]string{"go", "test", "-run=X"})
	assert.True(t, ok)
	assert.Equal(t, []string{"-run=X", "./..."}, args)

	// space-form flag value must not be mistaken for a package -> ./... appended
	args, ok = testArgsFor([]string{"go", "test", "-run", "X"})
	assert.True(t, ok)
	assert.Equal(t, []string{"-run", "X", "./..."}, args)

	// the `all` meta-pattern counts as a package -> left as-is
	args, ok = testArgsFor([]string{"go", "test", "all"})
	assert.True(t, ok)
	assert.Equal(t, []string{"all"}, args)

	// no args -> ./... appended
	args, ok = testArgsFor([]string{"go", "test"})
	assert.True(t, ok)
	assert.Equal(t, []string{"./..."}, args)

	// other recognized commands contribute no test args (gate still runs)
	args, ok = testArgsFor([]string{"go", "build", "./..."})
	assert.True(t, ok)
	assert.Nil(t, args)

	// go vet is NOT recognized: the gate has no vet step, so accepting it would
	// silently drop the user's command. It returns the same false as other
	// unsupported commands.
	_, ok = testArgsFor([]string{"go", "vet", "./..."})
	assert.False(t, ok)

	// unrecognized
	_, ok = testArgsFor([]string{"go", "mod", "tidy"})
	assert.False(t, ok)
}

func Test_runTest(t *testing.T) {
	// pass: gogate injects -cover -coverprofile and reads the weighted total from
	// `go tool cover -func`; per-package comes from the test output.
	var testArgs []string
	stream := strings.Join([]string{
		`{"Action":"pass","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Output":"coverage: 80.0% of statements\n"}`,
	}, "\n")
	r := fakeRunner{fn: func(_ string, args []string) Result {
		if len(args) > 1 && args[0] == "tool" {
			return Result{Stdout: "total:\t(statements)\t81.4%\n"}
		}
		testArgs = args
		return Result{ExitCode: 0, Stdout: stream}
	}}
	s, cov := runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusPass, s.Status)
	assert.Equal(t, 1, s.Tests.Passed)
	require.NotNil(t, cov)
	require.NotNil(t, cov.TotalPct)
	assert.InDelta(t, 81.4, *cov.TotalPct, 0.001) // from go tool cover, not a mean
	require.Len(t, cov.ByPackage, 1)
	assert.InDelta(t, 80.0, cov.ByPackage[0].Pct, 0.001)
	assert.Equal(t, []string{"test", "-json", "-cover"}, testArgs[:3])
	assert.Equal(t, "./...", testArgs[len(testArgs)-1])
	assert.True(t, hasCoverFlag(testArgs)) // -coverprofile injected

	// user-supplied coverage flag -> gogate injects nothing and skips `go tool cover`
	coverCalls := 0
	r = fakeRunner{fn: func(_ string, args []string) Result {
		if len(args) > 1 && args[0] == "tool" {
			coverCalls++
		}
		testArgs = args
		return Result{ExitCode: 0, Stdout: stream}
	}}
	runTest(t.Context(), r, ".", []string{"-coverprofile=mine.out", "./pkg"}, 0)
	assert.Equal(t, []string{"test", "-json", "-coverprofile=mine.out", "./pkg"}, testArgs)
	assert.Zero(t, coverCalls)

	// fail with test failure diagnostics
	stream = strings.Join([]string{
		`{"Action":"output","Package":"p","Test":"TestB","Output":"x_test.go:9: nope\n"}`,
		`{"Action":"fail","Package":"p","Test":"TestB"}`,
	}, "\n")
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 1, Stdout: stream} }}
	s, cov = runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusFail, s.Status)
	assert.Len(t, s.Diagnostics, 1)
	assert.Nil(t, cov)

	// fail with no test failures -> compile error recovered from output
	stream = `{"Action":"output","Package":"p","Output":"p/z.go:3:1: undefined: Q\n"}`
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 1, Stdout: stream} }}
	s, _ = runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusFail, s.Status)
	require.Len(t, s.Diagnostics, 1)
	assert.Equal(t, "p/z.go", s.Diagnostics[0].File)

	// panic (run event, no fail event, package-level fail) -> recovered as a failure
	stream = strings.Join([]string{
		`{"Action":"run","Package":"p","Test":"TestP"}`,
		`{"Action":"output","Package":"p","Test":"TestP","Output":"panic: kaboom\n"}`,
		`{"Action":"fail","Package":"p"}`,
	}, "\n")
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 2, Stdout: stream} }}
	s, _ = runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusFail, s.Status)
	require.Len(t, s.Diagnostics, 1)
	assert.Contains(t, s.Diagnostics[0].Message, "TestP")

	// nothing parseable in the json stream -> raw stderr surfaced in Error
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 1, Stderr: "go: build failed weirdly"} }}
	s, _ = runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusFail, s.Status)
	assert.Empty(t, s.Diagnostics)
	assert.Equal(t, "go: build failed weirdly", s.Error)

	// unparseable non-empty json output -> that output surfaced in Error
	stream = `{"Action":"output","Package":"p","Output":"mysterious failure\n"}`
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 1, Stdout: stream} }}
	s, _ = runTest(t.Context(), r, ".", nil, 0)
	assert.Equal(t, StatusFail, s.Status)
	assert.Equal(t, "mysterious failure", s.Error)
}

func Test_runLint(t *testing.T) {
	// not installed
	r := fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: -1} }}
	s := runLint(t.Context(), r, ".", nil)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Error, "not found")

	// unparseable output
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: 3, Stdout: "boom"} }}
	s = runLint(t.Context(), r, ".", nil)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Error, "parse")

	// unparseable output AND non-zero exit -> real error from stderr is surfaced
	r = fakeRunner{fn: func(string, []string) Result {
		return Result{ExitCode: 7, Stderr: "level=error msg=\"can't load config\""}
	}}
	s = runLint(t.Context(), r, ".", nil)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Error, "can't load config")

	// timed out -> reported as a timeout, not "not found"
	r = fakeRunner{fn: func(string, []string) Result { return Result{ExitCode: -1, TimedOut: true} }}
	s = runLint(t.Context(), r, ".", nil)
	assert.Equal(t, StatusError, s.Status)
	assert.Contains(t, s.Summary, "timed out")
	assert.NotContains(t, s.Error, "not found")

	// pass (0 issues); default args
	var got []string
	r = fakeRunner{fn: func(_ string, args []string) Result { got = args; return Result{ExitCode: 0, Stdout: `{"Issues":[]}`} }}
	s = runLint(t.Context(), r, ".", nil)
	assert.Equal(t, StatusPass, s.Status)
	assert.Equal(t, "0 issues", s.Summary)
	assert.Equal(t, []string{"run", "--output.json.path", "stdout", "--allow-parallel-runners", "./..."}, got)

	// fail (issues); extra args forwarded
	r = fakeRunner{fn: func(_ string, args []string) Result {
		got = args
		return Result{ExitCode: 1, Stdout: `{"Issues":[{"FromLinter":"x","Text":"t","Pos":{"Filename":"a.go","Line":1,"Column":1}}]}`}
	}}
	s = runLint(t.Context(), r, ".", []string{"--config=x.yml", "./pkg"})
	assert.Equal(t, StatusFail, s.Status)
	assert.Len(t, s.Diagnostics, 1)
	assert.Equal(t, "1 issue(s)", s.Summary)
	assert.Equal(t, []string{"run", "--output.json.path", "stdout", "--allow-parallel-runners", "--config=x.yml", "./pkg"}, got)
}

func isRerun(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "^(") {
			return true
		}
	}

	return false
}

func Test_rerunArgs(t *testing.T) {
	// subtests collapse to their root; roots dedupe; default package is ./...
	args := rerunArgs(nil, []testRef{{"p", "TestA/x"}, {"p", "TestA/y"}, {"q", "TestB"}})
	assert.Equal(t, []string{"test", "-json", "-run", "^(TestA|TestB)$", "-count=1", "./..."}, args)

	// a user-supplied -run (and its packages) is stripped so gogate's isolation -run wins;
	// space form drops both tokens, = form drops the one token; -count=1 bypasses the cache.
	args = rerunArgs([]string{"-run", "Foo", "-race", "./pkg"}, []testRef{{"p", "TestA"}})
	assert.Equal(t, []string{"test", "-json", "-run", "^(TestA)$", "-count=1", "-race", "./pkg"}, args)

	args = rerunArgs([]string{"-run=Foo", "-v", "./..."}, []testRef{{"p", "TestA"}})
	assert.Equal(t, []string{"test", "-json", "-run", "^(TestA)$", "-count=1", "-v", "./..."}, args)
}

func Test_runTestRerunFlaky(t *testing.T) {
	initial := strings.Join([]string{
		`{"Action":"run","Package":"p","Test":"TestA"}`,
		`{"Action":"fail","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Output":"coverage: 50.0% of statements\n"}`,
	}, "\n")
	var rerunSeen []string
	r := fakeRunner{fn: func(_ string, args []string) Result {
		switch {
		case len(args) > 1 && args[0] == "tool":
			return Result{Stdout: "total:\t(statements)\t50.0%\n"}
		case isRerun(args):
			rerunSeen = args
			return Result{ExitCode: 0, Stdout: `{"Action":"pass","Package":"p","Test":"TestA"}`}
		default:
			return Result{ExitCode: 1, Stdout: initial}
		}
	}}
	s, cov := runTest(t.Context(), r, ".", nil, 2)

	assert.Equal(t, StatusPass, s.Status)
	assert.Equal(t, []string{"TestA"}, s.Flaky)
	assert.Equal(t, 1, s.Tests.Passed)
	assert.Equal(t, 0, s.Tests.Failed)
	assert.Contains(t, s.Summary, "1 flaky")
	assert.Empty(t, s.Diagnostics)
	require.NotNil(t, cov) // coverage from the initial run is preserved
	assert.Contains(t, rerunSeen, "^(TestA)$")
}

func Test_runTestRerunPersistent(t *testing.T) {
	fail := strings.Join([]string{
		`{"Action":"run","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Test":"TestA","Output":"a_test.go:3: nope\n"}`,
		`{"Action":"fail","Package":"p","Test":"TestA"}`,
	}, "\n")
	r := fakeRunner{fn: func(_ string, _ []string) Result { return Result{ExitCode: 1, Stdout: fail} }}
	s, _ := runTest(t.Context(), r, ".", nil, 3)

	assert.Equal(t, StatusFail, s.Status)
	assert.Empty(t, s.Flaky)
	assert.Equal(t, 1, s.Tests.Failed)
	require.Len(t, s.Diagnostics, 1)
}

// Test_runTestRerunCount pins the gotestsum --rerun-fails-max convention: the flag value
// is the number of re-runs (the initial test run is never counted). 0 disables reruns,
// and any N>=1 yields exactly N re-runs of a persistently failing test.
func Test_runTestRerunCount(t *testing.T) {
	fail := strings.Join([]string{
		`{"Action":"run","Package":"p","Test":"TestA"}`,
		`{"Action":"output","Package":"p","Test":"TestA","Output":"a_test.go:3: nope\n"}`,
		`{"Action":"fail","Package":"p","Test":"TestA"}`,
	}, "\n")

	for _, tc := range []struct {
		name       string
		rerun      int
		wantReruns int // re-runs after the initial run
		wantStatus Status
		wantFailed int
		wantFlaky  int
	}{
		{"disabled", 0, 0, StatusFail, 1, 0},
		{"one rerun", 1, 1, StatusFail, 1, 0},
		{"three reruns", 3, 3, StatusFail, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			initials, reruns := 0, 0
			r := fakeRunner{fn: func(_ string, args []string) Result {
				if isRerun(args) {
					reruns++
					return Result{ExitCode: 1, Stdout: fail}
				}
				initials++
				return Result{ExitCode: 1, Stdout: fail}
			}}
			s, _ := runTest(t.Context(), r, ".", nil, tc.rerun)

			assert.Equal(t, 1, initials, "initial run should happen exactly once")
			assert.Equal(t, tc.wantReruns, reruns, "re-run count must match -rerun-fails")
			assert.Equal(t, tc.wantStatus, s.Status)
			assert.Equal(t, tc.wantFailed, s.Tests.Failed)
			assert.Len(t, s.Flaky, tc.wantFlaky)
		})
	}
}

func Test_skippedStep(t *testing.T) {
	s := skippedStep(StepTest, "build failed")
	assert.Equal(t, StatusSkipped, s.Status)
	assert.Equal(t, "skipped: build failed", s.Summary)
}

func Test_recognizeCommand(t *testing.T) {
	for _, tc := range []struct {
		cmd  []string
		step string
		rest []string
	}{
		{[]string{"go", "build", "./..."}, StepBuild, []string{"./..."}},
		{[]string{"go", "test", "-run", "X"}, StepTest, []string{"-run", "X"}},
		{[]string{"golangci-lint", "run", "./pkg"}, StepLint, []string{"./pkg"}},
	} {
		step, rest, ok := recognizeCommand(tc.cmd)
		require.True(t, ok, tc.cmd)
		assert.Equal(t, tc.step, step)
		assert.Equal(t, tc.rest, rest)
	}

	// `go vet` is intentionally NOT recognized: the gate has no vet step, so accepting
	// it would silently drop the user's command. It now behaves like other unsupported
	// commands (e.g. `go mod tidy`) and surfaces a visible "unrecognized command" step.
	for _, cmd := range [][]string{
		{"go", "mod", "tidy"},
		{"go", "vet", "./..."},
		{"go"},
		{"golangci-lint", "version"},
		{"ls"},
		nil,
	} {
		_, _, ok := recognizeCommand(cmd)
		assert.False(t, ok, cmd)
	}
}

func TestRunGatePass(t *testing.T) {
	rep := Run(t.Context(), gateRunner(), cfg())
	assert.True(t, rep.OK)
	assert.Len(t, rep.Steps, 3)
	assert.Equal(t, SchemaVersion, rep.SchemaVersion)
	require.NotNil(t, rep.Coverage)
	require.NotNil(t, rep.Coverage.TotalPct)
	assert.InDelta(t, 90.0, *rep.Coverage.TotalPct, 0.001)
}

func TestRunGateBuildFailShortCircuits(t *testing.T) {
	r := fakeRunner{fn: func(name string, args []string) Result {
		if name == "go" && len(args) > 0 && args[0] == "build" {
			return Result{ExitCode: 1, Stderr: "a.go:1:1: nope"}
		}
		require.FailNow(t, "step should not run", "%s %v", name, args)
		return Result{}
	}}
	rep := Run(t.Context(), r, cfg())
	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 3)
	assert.Equal(t, StatusSkipped, rep.Steps[1].Status)
	assert.Equal(t, StatusSkipped, rep.Steps[2].Status)
}

func TestRunGateScopesTestStep(t *testing.T) {
	// A `go test` command runs the full gate but scopes the test step's args; build and
	// lint still run over ./...
	var testGot, buildGot []string
	r := fakeRunner{fn: func(name string, args []string) Result {
		switch {
		case name == "go" && len(args) > 1 && args[0] == "tool":
			return Result{Stdout: "total:\t(statements)\t90.0%\n"}
		case name == "go" && len(args) > 0 && args[0] == "build":
			buildGot = args
			return Result{ExitCode: 0}
		case name == "go" && len(args) > 0 && args[0] == "test":
			testGot = args
			return Result{ExitCode: 0, Stdout: `{"Action":"output","Package":"p","Output":"coverage: 90.0% of statements\n"}`}
		default:
			return Result{ExitCode: 0, Stdout: `{"Issues":[]}`}
		}
	}}
	c := cfg()
	c.Command = []string{"go", "test", "-run=X", "./pkg"}
	rep := Run(t.Context(), r, c)

	require.Len(t, rep.Steps, 3) // build, test, lint all run
	assert.True(t, rep.OK)
	assert.Equal(t, []string{"build", "./..."}, buildGot)                  // build is whole-module
	assert.Equal(t, []string{"test", "-json", "-cover"}, testGot[:3])      // managed flags
	assert.Equal(t, []string{"-run=X", "./pkg"}, testGot[len(testGot)-2:]) // scoped to the command
	require.NotNil(t, rep.Coverage)
	assert.True(t, rep.Coverage.Scoped)     // -run scopes the coverage report
	assert.Empty(t, rep.Coverage.Uncovered) // per-function breakdown suppressed
}

func TestRunUnrecognizedCommand(t *testing.T) {
	c := cfg()
	c.Command = []string{"go", "mod", "tidy"}
	rep := Run(t.Context(), gateRunner(), c)
	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 1)
	assert.Equal(t, StatusError, rep.Steps[0].Status)
	assert.Contains(t, rep.Steps[0].Error, "go mod tidy")
}

// TestRunGoVetRejected pins the resolution of the silent go-vet no-op: the gate has no
// vet step, so `go vet` must surface a visible "unrecognized command" error rather than
// being accepted and silently dropped (which previously masked the command entirely).
func TestRunGoVetRejected(t *testing.T) {
	c := cfg()
	c.Command = []string{"go", "vet", "./..."}
	rep := Run(t.Context(), gateRunner(), c)
	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 1)
	assert.Equal(t, StatusError, rep.Steps[0].Status)
	assert.Contains(t, rep.Steps[0].Error, "go vet")
}
