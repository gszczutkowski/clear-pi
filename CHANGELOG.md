# Changelog

## [2.0.0]

### Breaking changes

- Replace the legacy `/clear-pi-progress` and `/clear-pi` commands with `/clear-progress`. Old names show a local migration notice instead of executing the previous action.
- Use `/clear-progress full` for the detailed report previously opened by `expand`; `expand` now opens the summary overlay.
- Require Node.js 24 or later for the distributed package.

### Features and fixes

- Rework the Main Agent dashboard into Solo, Agents and Coordinated views with compact summaries, scrollable overlays and portable HTML export.
- Distinguish formal task acceptance, report delivery and reported outcomes, including reviewer verdicts and saved runtime metadata.
- Improve snapshot scoping, bounded evidence traversal, watchers and refresh behavior.
- Add configurable progress/transcript icons, collapsible skill/help cards and shortened extension labels.
- Refine transcript grouping, expansion state, rendering caches and quota window labels.
- Add strict typechecking, expanded tests and rendering benchmarks.

### Releases and contributor workflow

- Build versioned Pi packages and publish GitHub Releases from the exact merged commit without writing to protected main.
- Require a reviewed SemVer bump and changelog entry in every PR, validated by CI.
- Document contributor versioning rules and protected-branch release configuration in AGENTS.md and README.md.

## [1.0.0]

- Initial versioned Pi extension: transcript frames, collapsible tool calls, progress dashboard and custom footer.
