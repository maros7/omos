package reviewfixer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// execTimeout bounds how long an exec'd git/gh helper may run before it is cancelled.
const execTimeout = 30 * time.Second

// runCmd runs an external command through r under a fresh timeout so a hung git/gh
// invocation cannot block the process forever.
func runCmd(ctx context.Context, r Runner, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, execTimeout)
	defer cancel()

	return r.Run(cctx, name, args...)
}

// resolveToken determines the GitHub token: the -token flag wins, then $GH_TOKEN, then
// $GITHUB_TOKEN, then `gh auth token`.
func resolveToken(ctx context.Context, r Runner, flagToken string) (string, error) {
	if flagToken != "" {
		return flagToken, nil
	}

	if t := os.Getenv("GH_TOKEN"); t != "" {
		return t, nil
	}

	if t := os.Getenv("GITHUB_TOKEN"); t != "" {
		return t, nil
	}

	out, err := runCmd(ctx, r, "gh", "auth", "token")
	if err != nil {
		return "", fmt.Errorf("resolve token: %w", err)
	}

	token := strings.TrimSpace(out)
	if token == "" {
		return "", errors.New("no GitHub token available (set -token, GH_TOKEN, GITHUB_TOKEN, or run `gh auth login`)")
	}

	return token, nil
}

// resolveRepo splits a repo into owner/name. When flagRepo is empty it falls back to
// `gh repo view`.
func resolveRepo(ctx context.Context, r Runner, flagRepo string) (owner, name string, err error) {
	spec := flagRepo
	if spec == "" {
		out, runErr := runCmd(ctx, r, "gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
		if runErr != nil {
			return "", "", fmt.Errorf("resolve repo: %w", runErr)
		}

		spec = strings.TrimSpace(out)
	}

	owner, name, ok := strings.Cut(spec, "/")
	if !ok || owner == "" || name == "" {
		return "", "", fmt.Errorf("invalid repo %q: want owner/name", spec)
	}

	return owner, name, nil
}

// resolvePR returns the PR number: the -pr flag wins; otherwise it finds the PR for the
// current git branch via `git branch --show-current` and `gh pr list`.
func resolvePR(ctx context.Context, r Runner, flagPR int) (int, error) {
	if flagPR != 0 {
		return flagPR, nil
	}

	branchOut, err := runCmd(ctx, r, "git", "branch", "--show-current")
	if err != nil {
		return 0, fmt.Errorf("resolve pr: %w", err)
	}

	branch := strings.TrimSpace(branchOut)
	if branch == "" {
		return 0, errors.New("resolve pr: not on a branch (detached HEAD?); pass -pr")
	}

	out, err := runCmd(ctx, r, "gh", "pr", "list", "--head", branch, "--json", "number", "-q", ".[0].number")
	if err != nil {
		return 0, fmt.Errorf("resolve pr: %w", err)
	}

	s := strings.TrimSpace(out)
	if s == "" {
		return 0, fmt.Errorf("resolve pr: no open PR found for branch %q", branch)
	}

	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("resolve pr: parse %q: %w", s, err)
	}

	return n, nil
}
