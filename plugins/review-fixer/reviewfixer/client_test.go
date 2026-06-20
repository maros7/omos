package reviewfixer

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// errRoundTripper makes every request fail at the transport layer.
type errRoundTripper struct{}

func (errRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("transport boom")
}

func newClient(server *httptest.Server) *Client {
	return &Client{httpClient: server.Client(), token: "tok", apiBase: server.URL}
}

func TestNewRequestError(t *testing.T) {
	c := &Client{httpClient: http.DefaultClient, token: "tok", apiBase: "x"}
	// An invalid method (contains a space) makes http.NewRequestWithContext fail.
	_, err := c.newRequest(t.Context(), "BAD METHOD", "http://x", nil)
	assert.Error(t, err)
}

func TestNewRequestHeaders(t *testing.T) {
	c := &Client{httpClient: http.DefaultClient, token: "tok", apiBase: "x"}
	req, err := c.newRequest(t.Context(), http.MethodPost, "http://x", strings.NewReader("{}"))
	require.NoError(t, err)
	assert.Equal(t, "Bearer tok", req.Header.Get("Authorization"))
	assert.Equal(t, "application/vnd.github+json", req.Header.Get("Accept"))
	assert.Equal(t, "2022-11-28", req.Header.Get("X-Github-Api-Version"))
	assert.Equal(t, "review-fixer", req.Header.Get("User-Agent"))
	assert.Equal(t, "application/json", req.Header.Get("Content-Type"))
}

func TestGraphQLSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/graphql", r.URL.Path)
		assert.Equal(t, http.MethodPost, r.Method)
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), "reviewThreads")
		_, _ = io.WriteString(w, `{"data":{"x":1}}`)
	}))
	defer srv.Close()

	var out struct {
		X int `json:"x"`
	}
	require.NoError(t, newClient(srv).graphQL(t.Context(), listThreadsQuery, nil, &out))
	assert.Equal(t, 1, out.X)
}

func TestGraphQLErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"errors":[{"message":"bad query"}]}`)
	}))
	defer srv.Close()

	err := newClient(srv).graphQL(t.Context(), "q", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "bad query")
}

func TestGraphQLNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "boom")
	}))
	defer srv.Close()

	err := newClient(srv).graphQL(t.Context(), "q", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "status 500")
}

func TestGraphQLMalformedEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "not json")
	}))
	defer srv.Close()

	err := newClient(srv).graphQL(t.Context(), "q", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode")
}

func TestGraphQLDataDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// data is an array but out is a struct -> unmarshal into out fails.
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	defer srv.Close()

	var out struct {
		X int `json:"x"`
	}
	err := newClient(srv).graphQL(t.Context(), "q", nil, &out)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode data")
}

func TestGraphQLTransportError(t *testing.T) {
	c := &Client{httpClient: &http.Client{Transport: errRoundTripper{}}, token: "t", apiBase: "http://x"}
	err := c.graphQL(t.Context(), "q", nil, nil)
	assert.Error(t, err)
}

func TestGraphQLRequestBuildError(t *testing.T) {
	// apiBase ":" produces an unparseable URL ":/graphql".
	c := &Client{httpClient: http.DefaultClient, token: "t", apiBase: ":"}
	err := c.graphQL(t.Context(), "q", nil, nil)
	assert.Error(t, err)
}

func TestListThreadsPagination(t *testing.T) {
	page := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if page == 0 {
			page++
			_, _ = io.WriteString(w, `{"data":{"repository":{"pullRequest":{"reviewThreads":{`+
				`"pageInfo":{"hasNextPage":true,"endCursor":"C1"},`+
				`"nodes":[{"id":"T1","isResolved":false,"comments":{"nodes":[`+
				`{"databaseId":11,"body":"first\nsecond","author":{"login":"Copilot"},"path":"a.go","line":3}]}}]}}}}}`)

			return
		}
		_, _ = io.WriteString(w, `{"data":{"repository":{"pullRequest":{"reviewThreads":{`+
			`"pageInfo":{"hasNextPage":false,"endCursor":""},`+
			`"nodes":[{"id":"T2","isResolved":true,"comments":{"nodes":[]}}]}}}}}`)
	}))
	defer srv.Close()

	threads, err := newClient(srv).listThreads(t.Context(), "o", "r", 1)
	require.NoError(t, err)
	require.Len(t, threads, 2)
	assert.Equal(t, "T1", threads[0].ID)
	assert.Equal(t, int64(11), threads[0].RootCommentID)
	assert.Equal(t, "a.go", threads[0].Path)
	assert.True(t, threads[1].IsResolved)
}

func TestListThreadsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	_, err := newClient(srv).listThreads(t.Context(), "o", "r", 1)
	assert.Error(t, err)
}

func TestReplyToComment(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/repos/o/r/pulls/2/comments/9/replies", r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"body":"hi"`)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	require.NoError(t, newClient(srv).replyToComment(t.Context(), "o", "r", 2, 9, "hi"))
}

func TestReplyToCommentNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "missing")
	}))
	defer srv.Close()

	err := newClient(srv).replyToComment(t.Context(), "o", "r", 2, 9, "hi")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "status 404")
}

func TestReplyToCommentTransportError(t *testing.T) {
	c := &Client{httpClient: &http.Client{Transport: errRoundTripper{}}, token: "t", apiBase: "http://x"}
	err := c.replyToComment(t.Context(), "o", "r", 2, 9, "hi")
	assert.Error(t, err)
}

func TestReplyToCommentRequestBuildError(t *testing.T) {
	c := &Client{httpClient: http.DefaultClient, token: "t", apiBase: ":"}
	err := c.replyToComment(t.Context(), "o", "r", 2, 9, "hi")
	assert.Error(t, err)
}

func TestResolveThread(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), "resolveReviewThread")
		_, _ = io.WriteString(w, `{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}`)
	}))
	defer srv.Close()

	require.NoError(t, newClient(srv).resolveThread(t.Context(), "T1"))
}

func TestResolveThreadError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"errors":[{"message":"nope"}]}`)
	}))
	defer srv.Close()

	err := newClient(srv).resolveThread(t.Context(), "T1")
	assert.Error(t, err)
}

func TestSnippet(t *testing.T) {
	assert.Equal(t, "abc", snippet([]byte("  abc  ")))
	long := strings.Repeat("x", 250)
	assert.Len(t, snippet([]byte(long)), 200)
}

func TestToThreadNoComments(t *testing.T) {
	tr := toThread(ghThread{ID: "T", IsResolved: true})
	assert.Equal(t, "T", tr.ID)
	assert.Zero(t, tr.RootCommentID)
	assert.Empty(t, tr.Path)
	assert.Zero(t, tr.Replies)
}

// TestToThreadFirstComment locks in originator semantics: a Copilot root with a human
// reply yields the ROOT's author/body/comment-id and a reply count of 1.
func TestToThreadFirstComment(t *testing.T) {
	var n ghThread
	n.ID = "PRRT_1"
	n.Comments.Nodes = append(n.Comments.Nodes, struct {
		DatabaseID int64  `json:"databaseId"`
		Body       string `json:"body"`
		Author     struct {
			Login string `json:"login"`
		} `json:"author"`
		Path string `json:"path"`
		Line int    `json:"line"`
	}{DatabaseID: 100, Body: "root body", Path: "x.go", Line: 7})
	n.Comments.Nodes[0].Author.Login = "Copilot"
	n.Comments.Nodes = append(n.Comments.Nodes, n.Comments.Nodes[0])
	n.Comments.Nodes[1].DatabaseID = 200
	n.Comments.Nodes[1].Body = "human reply"
	n.Comments.Nodes[1].Author.Login = "alice"

	tr := toThread(n)
	assert.Equal(t, int64(100), tr.RootCommentID)
	assert.Equal(t, "Copilot", tr.Author)
	assert.Equal(t, "root body", tr.Body)
	assert.Equal(t, 1, tr.Replies)
}
