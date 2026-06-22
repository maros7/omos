package gogate

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRunner returns canned results based on the command and args.
type fakeRunner struct {
	fn func(name string, args []string) Result
}

func (f fakeRunner) Run(_ context.Context, _, name string, args ...string) Result {
	return f.fn(name, args)
}

// gateRunner answers go build/test/lint for the full-gate tests.
func gateRunner() fakeRunner {
	return fakeRunner{fn: func(name string, args []string) Result {
		switch {
		case name == "go" && len(args) > 1 && args[0] == "tool" && args[1] == "cover":
			return Result{ExitCode: 0, Stdout: "total:\t(statements)\t90.0%\n"}
		case name == "go" && len(args) > 0 && args[0] == "test":
			return Result{ExitCode: 0, Stdout: `{"Action":"output","Package":"p","Output":"coverage: 90.0% of statements\n"}`}
		case name == "golangci-lint":
			return Result{ExitCode: 0, Stdout: `{"Issues":[]}`}
		default: // go build, etc.
			return Result{ExitCode: 0}
		}
	}}
}

func cfg() Config { return Config{Dir: ".", Timeout: time.Second} }

// --- cli.go ---

func TestRunCLIFlagError(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, 2, run([]string{"-nope"}, &out, &errb, gateRunner()))
}

func TestRunCLIHelpExitsZero(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, 0, run([]string{"-h"}, &out, &errb, gateRunner()))
}

func TestRunCLIInvalidFormat(t *testing.T) {
	var out, errb bytes.Buffer
	assert.Equal(t, 2, run([]string{"-format", "yaml"}, &out, &errb, gateRunner()))
	assert.Contains(t, errb.String(), "invalid -format")
}

func TestRunCLIGateText(t *testing.T) {
	// Default format is text.
	var out, errb bytes.Buffer
	require.Equal(t, 0, run(nil, &out, &errb, gateRunner()))
	s := out.String()
	assert.Contains(t, s, "gogate: OK")
	assert.Contains(t, s, "build")
	assert.NotContains(t, s, "{", "default text output is not JSON")
}

func TestRunCLICommandRunsGate(t *testing.T) {
	// A recognized command still runs the full gate (build, test, lint).
	var out, errb bytes.Buffer
	require.Equal(t, 0, run([]string{"-format", "json", "go", "test", "-run=X", "./..."}, &out, &errb, gateRunner()))

	var rep Report
	require.NoError(t, json.Unmarshal(out.Bytes(), &rep))
	require.Len(t, rep.Steps, 3)
	assert.Equal(t, StepTest, rep.Steps[1].Name)
	require.NotNil(t, rep.Coverage)
	assert.True(t, rep.Coverage.Scoped) // -run=X scopes the coverage report
}

func TestRunCLIJSONPretty(t *testing.T) {
	var out, errb bytes.Buffer
	require.Equal(t, 0, run([]string{"-format", "json", "-pretty"}, &out, &errb, gateRunner()))
	s := out.String()
	assert.Contains(t, s, "\n  ", "pretty JSON is indented")

	// compact JSON (no -pretty) has no indentation
	var out2, errb2 bytes.Buffer
	require.Equal(t, 0, run([]string{"-format", "json"}, &out2, &errb2, gateRunner()))
	assert.NotContains(t, out2.String(), "\n  ")
}

func TestMainUnrecognized(t *testing.T) {
	// Exercises Main (real execRunner wiring) without invoking the toolchain: an
	// unrecognized command never spawns a tool.
	var out, errb bytes.Buffer
	require.Equal(t, 0, Main([]string{"-format", "json", "frobnicate"}, &out, &errb))

	var rep Report
	require.NoError(t, json.Unmarshal(out.Bytes(), &rep))
	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 1)
	assert.Equal(t, StatusError, rep.Steps[0].Status)
}
