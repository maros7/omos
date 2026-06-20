package reviewfixer

import (
	"context"
	"fmt"
)

// Thread is a flattened review thread. All display/identity fields come from the FIRST
// (originator) comment: Author/Body identify who opened the thread and what they said,
// and RootCommentID is the reply target. Replies counts the additional comments after
// the originator.
type Thread struct {
	ID            string
	IsResolved    bool
	Path          string
	Line          int
	RootCommentID int64
	Author        string
	Body          string
	Replies       int
}

// listThreadsQuery pages a PR's review threads, 100 at a time, with the first 50
// comments per thread (the first node is the originator).
const listThreadsQuery = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){` +
	`repository(owner:$owner,name:$repo){pullRequest(number:$pr){` +
	`reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} ` +
	`nodes{id isResolved comments(first:50){nodes{databaseId body author{login} path line}}}}}}}`

// resolveThreadMutation marks a single review thread resolved.
const resolveThreadMutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`

// ghThread mirrors one reviewThreads node in the GraphQL response.
type ghThread struct {
	ID         string `json:"id"`
	IsResolved bool   `json:"isResolved"`
	Comments   struct {
		Nodes []struct {
			DatabaseID int64  `json:"databaseId"`
			Body       string `json:"body"`
			Author     struct {
				Login string `json:"login"`
			} `json:"author"`
			Path string `json:"path"`
			Line int    `json:"line"`
		} `json:"nodes"`
	} `json:"comments"`
}

// threadsData mirrors the GraphQL data payload for listThreadsQuery.
type threadsData struct {
	Repository struct {
		PullRequest struct {
			ReviewThreads struct {
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
				Nodes []ghThread `json:"nodes"`
			} `json:"reviewThreads"`
		} `json:"pullRequest"`
	} `json:"repository"`
}

// toThread flattens a GraphQL thread node onto its FIRST (originator) comment. The
// originator owns the thread's author, body, location, and reply target; trailing
// comments only bump the reply count.
func toThread(n ghThread) Thread {
	t := Thread{ID: n.ID, IsResolved: n.IsResolved}

	nodes := n.Comments.Nodes
	if len(nodes) > 0 {
		first := nodes[0]
		t.RootCommentID = first.DatabaseID
		t.Body = first.Body
		t.Author = first.Author.Login
		t.Path = first.Path
		t.Line = first.Line
		t.Replies = len(nodes) - 1
	}

	return t
}

// listThreads fetches every review thread on a PR, following pagination until the API
// reports no more pages.
func (c *Client) listThreads(ctx context.Context, owner, repo string, pr int) ([]Thread, error) {
	var (
		all   []Thread
		after *string
	)

	for {
		vars := map[string]any{"owner": owner, "repo": repo, "pr": pr, "after": after}

		var data threadsData
		if err := c.graphQL(ctx, listThreadsQuery, vars, &data); err != nil {
			return nil, err
		}

		rt := data.Repository.PullRequest.ReviewThreads
		for _, n := range rt.Nodes {
			all = append(all, toThread(n))
		}

		if !rt.PageInfo.HasNextPage {
			break
		}

		cursor := rt.PageInfo.EndCursor
		after = &cursor
	}

	return all, nil
}

// replyToComment posts a reply to a pull request review comment.
func (c *Client) replyToComment(ctx context.Context, owner, repo string, pr int, commentID int64, body string) error {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d/comments/%d/replies", c.apiBase, owner, repo, pr, commentID)
	if err := c.post(ctx, url, map[string]string{"body": body}); err != nil {
		return fmt.Errorf("reply: %w", err)
	}

	return nil
}

// resolveThread marks a review thread resolved.
func (c *Client) resolveThread(ctx context.Context, threadID string) error {
	vars := map[string]any{"id": threadID}
	if err := c.graphQL(ctx, resolveThreadMutation, vars, nil); err != nil {
		return fmt.Errorf("resolve: %w", err)
	}

	return nil
}
