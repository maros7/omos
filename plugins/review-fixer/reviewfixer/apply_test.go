package reviewfixer

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// errReader fails on the first Read; used to drive the stdin read-error path.
type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read boom") }

// twoUnresolvedServer returns exactly two unresolved threads (T1 root cid 11, T2 root
// cid 22). Reply to cid 22 fails with 404; everything else succeeds. This drives the
// partial-failure path with a clean unresolvedAtStart of 2.
func twoUnresolvedServer(t *testing.T) *httptest.Server {
	t.Helper()
	const page = `{"data":{"repository":{"pullRequest":{"reviewThreads":{` +
		`"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[` +
		`{"id":"T1","isResolved":false,"comments":{"nodes":[{"databaseId":11,"body":"a","author":{"login":"Copilot"},"path":"a.go","line":1}]}},` +
		`{"id":"T2","isResolved":false,"comments":{"nodes":[{"databaseId":22,"body":"b","author":{"login":"Copilot"},"path":"b.go","line":2}]}}` +
		`]}}}}}`

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/graphql":
			body := mustBody(r)
			if strings.Contains(body, "resolveReviewThread") {
				_, _ = w.Write([]byte(resolvedOK))

				return
			}
			_, _ = w.Write([]byte(page))
		case strings.Contains(r.URL.Path, "/comments/22/"):
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusCreated)
		}
	}))
}

func mustBody(r *http.Request) string {
	s, _ := readBody(r)

	return s
}

func TestApplyEmptyStdin(t *testing.T) {
	// Empty array is a no-op: exit 0, no network (errRunner would fail if reached).
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, "[]", "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "applied 0/0")
}

func TestApplyMalformedStdin(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, _, errb := invoke(srv, "{not json", "apply", "-repo", "o/r", "-pr", "5")
	assert.Equal(t, exitUsage, code)
	assert.Contains(t, errb, "invalid stdin JSON")
}

func TestApplyStdinReadError(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	full := []string{"-token", "tok", "-api-base", srv.URL, "apply", "-repo", "o/r", "-pr", "5"}

	var out, errb bytes.Buffer
	code := run(full, &out, &errb, errReader{}, errRunner(), srv.Client())
	assert.Equal(t, exitError, code)
	assert.Contains(t, errb.String(), "read stdin")
}

func TestApplySuccess(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	stdin := `[{"threadId":"T1","body":"done one"},{"threadId":"T4","body":"done four"}]`
	code, out, _ := invoke(srv, stdin, "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "ok T1")
	assert.Contains(t, out, "ok T4")
	assert.Contains(t, out, "applied 2/2; remaining unresolved: 1")
}

func TestApplyJSON(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	stdin := `[{"threadId":"T1","body":"x"}]`
	code, out, _ := invoke(srv, stdin, "-format", "json", "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, `"applied":1`)
	assert.Contains(t, out, `"requested":1`)
	assert.Contains(t, out, `"reply":"ok"`)
}

func TestApplyAlreadyResolvedSkips(t *testing.T) {
	// T3 is resolved in the list; applying it must skip with NO reply call.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/graphql" {
			_, _ = w.Write([]byte(threadsPage))

			return
		}
		t.Errorf("reply must not be called for an already-resolved thread (path %s)", r.URL.Path)
	}))
	defer srv.Close()
	code, out, _ := invoke(srv, `[{"threadId":"T3","body":"x"}]`, "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitOK, code)
	assert.Contains(t, out, "skip T3 (already resolved)")
	assert.Contains(t, out, "applied 0/1")
}

func TestApplyUnknownThreadFails(t *testing.T) {
	srv := listServer(t)
	defer srv.Close()
	code, out, _ := invoke(srv, `[{"threadId":"TZZZ","body":"x"}]`, "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitError, code)
	assert.Contains(t, out, "skip TZZZ (unknown thread)")
}

func TestApplyPartialFailure(t *testing.T) {
	srv := twoUnresolvedServer(t)
	defer srv.Close()
	stdin := `[{"threadId":"T1","body":"ok"},{"threadId":"T2","body":"boom"}]`
	code, out, _ := invoke(srv, stdin, "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitError, code)
	assert.Contains(t, out, "ok T1")
	assert.Contains(t, out, "reply-fail T2: reply: status 404")
	assert.Contains(t, out, "applied 1/2; remaining unresolved: 1")
}

func TestApplyResolveFailure(t *testing.T) {
	// Reply 201 but resolve mutation errors -> resolve-fail, exit 1.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/graphql" {
			if strings.Contains(mustBody(r), "resolveReviewThread") {
				_, _ = w.Write([]byte(`{"errors":[{"message":"no"}]}`))

				return
			}
			_, _ = w.Write([]byte(threadsPage))

			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	code, out, _ := invoke(srv, `[{"threadId":"T1","body":"x"}]`, "apply", "-repo", "o/r", "-pr", "5")
	require.Equal(t, exitError, code)
	assert.Contains(t, out, "resolve-fail T1")
}

func TestApplyFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	code := run([]string{"apply", "-nope"}, &out, &errb, strings.NewReader("[]"), errRunner(), http.DefaultClient)
	assert.Equal(t, exitUsage, code)
}

func TestApplyTokenError(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	var out, errb bytes.Buffer
	code := run([]string{"apply", "-repo", "o/r", "-pr", "1"}, &out, &errb, strings.NewReader(`[{"threadId":"T1","body":"x"}]`), errRunner(), http.DefaultClient)
	assert.Equal(t, exitError, code)
}

func TestApplyListError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	code, _, _ := invoke(srv, `[{"threadId":"T1","body":"x"}]`, "apply", "-repo", "o/r", "-pr", "5")
	assert.Equal(t, exitError, code)
}
