// Command gogate runs a Go quality gate (build, test, lint) in a single pass and
// prints a structured JSON report to stdout. It is a thin wrapper around the gogate
// package, which holds all logic and is tested independently.
package main

import (
	"os"

	"github.com/maros7/omos/plugins/gogate/gogate"
)

func main() {
	os.Exit(gogate.Main(os.Args[1:], os.Stdout, os.Stderr))
}
