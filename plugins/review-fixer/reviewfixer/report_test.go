package reviewfixer

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
)

func TestFirstLine(t *testing.T) {
	assert.Equal(t, "hello", firstLine("  \nhello\nworld"))
	assert.Empty(t, firstLine("   \n  "))
	assert.Empty(t, firstLine(""))

	// A first line longer than maxBodyLen is clipped at the safety cap.
	long := strings.Repeat("x", maxBodyLen+50)
	assert.Len(t, firstLine(long), maxBodyLen)
}

func TestRenderBody(t *testing.T) {
	// Multi-paragraph body: every non-blank line indented 4 spaces, blank line kept as
	// a bare separator (no trailing spaces), full content preserved.
	var b strings.Builder
	renderBody(&b, "first line\nsecond line\n\nthird para")
	assert.Equal(t, "    first line\n    second line\n\n    third para\n", b.String())

	// Empty / whitespace-only body falls back to a placeholder.
	var e strings.Builder
	renderBody(&e, "   \n  ")
	assert.Equal(t, "    (no comment body)\n", e.String())

	// Pathological body is bounded by the UTF-8-safe cap.
	var big strings.Builder
	renderBody(&big, strings.Repeat("y", maxBodyLen+500))
	assert.LessOrEqual(t, len(big.String()), maxBodyLen+len("    ")+1)
	assert.True(t, utf8.ValidString(big.String()))
}

func TestClip(t *testing.T) {
	// Shorter than the limit: returned unchanged.
	assert.Equal(t, "hi", clip("hi", 10))

	// ASCII at the limit: cut exactly at n bytes (every byte is a rune start).
	assert.Equal(t, "abcd", clip("abcde", 4))

	// Multi-byte runes: a byte budget landing mid-rune must back off to the
	// previous rune boundary, never splitting a rune or exceeding n bytes.
	euros := strings.Repeat("\u20ac", 5) // U+20AC is 3 bytes each
	got := clip(euros, 4)                // 4 lands inside the 2nd rune
	assert.Equal(t, "\u20ac", got)
	assert.True(t, utf8.ValidString(got))
	assert.LessOrEqual(t, len(got), 4)
}
