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
	RerunFails int           // max attempts to re-run failed tests (0/1 = no re-run)
	Timeout    time.Duration // overall deadline
}
