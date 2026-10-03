# Changelog

## [1.0.0] - 2026-10-03

First release of `dsh-global-rules` as its own repository.

### Added

- **A rule list injected into every request's system prompt** (section 100: after the deployment persona, before the
  tool notes), so the agent walks the rules before answering — and so compacting or trimming the conversation cannot
  drop them, which is what happens to instructions that travel as chat messages.
- **Three ways to edit the same data**: Settings → 全局规则 (order 55), the `global_rules` tool, and the `/rules`
  command. The settings page lists every rule with per-rule enable/disable, move up/down and delete, offers a
  one-line-per-rule text editor whose line numbers map onto those states, and previews the exact text the model
  receives.
- **Two switches**: the master switch (rules stay stored, injection stops) and 「回答里显示规则检查」, off by default —
  rules are still checked, but the answer carries no trace of it.
- **Storage** at `$DSH_HOME/dsh-global-rules/rules.json`, written by temp file + rename. Reads tolerate a broken entry
  (only that entry is dropped); writes refuse empty or oversized ones (2000 characters per rule, 200 rules).
- **A request fence** on the plugin's own HTTP route: cross-site fetches, non-loopback `Host` headers and foreign
  `Origin`s are refused, and an empty body is a `400` rather than a crash.
- **`test/host-smoke.mjs`** — 41 checks over the whole Host half (prompt section, `global_rules` tool, `/rules`
  command, the route the browser half uses, and the fence) against a temporary `DSH_HOME`, so a real rule file is
  never touched. CI runs it on six platforms.

### Notes

- The plugin guarantees **delivery, not compliance**: every enabled rule reaches every request, but whether the model
  follows it is the model's decision.
- Reasoning channels follow user rules in the system prompt noticeably less faithfully than answers do, and a
  session's accumulated reasoning language drags the rest along — **a new session is the main lever** for controlling
  reasoning language. The measurements, and the two stronger channels if that is not enough, are in the README.

[1.0.0]: https://github.com/IHS470/dsh-global-rules/releases/tag/v1.0.0
