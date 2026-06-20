# Changelog

## [0.1.1](https://github.com/maros7/opencode-tripwire/compare/opencode-tripwire-v0.1.0...opencode-tripwire-v0.1.1) (2026-06-20)


### Bug Fixes

* count tool metrics in tool.execute.after so failed calls don't inflate budgets ([b434b6f](https://github.com/maros7/opencode-tripwire/commit/b434b6f147269eefd21eb2e82fb8bd1d1e5be562))
* handle escaped chars in JSONC string scanner ([8dc03ab](https://github.com/maros7/opencode-tripwire/commit/8dc03ab659e45eb63e298f0304724c19570475ac))
* honor onHard:"inject" by injecting the hard message ([89994a5](https://github.com/maros7/opencode-tripwire/commit/89994a5e16077937f01af448acf653f3a4787233))
* make evaluate() pure so warn nudges aren't dropped ([1344dc6](https://github.com/maros7/opencode-tripwire/commit/1344dc664b926258cd3f07a64f92b4e4969874b6))
* make JSONC trailing-comma stripping string-aware ([a781679](https://github.com/maros7/opencode-tripwire/commit/a781679479d7466e353c1be2bd5cf95f443c78e2))
* remove dead token metric and align docs ([14e5df2](https://github.com/maros7/opencode-tripwire/commit/14e5df238526ba2907f4b3c641d29eadda2887c6))
* track max per-file reads incrementally ([12328dc](https://github.com/maros7/opencode-tripwire/commit/12328dcf1298b0f48a887d3053f266a76f1b6fa8))
* treat a 0 budget tier as disabled in the counter line ([a564141](https://github.com/maros7/opencode-tripwire/commit/a564141162f1d9221c6a0e0eb8ca637d05349139))
* validate OPENCODE_TRIPWIRE_ON_HARD env value ([c9ac585](https://github.com/maros7/opencode-tripwire/commit/c9ac585709aafa2f3ad4ba1b859823f1b04aa72c))
