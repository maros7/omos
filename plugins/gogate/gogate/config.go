package gogate

import "time"

// Step names used in the report.
const (
	StepBuild = "build"
	StepTest  = "test"
	StepVet   = "vet"
	StepLint  = "lint"
)

// Config controls a gate run.
type Config struct {
	Dir        string        // working directory the tools run in
	Command    []string      // a tool command to wrap (e.g. ["go","test","-run","X","./..."]); empty = full gate
	RerunFails int           // re-run failed tests this many times until they pass (0 = off; N = N reruns, per gotestsum's --rerun-fails-max)
	Timeout    time.Duration // overall deadline
}
