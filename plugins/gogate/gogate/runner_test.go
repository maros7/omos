package gogate

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestExecRunner(t *testing.T) {
	r := execRunner{}

	// success
	res := r.Run(t.Context(), ".", "go", "version")
	assert.Zero(t, res.ExitCode)
	assert.Contains(t, res.Stdout, "go")

	// exit error (unknown subcommand -> non-zero exit)
	res = r.Run(t.Context(), ".", "go", "definitely-not-a-subcommand")
	assert.NotZero(t, res.ExitCode)

	// could not start (binary not found)
	res = r.Run(t.Context(), ".", "this-binary-does-not-exist-zzz")
	assert.Equal(t, -1, res.ExitCode)
	assert.False(t, res.TimedOut)

	// context deadline kill -> ExitCode -1 but flagged as a timeout, not "not found"
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	res = r.Run(ctx, ".", "sleep", "5")
	assert.Equal(t, -1, res.ExitCode)
	assert.True(t, res.TimedOut)
}

func TestExecRunner_InheritsParentEnv(t *testing.T) {
	// A nil cmd.Env means the child inherits the parent environment. gogate relies on
	// this so env-prefix rewrites (e.g. "GOWORK=off gogate go build") forward the
	// variable to the underlying go/golangci-lint subprocess. Guard against a regression
	// that sets cmd.Env explicitly.
	t.Setenv("GOWORK", "off")

	res := execRunner{}.Run(t.Context(), ".", "go", "env", "GOWORK")

	assert.Zero(t, res.ExitCode)
	assert.Equal(t, "off", strings.TrimSpace(res.Stdout))
}
