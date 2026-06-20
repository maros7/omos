// Command review-fixer handles GitHub PR review threads (from any reviewer) via direct
// GitHub REST and GraphQL calls, printing ultra-compact, token-minimized output so an
// AI agent never has to read verbose API JSON. It is a thin wrapper around the
// reviewfixer package, which holds all logic and is tested independently.
package main

import (
	"os"

	"github.com/maros7/omos/plugins/review-fixer/reviewfixer"
)

func main() {
	os.Exit(reviewfixer.Main(os.Args[1:], os.Stdout, os.Stderr, os.Stdin))
}
