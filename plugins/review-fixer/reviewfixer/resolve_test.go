package reviewfixer

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRunner returns canned stdout/err keyed off the command name and args.
type fakeRunner struct {
	fn func(name string, args []string) (string, error)
}

func (f fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	return f.fn(name, args)
}

// errRunner fails every call; used to assert a seam is never reached on the happy path.
func errRunner() fakeRunner {
	return fakeRunner{fn: func(_ string, _ []string) (string, error) {
		return "", errors.New("runner should not be called")
	}}
}

func TestResolveToken(t *testing.T) {
	ctx := t.Context()

	// -token flag wins.
	tok, err := resolveToken(ctx, errRunner(), "flagtok")
	require.NoError(t, err)
	assert.Equal(t, "flagtok", tok)

	// GH_TOKEN env.
	t.Setenv("GH_TOKEN", "ghtok")
	tok, err = resolveToken(ctx, errRunner(), "")
	require.NoError(t, err)
	assert.Equal(t, "ghtok", tok)

	// GITHUB_TOKEN env (GH_TOKEN cleared).
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "gittok")
	tok, err = resolveToken(ctx, errRunner(), "")
	require.NoError(t, err)
	assert.Equal(t, "gittok", tok)
}

func TestResolveTokenViaGH(t *testing.T) {
	ctx := t.Context()
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")

	// gh auth token succeeds.
	r := fakeRunner{fn: func(_ string, _ []string) (string, error) { return "exectok\n", nil }}
	tok, err := resolveToken(ctx, r, "")
	require.NoError(t, err)
	assert.Equal(t, "exectok", tok)

	// gh auth token fails.
	rErr := fakeRunner{fn: func(_ string, _ []string) (string, error) { return "", errors.New("boom") }}
	_, err = resolveToken(ctx, rErr, "")
	assert.Error(t, err)

	// gh auth token returns empty output.
	rEmpty := fakeRunner{fn: func(_ string, _ []string) (string, error) { return "  \n", nil }}
	_, err = resolveToken(ctx, rEmpty, "")
	assert.Error(t, err)
}

func TestResolveRepo(t *testing.T) {
	ctx := t.Context()

	// from flag.
	owner, name, err := resolveRepo(ctx, errRunner(), "octo/repo")
	require.NoError(t, err)
	assert.Equal(t, "octo", owner)
	assert.Equal(t, "repo", name)

	// from gh.
	r := fakeRunner{fn: func(_ string, _ []string) (string, error) { return "acme/widget\n", nil }}
	owner, name, err = resolveRepo(ctx, r, "")
	require.NoError(t, err)
	assert.Equal(t, "acme", owner)
	assert.Equal(t, "widget", name)

	// gh fails.
	_, _, err = resolveRepo(ctx, errRunner(), "")
	assert.Error(t, err)

	// malformed (no slash).
	_, _, err = resolveRepo(ctx, errRunner(), "noslash")
	assert.Error(t, err)

	// malformed (empty owner).
	_, _, err = resolveRepo(ctx, errRunner(), "/repo")
	assert.Error(t, err)
}

func TestResolvePR(t *testing.T) {
	ctx := t.Context()

	// from flag.
	n, err := resolvePR(ctx, errRunner(), 5)
	require.NoError(t, err)
	assert.Equal(t, 5, n)

	// autodetect success.
	r := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "feature\n", nil
		}

		return "42\n", nil
	}}
	n, err = resolvePR(ctx, r, 0)
	require.NoError(t, err)
	assert.Equal(t, 42, n)

	// git fails.
	gitErr := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "", errors.New("no git")
		}

		return "", nil
	}}
	_, err = resolvePR(ctx, gitErr, 0)
	assert.Error(t, err)

	// gh pr list fails.
	ghErr := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "feature\n", nil
		}

		return "", errors.New("no gh")
	}}
	_, err = resolvePR(ctx, ghErr, 0)
	assert.Error(t, err)

	// no PR for branch (empty output).
	empty := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "feature\n", nil
		}

		return "\n", nil
	}}
	_, err = resolvePR(ctx, empty, 0)
	assert.Error(t, err)

	// non-numeric PR.
	bad := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "feature\n", nil
		}

		return "abc\n", nil
	}}
	_, err = resolvePR(ctx, bad, 0)
	assert.Error(t, err)

	// S4: empty branch (detached HEAD) errors before calling gh pr list.
	detached := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "  \n", nil
		}

		return "", errors.New("gh pr list must not run with an empty branch")
	}}
	_, err = resolvePR(ctx, detached, 0)
	assert.Error(t, err)
}
