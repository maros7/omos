package gogate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// These tests drive the real go/golangci-lint toolchain against throwaway modules, so
// they are slow; skip under `go test -short`. Since gogate always runs the gate (which
// lints on a successful build), they need golangci-lint installed.

func requireE2E(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("e2e runs the real toolchain")
	}
	if _, err := exec.LookPath("golangci-lint"); err != nil {
		t.Skip("golangci-lint not installed")
	}
}

// writeModule creates a temp Go module from the given files (relative paths -> content)
// and returns its directory. A go.mod is added automatically.
func writeModule(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	files["go.mod"] = "module e2e\n\ngo 1.26\n"
	for name, body := range files {
		full := filepath.Join(dir, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o750))
		require.NoError(t, os.WriteFile(full, []byte(body), 0o600))
	}

	return dir
}

// e2eGate runs the gate against dir with the real toolchain. cfg.Dir is filled in.
func e2eGate(t *testing.T, dir string, cfg Config) Report {
	t.Helper()
	requireE2E(t)
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	t.Cleanup(cancel)
	cfg.Dir = dir

	return Run(ctx, execRunner{}, cfg)
}

func TestE2EGatePass(t *testing.T) {
	dir := writeModule(t, map[string]string{
		"add.go":      "package e2e\n\nfunc Add(a, b int) int { return a + b }\n",
		"add_test.go": "package e2e\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n",
	})
	rep := e2eGate(t, dir, Config{})

	assert.True(t, rep.OK)
	require.Len(t, rep.Steps, 3)
	assert.Equal(t, StatusPass, rep.Steps[0].Status) // build
	assert.Equal(t, StatusPass, rep.Steps[1].Status) // test
	assert.Equal(t, StatusPass, rep.Steps[2].Status) // lint
	require.NotNil(t, rep.Coverage)
}

func TestE2EScopedCoverage(t *testing.T) {
	// A -run-scoped test run: the injected coverprofile reflects only the matched test,
	// so gogate marks coverage as scoped and suppresses the per-function "uncovered"
	// breakdown, while the truthful total/per-package % stay.
	dir := writeModule(t, map[string]string{
		"calc.go": "package e2e\n\nfunc Add(a, b int) int { return a + b }\n\n" +
			"func Sub(a, b int) int { return a - b }\n",
		"calc_test.go": "package e2e\n\nimport \"testing\"\n\n" +
			"func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n",
	})
	rep := e2eGate(t, dir, Config{Command: []string{"go", "test", "-run=TestAdd", "./..."}})

	require.NotNil(t, rep.Coverage)
	assert.True(t, rep.Coverage.Scoped)
	assert.Empty(t, rep.Coverage.Uncovered)
	require.NotNil(t, rep.Coverage.TotalPct)
}

func TestE2EBuildFailShortCircuits(t *testing.T) {
	dir := writeModule(t, map[string]string{
		"bad.go": "package e2e\n\nfunc Bad() int { return notDefined }\n",
	})
	rep := e2eGate(t, dir, Config{})

	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 3)
	assert.Equal(t, StatusFail, rep.Steps[0].Status)
	require.NotEmpty(t, rep.Steps[0].Diagnostics)
	assert.Equal(t, "bad.go", filepath.Base(rep.Steps[0].Diagnostics[0].File))
	assert.Equal(t, StatusSkipped, rep.Steps[1].Status)
	assert.Equal(t, StatusSkipped, rep.Steps[2].Status)
}

func TestE2ETestFail(t *testing.T) {
	dir := writeModule(t, map[string]string{
		"x.go":      "package e2e\n\nfunc One() int { return 1 }\n",
		"x_test.go": "package e2e\n\nimport \"testing\"\n\nfunc TestOne(t *testing.T) {\n\tif One() != 2 {\n\t\tt.Fatal(\"boom\")\n\t}\n}\n",
	})
	rep := e2eGate(t, dir, Config{Command: []string{"go", "test", "./..."}})

	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 3)
	assert.Equal(t, StatusFail, rep.Steps[1].Status)
	assert.Equal(t, 1, rep.Steps[1].Tests.Failed)
	require.NotEmpty(t, rep.Steps[1].Diagnostics)
}

func TestE2ERerunFlaky(t *testing.T) {
	// Deterministically flaky: the test fails on its first run (creating a marker) and
	// passes once the marker exists, so -rerun-fails turns the run green and reports it as
	// flaky. The gate still builds and lints.
	dir := writeModule(t, map[string]string{
		"flaky_test.go": "package e2e\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\n" +
			"func TestFlaky(t *testing.T) {\n" +
			"\tif _, err := os.Stat(\"marker\"); err != nil {\n" +
			"\t\t_ = os.WriteFile(\"marker\", nil, 0o600)\n" +
			"\t\tt.Fatal(\"first run fails\")\n\t}\n}\n",
	})
	rep := e2eGate(t, dir, Config{Command: []string{"go", "test", "."}, RerunFails: 2})

	require.Len(t, rep.Steps, 3)
	assert.True(t, rep.OK)
	assert.Equal(t, []string{"TestFlaky"}, rep.Steps[1].Flaky)
}

func TestE2ELintFail(t *testing.T) {
	dir := writeModule(t, map[string]string{
		// os.Setenv's error is unchecked -> errcheck flags it. Pin the config to errcheck
		// only so the result does not depend on golangci-lint's defaults.
		"leak.go":       "package e2e\n\nimport \"os\"\n\nfunc Leak() { os.Setenv(\"A\", \"B\") }\n",
		".golangci.yml": "version: \"2\"\nlinters:\n  default: none\n  enable:\n    - errcheck\n",
	})
	rep := e2eGate(t, dir, Config{})

	assert.False(t, rep.OK)
	require.Len(t, rep.Steps, 3)
	require.Equal(t, StatusFail, rep.Steps[2].Status)
	require.NotEmpty(t, rep.Steps[2].Diagnostics)
	assert.Equal(t, "errcheck", rep.Steps[2].Diagnostics[0].Source)
}
