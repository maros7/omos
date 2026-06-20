package reviewfixer

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExecRunner(t *testing.T) {
	r := execRunner{}

	// success: a real command that prints to stdout.
	out, err := r.Run(t.Context(), "go", "version")
	assert.NoError(t, err)
	assert.Contains(t, out, "go")

	// failure: a binary that does not exist.
	_, err = r.Run(t.Context(), "this-binary-does-not-exist-zzz")
	assert.Error(t, err)
}
