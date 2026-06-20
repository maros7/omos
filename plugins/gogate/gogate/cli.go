package gogate

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"
)

// Main is the CLI entry point. It parses args, runs gogate using the real toolchain,
// and writes the JSON report to stdout. It returns a process exit code: 0 on success
// (including when the report shows problems — those live in the JSON), 2 on usage
// errors.
//
// With no positional args it runs the full gate (build → test → lint over ./...). Any
// positional args are taken as a tool command that scopes the gate, e.g.
// `gogate go test -run=TestX ./...`. Output is text by default; -format json renders the
// structured JSON report.
func Main(args []string, stdout, stderr io.Writer) int {
	return run(args, stdout, stderr, execRunner{})
}

// run is Main with an injectable Runner for testing.
func run(args []string, stdout, stderr io.Writer, r Runner) int {
	fs := flag.NewFlagSet("gogate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", ".", "working directory the tools run in")
	timeout := fs.Duration("timeout", 120*time.Second, "overall timeout")
	pretty := fs.Bool("pretty", false, "indent the JSON output for human reading")
	format := fs.String("format", "text", "output format: text or json")
	rerun := fs.Int("rerun-fails", 0, "re-run failed tests up to this many attempts until they pass (0 = off)")
	if err := fs.Parse(args); err != nil {
		// -h/-help is not a usage error: report success after printing the usage text.
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	if *format != "text" && *format != "json" {
		_, _ = fmt.Fprintf(stderr, "gogate: invalid -format %q: want text or json\n", *format)
		return 2
	}

	cfg := Config{
		Dir:        *dir,
		Command:    fs.Args(), // empty = full gate; otherwise a tool command that scopes it
		RerunFails: *rerun,
		Timeout:    *timeout,
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	rep := Run(ctx, r, cfg)

	_, _ = stdout.Write(render(rep, *format, *pretty))
	_, _ = io.WriteString(stdout, "\n")

	return 0
}

// render serializes the report as text (the default) or JSON.
func render(rep Report, format string, pretty bool) []byte {
	if format == "text" {
		return []byte(renderText(rep))
	}
	// Report marshals only finite float64 percentages, so encoding cannot fail.
	if pretty {
		b, _ := json.MarshalIndent(rep, "", "  ") //nolint:errchkjson // only finite floats
		return b
	}
	b, _ := json.Marshal(rep) //nolint:errchkjson // only finite floats

	return b
}
