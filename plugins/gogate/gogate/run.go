package gogate

import (
	"context"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// elapsedMs returns milliseconds since start.
func elapsedMs(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// clip trims s and caps it to max bytes, marking truncation; keeps raw tool output
// token-bounded when surfaced in the report.
func clip(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) <= limit {
		return s
	}
	// Back off to a UTF-8 rune boundary so truncation never splits a multi-byte rune.
	end := limit
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}

	return s[:end] + "… (truncated)"
}

// hasCoverFlag reports whether the user already passed a coverage flag, in which case
// gogate leaves coverage to them rather than injecting its own -coverprofile.
func hasCoverFlag(extra []string) bool {
	for _, a := range extra {
		// Catch both single- and double-dash forms (-cover…, --coverprofile=…).
		if strings.HasPrefix(a, "-cover") || strings.HasPrefix(a, "--cover") {
			return true
		}
	}

	return false
}

// hasRunFlag reports whether the user scoped the run with -run/--run (space or = form).
// Mirrors the shapes stripRunFlag recognizes. A -run filter means gogate's injected
// coverprofile reflects only the matched tests, so the per-function "uncovered" breakdown
// would misleadingly flag every untargeted function — we drop it for such runs.
func hasRunFlag(extra []string) bool {
	for _, a := range extra {
		if a == "-run" || a == "--run" ||
			strings.HasPrefix(a, "-run=") || strings.HasPrefix(a, "--run=") {
			return true
		}
	}

	return false
}

// coverage builds the coverage report: per-package percentages from the test output,
// plus an accurate statement-weighted total from `go tool cover -func` (when gogate
// wrote a profile). Returns nil when no package reported coverage.
func coverage(ctx context.Context, r Runner, dir string, byPkg []PackageCoverage, profile string, scoped bool) *Coverage {
	if len(byPkg) == 0 {
		return nil
	}
	cov := &Coverage{ByPackage: byPkg, Scoped: scoped}
	if profile != "" {
		res := r.Run(ctx, dir, "go", "tool", "cover", "-func="+profile)
		if pct, ok := parseCoverTotal(res.Stdout); ok {
			cov.TotalPct = &pct
		}
		// On a -run-scoped run the per-function breakdown would flag every untargeted
		// function as uncovered, so skip it; the total/per-package % stay (truthful).
		if !scoped {
			content, _ := os.ReadFile(profile) //nolint:gosec // G304: gogate-owned temp profile
			cov.Uncovered = uncoveredFuncs(res.Stdout, string(content))
		}
	}

	return cov
}

// markTimedOut sets a step to the error status with a timeout message, used when a
// command was killed because the overall deadline fired.
func markTimedOut(step *Step, what string) {
	step.Status = StatusError
	step.Summary = what + " timed out"
	step.Error = what + " timed out before completing"
}

// applyDiagnostics attaches diagnostics to a step, applying the truncation cap.
func applyDiagnostics(step *Step, diags []Diagnostic) {
	kept, truncated, omitted := capDiagnostics(diags)
	step.Diagnostics = kept
	step.Truncated = truncated
	step.OmittedCount = omitted
}

// withPkgs returns extra unchanged, or ["./..."] when no args were given (full gate).
func withPkgs(extra []string) []string {
	if len(extra) == 0 {
		return []string{"./..."}
	}
	return extra
}

// runBuild runs `go build <extra>` and reports compiler diagnostics.
func runBuild(ctx context.Context, r Runner, dir string, extra []string) Step {
	start := time.Now()
	res := r.Run(ctx, dir, "go", append([]string{"build"}, withPkgs(extra)...)...)
	step := Step{Name: StepBuild, DurationMs: elapsedMs(start)}
	if res.TimedOut {
		markTimedOut(&step, "build")
		return step
	}
	if res.ExitCode == 0 {
		step.Status = StatusPass
		step.Summary = "ok"
		return step
	}
	step.Status = StatusFail
	diags := parseDiagnostics(res.Stderr, "compiler")
	applyDiagnostics(&step, diags)
	if len(diags) == 0 {
		// No compiler diagnostics parsed (e.g. a bad flag, linker, or toolchain error):
		// surface the raw stderr so the failure isn't a black box.
		step.Summary = "build failed"
		step.Error = clip(res.Stderr, 4000)
	} else {
		step.Summary = fmt.Sprintf("%d build error(s)", len(diags))
	}

	return step
}

// runTest runs the tests once, then re-runs failed tests up to rerun attempts when
// enabled (and the failures are isolable by name).
func runTest(ctx context.Context, r Runner, dir string, extra []string, rerun int) (Step, *Coverage) {
	step, cov, p := runTestOnce(ctx, r, dir, extra)
	// rerun is the number of re-runs to attempt (0 = off, N = N reruns), matching
	// gotestsum's --rerun-fails-max convention. The initial run above is not counted.
	if rerun < 1 || step.Status != StatusFail || p.PkgFailed || len(p.Failed) == 0 || len(p.Failed) > maxRerunFailures {
		return step, cov
	}

	return rerunFailed(ctx, r, dir, extra, step, p.Failed, rerun), cov
}

// runTestOnce runs `go test -json -cover <extra>` and reports counts, coverage, and
// failures. Unless the user passes their own coverage flag, gogate writes a temporary
// coverprofile so it can report an accurate statement-weighted total.
func runTestOnce(ctx context.Context, r Runner, dir string, extra []string) (Step, *Coverage, testParse) {
	start := time.Now()
	args := []string{"test", "-json"}

	profile := ""
	if !hasCoverFlag(extra) {
		args = append(args, "-cover")
		if f, err := os.CreateTemp("", "gogate-cover-*.out"); err == nil {
			profile = f.Name()
			_ = f.Close()
			defer func() { _ = os.Remove(profile) }()
			args = append(args, "-coverprofile="+profile)
		}
	}
	args = append(args, withPkgs(extra)...)

	res := r.Run(ctx, dir, "go", args...)
	p := parseTestJSON(res.Stdout)

	counts := p.Counts
	step := Step{Name: StepTest, DurationMs: elapsedMs(start), Tests: &counts}
	step.Summary = fmt.Sprintf("%d passed, %d failed, %d skipped", counts.Passed, counts.Failed, counts.Skipped)

	cov := coverage(ctx, r, dir, p.Coverage, profile, hasRunFlag(extra))

	if res.TimedOut {
		markTimedOut(&step, "test")
		return step, cov, p
	}
	if res.ExitCode == 0 {
		step.Status = StatusPass
		return step, cov, p
	}
	step.Status = StatusFail
	// p.Failures already includes panicking/timed-out tests and package-level
	// panic/race failures (recovered by the parser). If still empty, the failure is a
	// compile error in a test file.
	diags := p.Failures
	if len(diags) == 0 {
		diags = parseDiagnostics(p.AllOutput, "compiler")
	}
	applyDiagnostics(&step, diags)
	if len(diags) == 0 {
		// Nothing parseable: surface raw output so the failure isn't a black box.
		raw := p.AllOutput
		if strings.TrimSpace(raw) == "" {
			raw = res.Stderr
		}
		step.Error = clip(raw, 4000)
	}
	if hint := noPackagesHint(dir, counts, p.AllOutput, res.Stderr); hint != "" {
		if step.Error == "" {
			step.Error = hint
		} else {
			step.Error += "\n" + hint
		}
	}

	return step, cov, p
}

// noPackagesHint returns a tool-agnostic hint when the test step clearly matched no
// packages in the current module: zero pass/fail counts plus a no-packages marker in
// the output. It is empty otherwise (e.g. a normal test failure with real counts).
func noPackagesHint(dir string, counts TestCounts, output, stderr string) string {
	if counts.Passed != 0 || counts.Failed != 0 {
		return ""
	}
	// Markers the Go toolchain emits when the test command matched nothing in the
	// current module (often because the packages live in a nested module under dir).
	markers := []string{
		"matched no packages",
		"no required module provides package",
		"[setup failed]",
		"is not in module",
		"no Go files",
	}
	combined := output + "\n" + stderr
	for _, m := range markers {
		if strings.Contains(combined, m) {
			return fmt.Sprintf("hint: no packages matched in %s; if these packages live in a nested Go module, run the gate from that module's directory.", dir)
		}
	}

	return ""
}

// maxRerunFailures caps how many failed tests will be re-run; above this, failures are
// likely real breakage (not flakiness), so re-running is skipped. (gotestsum default.)
const maxRerunFailures = 10

// rootName returns the top-level test name, stripping any subtest path.
func rootName(test string) string {
	root, _, _ := strings.Cut(test, "/")

	return root
}

// stripRunFlag removes any user-provided -run / -run=… token (and the separate value in
// the space form) so gogate's own -run for failure isolation isn't overridden — Go honors
// the last -run, and the user's would otherwise come after gogate's.
func stripRunFlag(extra []string) []string {
	out := make([]string, 0, len(extra))
	for i := 0; i < len(extra); i++ {
		a := extra[i]
		if a == "-run" || a == "--run" {
			i++ // also skip the separate value token
			continue
		}
		if strings.HasPrefix(a, "-run=") || strings.HasPrefix(a, "--run=") {
			continue
		}
		out = append(out, a)
	}

	return out
}

// rerunArgs builds `go test -json -run ^(Root1|Root2)$ -count=1 <packages>` for the
// failed tests. -count=1 bypasses the test cache so reruns actually re-execute.
func rerunArgs(extra []string, failed []testRef) []string {
	seen := map[string]bool{}
	roots := make([]string, 0, len(failed))
	for _, ft := range failed {
		root := rootName(ft.test)
		if !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	pkgs := withPkgs(stripRunFlag(extra))
	args := make([]string, 0, 5+len(pkgs))
	args = append(args, "test", "-json", "-run", "^("+strings.Join(roots, "|")+")$", "-count=1")

	return append(args, pkgs...)
}

// rerunFailed re-runs the failed tests until they pass or attempts are exhausted, then
// rebuilds the step: tests that eventually pass are reported as flaky, the rest remain
// failed. (gotestsum --rerun-fails.) Coverage from the initial run is kept as-is.
func rerunFailed(ctx context.Context, r Runner, dir string, extra []string, step Step, failed []testRef, attempts int) Step {
	remaining := failed
	flaky := map[string]bool{}
	lastFailures := step.Diagnostics

	// The loop performs exactly `attempts` re-runs of the initial failures (or fewer
	// if they all pass early); attempt counts the re-runs, not the initial run.
	for attempt := 1; attempt <= attempts && len(remaining) > 0; attempt++ {
		res := r.Run(ctx, dir, "go", rerunArgs(extra, remaining)...)
		p := parseTestJSON(res.Stdout)
		for _, ft := range remaining {
			if !slices.Contains(p.Failed, ft) {
				flaky[ft.test] = true
			}
		}
		remaining = p.Failed
		lastFailures = p.Failures
	}

	if len(remaining) == 0 {
		step.Status = StatusPass
		step.Diagnostics = nil
		step.Truncated = false
		step.OmittedCount = 0
	} else {
		applyDiagnostics(&step, lastFailures)
	}

	step.Flaky = sortedKeys(flaky)
	if step.Tests != nil {
		step.Tests.Passed += len(step.Flaky)
		step.Tests.Failed = len(remaining)
		step.Summary = fmt.Sprintf("%d passed, %d failed, %d skipped", step.Tests.Passed, step.Tests.Failed, step.Tests.Skipped)
	}
	if len(step.Flaky) > 0 {
		step.Summary += fmt.Sprintf(" (%d flaky)", len(step.Flaky))
	}

	return step
}

// sortedKeys returns the map keys sorted.
func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	return keys
}

// runLint runs `golangci-lint run <extra>` and reports its findings.
func runLint(ctx context.Context, r Runner, dir string, extra []string) Step {
	start := time.Now()
	// --allow-parallel-runners: don't fail when another gogate/golangci-lint instance
	// holds the lock (e.g. multiple agents linting the same module concurrently).
	args := append([]string{"run", "--output.json.path", "stdout", "--allow-parallel-runners"}, withPkgs(extra)...)
	res := r.Run(ctx, dir, "golangci-lint", args...)
	step := Step{Name: StepLint, DurationMs: elapsedMs(start)}

	if res.TimedOut {
		markTimedOut(&step, "lint")
		return step
	}
	if res.ExitCode == -1 {
		step.Status = StatusError
		step.Summary = "lint unavailable"
		step.Error = "golangci-lint not found; install from https://golangci-lint.run/"
		return step
	}

	diags, err := parseLintJSON(res.Stdout)
	if err != nil {
		step.Status = StatusError
		step.Summary = "lint output unparseable"
		// When golangci-lint exits non-zero, its real error is on stderr (stdout empty →
		// EOF); surface it alongside the parse error so the failure isn't a black box.
		step.Error = "failed to parse golangci-lint output: " + err.Error()
		if res.ExitCode != 0 {
			if se := clip(res.Stderr, 4000); se != "" {
				step.Error += ": " + se
			}
		}

		return step
	}

	if len(diags) == 0 {
		step.Status = StatusPass
		step.Summary = "0 issues"
		return step
	}
	step.Status = StatusFail
	step.Summary = fmt.Sprintf("%d issue(s)", len(diags))
	applyDiagnostics(&step, diags)

	return step
}

// skippedStep builds a skipped step with a reason.
func skippedStep(name, reason string) Step {
	return Step{Name: name, Status: StatusSkipped, Summary: "skipped: " + reason}
}

// recognizeCommand identifies a wrapped tool command and returns the step name plus the
// args after the subcommand. ok is false if the command is not one gogate wraps.
//
// `go vet` is intentionally not recognized: the gate has no vet step, so accepting it
// here would silently drop the user's command (the gate would run build/test/lint and
// never invoke vet). Rejecting it yields a visible "unrecognized command" step instead,
// matching other unsupported commands (e.g. `go mod tidy`).
func recognizeCommand(cmd []string) (step string, rest []string, ok bool) {
	if len(cmd) >= 2 && cmd[0] == "go" {
		switch cmd[1] {
		case "build", "test":
			return cmd[1], cmd[2:], true
		}
	}
	if len(cmd) >= 2 && cmd[0] == "golangci-lint" && cmd[1] == "run" {
		return StepLint, cmd[2:], true
	}

	return "", nil, false
}

// testArgsFor derives the test step's args from the triggering command and reports
// whether the command is recognized. An empty command runs the default gate. A `go test`
// command contributes its args (flags + packages); other recognized commands (go build,
// golangci-lint run) contribute none — the gate still runs all three steps.
func testArgsFor(cmd []string) (args []string, ok bool) {
	if len(cmd) == 0 {
		return nil, true
	}
	step, rest, recognized := recognizeCommand(cmd)
	if !recognized {
		return nil, false
	}
	if step == StepTest {
		return ensurePackage(rest), true
	}

	return nil, true
}

// looksLikePackage reports whether a token looks like a package pattern rather than a
// flag value: an import path (starts with ./, /, or . or contains /) or the meta-pattern
// `all`. This avoids mistaking a flag's value (e.g. the X in `-run X`) for a package.
func looksLikePackage(a string) bool {
	if a == "all" {
		return true
	}

	return strings.HasPrefix(a, "./") || strings.HasPrefix(a, "/") ||
		strings.HasPrefix(a, ".") || strings.Contains(a, "/")
}

// ensurePackage appends ./... when args carry no package pattern, so a command like
// `go test -run X` still covers the module rather than just the cwd. A token only counts
// as a package when it looks like one, so a flag's space-separated value isn't mistaken
// for a package.
func ensurePackage(args []string) []string {
	if slices.ContainsFunc(args, looksLikePackage) {
		return args
	}

	return append(args, "./...")
}

// Run produces a structured report. It always runs the gate — build, then test, then
// lint — short-circuiting test and lint when the build fails. A recognized command in
// cfg.Command scopes the test step (build and lint always cover ./...); an unrecognized
// command yields a single error step. It never returns an error: tool failures are
// recorded inside the report.
func Run(ctx context.Context, r Runner, cfg Config) Report {
	start := time.Now()
	rep := Report{SchemaVersion: SchemaVersion, Steps: []Step{}}

	rep.Steps, rep.Coverage = gate(ctx, r, cfg)

	rep.OK = true
	for _, s := range rep.Steps {
		if s.Status == StatusFail || s.Status == StatusError {
			rep.OK = false
		}
	}
	rep.DurationMs = elapsedMs(start)

	return rep
}

// gate runs build → test → lint. build and lint cover ./...; testArgs scopes the test
// step. A build failure short-circuits test and lint to skipped.
func gate(ctx context.Context, r Runner, cfg Config) ([]Step, *Coverage) {
	testArgs, ok := testArgsFor(cfg.Command)
	if !ok {
		return []Step{{
			Name:    "command",
			Status:  StatusError,
			Summary: "unrecognized command",
			Error:   "gogate runs go build|test or golangci-lint run; got: " + strings.Join(cfg.Command, " "),
		}}, nil
	}

	build := runBuild(ctx, r, cfg.Dir, nil)
	if build.Status == StatusFail {
		return []Step{build, skippedStep(StepTest, "build failed"), skippedStep(StepLint, "build failed")}, nil
	}

	test, cov := runTest(ctx, r, cfg.Dir, testArgs, cfg.RerunFails)
	lint := runLint(ctx, r, cfg.Dir, nil)

	return []Step{build, test, lint}, cov
}
