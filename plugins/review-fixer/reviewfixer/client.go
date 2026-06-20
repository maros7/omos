// Package reviewfixer handles GitHub PR review threads (from any reviewer) through
// direct GitHub REST and GraphQL HTTP calls and prints ultra-compact, token-minimized
// output. The whole point is that the AI agent never sees raw verbose API JSON: this
// code makes the calls and emits a handful of terse lines. The command in
// cmd/review-fixer is a thin wrapper around this package; all logic lives here so it can
// be tested on its own.
package reviewfixer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Client talks to the GitHub REST and GraphQL APIs. httpClient is injectable so tests
// can point it at an httptest server; apiBase is the REST/GraphQL root (the GraphQL
// endpoint is apiBase+"/graphql", REST lives under apiBase+"/repos/...").
type Client struct {
	httpClient *http.Client
	token      string
	apiBase    string
}

// newRequest builds a request carrying the standard GitHub headers. A non-nil body
// also sets Content-Type.
func (c *Client) newRequest(ctx context.Context, method, url string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-Github-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "review-fixer")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return req, nil
}

// graphQLRequest is the POST body for a GraphQL call.
type graphQLRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

// graphQL executes a GraphQL query and unmarshals the "data" field into out (out may be
// nil to ignore the data, e.g. for mutations). It returns an error for any non-2xx
// status, malformed JSON, or a non-empty "errors" array (using the first message).
func (c *Client) graphQL(ctx context.Context, query string, vars map[string]any, out any) error {
	reqBody, _ := json.Marshal(graphQLRequest{Query: query, Variables: vars}) //nolint:errchkjson // vars hold only strings/ints

	req, err := c.newRequest(ctx, http.MethodPost, c.apiBase+"/graphql", bytes.NewReader(reqBody))
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("graphql: status %d: %s", resp.StatusCode, snippet(data))
	}

	var env struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("graphql: decode: %w", err)
	}

	if len(env.Errors) > 0 {
		return fmt.Errorf("graphql: %s", env.Errors[0].Message)
	}

	if out != nil {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("graphql: decode data: %w", err)
		}
	}

	return nil
}

// post issues a REST POST with a JSON body, returning an error for any non-2xx status.
func (c *Client) post(ctx context.Context, url string, body any) error {
	reqBody, _ := json.Marshal(body) //nolint:errchkjson // body is a concrete string map

	req, err := c.newRequest(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, snippet(data))
	}

	return nil
}

// snippet returns a trimmed, length-capped view of a response body, safe to put in an
// error message without dumping the whole payload.
func snippet(b []byte) string {
	const maxLen = 200

	s := strings.TrimSpace(string(b))
	if len(s) > maxLen {
		return s[:maxLen]
	}

	return s
}
