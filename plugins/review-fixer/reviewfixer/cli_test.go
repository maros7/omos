package reviewfixer

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// threadsPage is one GraphQL list response. Each thread's identity comes from its FIRST
// (originator) comment: T1 is a Copilot root with a human reply (Replies=1), T2 a human
// root, T3 a resolved Copilot root, T4 an unresolved bot root with no path.
const threadsPage = `{"data":{"repository":{"pullRequest":{"reviewThreads":{` +
	`"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[` +
	`{"id":"T1","isResolved":false,"comments":{"nodes":[` +
	`{"databaseId":11,"body":"fix\nthis","author":{"login":"Copilot"},"path":"a.go","line":3},` +
	`{"databaseId":12,"body":"thanks","author":{"login":"alice"},"path":"a.go","line":3}]}},` +
	`{"id":"T2","isResolved":false,"comments":{"nodes":[{"databaseId":22,"body":"x","author":{"login":"human"},"path":"b.go","line":0}]}},` +
	`{"id":"T3","isResolved":true,"comments":{"nodes":[{"databaseId":33,"body":"done","author":{"login":"Copilot"},"path":"c.go","line":1}]}},` +
	`{"id":"T4","isResolved":false,"comments":{"nodes":[{"databaseId":44,"body":"  \nhello","author":{"login":"copilot-bot"},"path":"","line":0}]}}` +
	`]}}}}}`

const resolvedOK = `{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}`

// listServer answers GraphQL list queries with threadsPage, resolve mutations with
// resolvedOK, and REST replies with 201.
func listServer(t *testing.T) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/graphql" {
			body, _ := readBody(r)
			if strings.Contains(body, "resolveReviewThread") {
				_, _ = w.Write([]byte(resolvedOK))

				return
			}
			_, _ = w.Write([]byte(threadsPage))

			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
}

func readBody(r *http.Request) (string, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(r.Body)

	return b.String(), err
}

// invoke runs review-fixer against srv with a fixed token+api-base prepended as leading
// globals, then the caller's args (which may add more leading globals before the
// subcommand). stdin feeds apply.
func invoke(srv *httptest.Server, stdin string, args ...string) (int, string, string) {
	full := append([]string{"-token", "tok", "-api-base", srv.URL}, args...)

	var out, errb bytes.Buffer
	code := run(full, &out, &errb, strings.NewReader(stdin), errRunner(), srv.Client())

	return code, out.String(), errb.String()
}

// --- run dispatch / global-flag-first parsing ---

func TestRunNoSubcommand(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"-format=text"}, &out, &errb, nil, errRunner(), http.DefaultClient))
	assert.Contains(t, errb.String(), "subcommands")
}

func TestRunHelp(t *testing.T) {
	for _, h := range []string{"-h", "-help", "--help"} {
		var out, errb bytes.Buffer
		assert.Equal(t, exitOK, run([]string{h}, &out, &errb, nil, errRunner(), http.DefaultClient))
	}
}

func TestRunInvalidFormat(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"-format", "yaml", "list"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitUsage, code)
	assert.Contains(t, errb.String(), "invalid -format")
}

func TestRunGlobalFlagParseError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"-nope"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestRunUnknownSubcommand(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"-format=text", "frobnicate"}, &out, &errb, nil, errRunner(), http.DefaultClient))
	assert.Contains(t, errb.String(), "unknown subcommand")
}

func TestMainUnknown(t *testing.T) {
	// Exercises Main's real wiring without any network call.
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, Main([]string{"nope"}, &out, &errb, strings.NewReader("")))
}

// TestGlobalsFirstArgvRegression is the B1 guard: the EXACT argv the TS plugin emits
// (globals before the subcommand) must dispatch, never "unknown subcommand".
func TestGlobalsFirstArgvRegression(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()

	cases := [][]string{
		{"-format=text", "list", "-pr", "5", "-repo", "o/r"},
		{"-format=text", "apply", "-pr", "5", "-repo", "o/r"},
		{"-format=text", "verify", "-pr", "5", "-repo", "o/r"},
	}
	for _, base := range cases {
		args := append([]string{"-token", "tok", "-api-base", srv.URL}, base...)

		var out, errb bytes.Buffer
		code := run(args, &out, &errb, strings.NewReader("[]"), errRunner(), srv.Client())
		assert.NotContains(t, errb.String(), "unknown subcommand", "argv %v", base)
		assert.NotEqual(t, exitUsage, code, "argv %v should dispatch", base)
	}
}

// TestMainApplyReadsStdin drives the REAL Main entry point (execRunner wiring) with the
// exact globals-first argv plus a JSON array on STDIN, proving apply reads its batch
// from stdin and not argv. -token/-repo/-pr keep it fully offline against httptest.
func TestMainApplyReadsStdin(t *testing.T) {
	replied := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/graphql" {
			if strings.Contains(mustBody(r), "resolveReviewThread") {
				_, _ = w.Write([]byte(resolvedOK))

				return
			}
			_, _ = w.Write([]byte(threadsPage))

			return
		}
		replied = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	args := []string{"-token", "tok", "-api-base", srv.URL, "-format=text", "apply", "-repo", "o/r", "-pr", "5"}
	stdin := strings.NewReader(`[{"threadId":"T1","body":"from stdin"}]`)

	var out, errb bytes.Buffer
	code := Main(args, &out, &errb, stdin)
	require.Equal(t, exitOK, code)
	assert.True(t, replied, "apply should POST a reply derived from the stdin batch")
	assert.Contains(t, out.String(), "ok T1")
}

// --- list ---

func TestListDefaultAllAuthors(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "list", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "PR #5 o/r: 3 unresolved thread(s)")
	assert.Contains(t, out, "[1] T1  a.go:3  (Copilot)  +1")
	assert.Contains(t, out, "fix")
	assert.Contains(t, out, "T2  b.go  (human)")
	assert.Contains(t, out, "T4  -  (copilot-bot)")
	assert.NotContains(t, out, "T3", "resolved thread excluded")
}

func TestListAuthorNarrowsByOriginator(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "list", "-repo", "o/r", "-pr", "5", "-author", "bot")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "1 unresolved thread(s)")
	assert.Contains(t, out, "T4")
	assert.NotContains(t, out, "T1")
}

func TestListJSON(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "-format", "json", "list", "-repo", "o/r", "-pr", "5", "-author", "copilot")
	require.Equal(t, exitOK, code)

	var items []listItem
	require.NoError(t, json.Unmarshal([]byte(out), &items))
	require.Len(t, items, 2)
	assert.Equal(t, "T1", items[0].ThreadID)
	assert.Equal(t, "Copilot", items[0].Author)
	assert.Equal(t, "fix\nthis", items[0].Body, "json carries full originator body")
}

func TestListFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"list", "-nope"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestListHelp(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitOK, run([]string{"list", "-h"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestListTokenError(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	var out, errb bytes.Buffer
	code := run([]string{"list", "-repo", "o/r", "-pr", "1"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitError, code)
}

func TestListRepoError(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, _, errb := invoke(srv, "", "list", "-pr", "1")
	assert.Equal(t, exitError, code)
	assert.Contains(t, errb, "resolve repo")
}

func TestListPRError(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, _, _ := invoke(srv, "", "list", "-repo", "o/r")
	assert.Equal(t, exitError, code)
}

func TestListAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, "", "list", "-repo", "o/r", "-pr", "1")
	assert.Equal(t, exitError, code)
}

func TestListPRAutodetect(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	r := fakeRunner{fn: func(name string, _ []string) (string, error) {
		if name == "git" {
			return "feature\n", nil
		}

		return "9\n", nil
	}}
	var out, errb bytes.Buffer
	code := run([]string{"-token", "t", "-api-base", srv.URL, "list", "-repo", "o/r"}, &out, &errb, nil, r, srv.Client())
	require.Equal(t, exitOK, code)
	assert.Contains(t, out.String(), "PR #9")
}

// --- verify ---

func TestVerifyHasUnresolved(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "verify", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitError, code)
	assert.Contains(t, out, "PR #5 o/r: 3 unresolved thread(s)")
}

func TestVerifyScopeSymmetry(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	// -author bot narrows to T4 only -> still unresolved -> exit 1, count 1.
	code, out, _ := invoke(srv, "", "verify", "-repo", "o/r", "-pr", "5", "-author", "bot")
	require.Equal(t, exitError, code)
	assert.Contains(t, out, "1 unresolved thread(s)")
}

func TestVerifyClean(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"repository":{"pullRequest":{"reviewThreads":{` +
			`"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[` +
			`{"id":"T3","isResolved":true,"comments":{"nodes":[]}}]}}}}}`))
	}))
	defer srv.Close()
	code, out, _ := invoke(srv, "", "verify", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "0 unresolved thread(s)")
}

func TestVerifyJSON(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "-format", "json", "verify", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitError, code)

	var res verifyResult
	require.NoError(t, json.Unmarshal([]byte(out), &res))
	assert.Equal(t, 3, res.Unresolved)
}

func TestVerifyFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"verify", "-nope"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestVerifyTokenError(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	var out, errb bytes.Buffer
	code := run([]string{"verify", "-repo", "o/r", "-pr", "1"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitError, code)
}

func TestVerifyAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, "", "verify", "-repo", "o/r", "-pr", "1")
	assert.Equal(t, exitError, code)
}

// --- reply (composability, not in tool schema) ---

func TestReply(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "reply", "-repo", "o/r", "-pr", "5", "-thread-id", "T1", "-body", "hi")
	require.Equal(t, exitOK, code)
	assert.Equal(t, "replied to T1.\n", out)
}

func TestReplyJSON(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "-format", "json", "reply", "-repo", "o/r", "-pr", "5", "-thread-id", "T1", "-body", "hi")
	require.Equal(t, exitOK, code)
	assert.JSONEq(t, `{"threadId":"T1"}`, out)
}

func TestReplyMissingArgs(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"-token", "t", "reply", "-thread-id", "T1"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitUsage, code)
	assert.Contains(t, errb.String(), "-thread-id and -body are required")
}

func TestReplyFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"reply", "-nope"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestReplyTokenError(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	var out, errb bytes.Buffer
	code := run([]string{"reply", "-thread-id", "T1", "-body", "x", "-repo", "o/r", "-pr", "1"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitError, code)
}

func TestReplyThreadNotFound(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, _, errb := invoke(srv, "", "reply", "-repo", "o/r", "-pr", "5", "-thread-id", "TZZZ", "-body", "hi")
	assert.Equal(t, exitError, code)
	assert.Contains(t, errb, "not found")
}

func TestReplyListError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, "", "reply", "-repo", "o/r", "-pr", "5", "-thread-id", "T1", "-body", "hi")
	assert.Equal(t, exitError, code)
}

func TestReplyAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/graphql" {
			_, _ = w.Write([]byte(threadsPage))

			return
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, "", "reply", "-repo", "o/r", "-pr", "5", "-thread-id", "T1", "-body", "hi")
	assert.Equal(t, exitError, code)
}

// --- resolve (composability, not in tool schema) ---

func TestResolve(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "resolve", "-thread-id", "T1")
	require.Equal(t, exitOK, code)
	assert.Equal(t, "resolved T1.\n", out)
}

func TestResolveJSON(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "", "-format", "json", "resolve", "-thread-id", "T1")
	require.Equal(t, exitOK, code)
	assert.JSONEq(t, `{"threadId":"T1"}`, out)
}

func TestResolveMissingThreadID(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"-token", "t", "resolve"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitUsage, code)
	assert.Contains(t, errb.String(), "-thread-id is required")
}

func TestResolveFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, exitUsage, run([]string{"resolve", "-nope"}, &out, &errb, nil, errRunner(), http.DefaultClient))
}

func TestResolveTokenError(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	var out, errb bytes.Buffer
	code := run([]string{"resolve", "-thread-id", "T1"}, &out, &errb, nil, errRunner(), http.DefaultClient)
	assert.Equal(t, exitError, code)
}

func TestResolveAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errors":[{"message":"no"}]}`))
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, "", "resolve", "-thread-id", "T1")
	assert.Equal(t, exitError, code)
}
