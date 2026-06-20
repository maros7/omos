package reviewfixer

import (
	"context"
	"os/exec"
)

// Runner executes external commands and returns their captured stdout. It is an
// interface so tests can inject canned results instead of invoking real tools (gh,
// git). On failure it returns whatever stdout was captured plus a non-nil error.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (stdout string, err error)
}

// execRunner is the production Runner backed by os/exec.
type execRunner struct{}

// Run executes name with args, returning its stdout. The command and args are this
// tool's own (gh, git), not untrusted input.
func (execRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // G204: runs gh/git by design
	out, err := cmd.Output()

	return string(out), err
}
