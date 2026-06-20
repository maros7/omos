package reviewfixer

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFirstLine(t *testing.T) {
	assert.Equal(t, "hello", firstLine("  \nhello\nworld"))
	assert.Empty(t, firstLine("   \n  "))
	assert.Empty(t, firstLine(""))

	// A first line longer than maxBodyLen is clipped.
	long := strings.Repeat("x", 250)
	assert.Len(t, firstLine(long), maxBodyLen)
}
