package gogate

import (
	"context"
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
