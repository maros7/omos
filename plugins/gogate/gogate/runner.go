package gogate

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
)

// Result is the captured outcome of running an external command. ExitCode is the
// process exit code, or -1 when the command could not be started at all (e.g. the
// binary was not found). TimedOut is true when the command was killed because the
// context deadline fired; in that case ExitCode is -1 (SIGKILL) but the cause is a
// timeout, not a missing binary.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
	TimedOut bool
}

// Runner executes external commands. It is an interface so tests can inject canned
// results instead of invoking the real toolchain.
type Runner interface {
	Run(ctx context.Context, dir, name string, args ...string) Result
}

// execRunner is the production Runner backed by os/exec.
type execRunner struct{}

// Run executes name with args in dir, capturing stdout and stderr.
func (execRunner) Run(ctx context.Context, dir, name string, args ...string) Result {
	// gogate's purpose is to run the go and golangci-lint toolchain; the command and
	// args are gogate's own, not untrusted input.
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // G204: runs the toolchain by design
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := 0
	if err != nil {
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			code = exitErr.ExitCode()
		} else {
			// Command could not be started (not found, bad dir, ...).
			code = -1
		}
	}

	// A context-deadline kill surfaces as a SIGKILL ExitError with code -1, identical
	// to "binary not found"; distinguish it so callers can report a timeout.
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)

	return Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: code, TimedOut: timedOut}
}
