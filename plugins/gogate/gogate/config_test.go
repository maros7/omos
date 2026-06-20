package gogate_test

import (
	"context"
	"testing"

	"github.com/maros7/omos/plugins/gogate/gogate"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// noopRunner records nothing and returns success; used to drive Run from the public API.
type noopRunner struct{}

func (noopRunner) Run(context.Context, string, string, ...string) gogate.Result {
	return gogate.Result{ExitCode: 0, Stdout: `{"Issues":[]}`}
}

// Both an empty command and a recognized command run the full gate (build, test, lint).
// This exercises the package's public surface (Config + Run) end to end with a fake runner.
func TestRunPublicAPI(t *testing.T) {
	gate := gogate.Run(t.Context(), noopRunner{}, gogate.Config{Dir: "."})
	require.Len(t, gate.Steps, 3)
	assert.True(t, gate.OK)
	assert.Equal(t, gogate.StepBuild, gate.Steps[0].Name)
	assert.Equal(t, gogate.StepTest, gate.Steps[1].Name)
	assert.Equal(t, gogate.StepLint, gate.Steps[2].Name)

	scoped := gogate.Run(t.Context(), noopRunner{}, gogate.Config{
		Dir:     ".",
		Command: []string{"go", "test", "-run=X", "./pkg"},
	})
	assert.Len(t, scoped.Steps, 3) // a go test command still runs the full gate
}
