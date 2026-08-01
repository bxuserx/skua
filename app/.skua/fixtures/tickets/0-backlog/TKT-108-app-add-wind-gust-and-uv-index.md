---
# Filed by hand — this ticket deliberately exercises exotic frontmatter.
# See skua plan step 0.3a: it is the round-trip corpus.
id: TKT-108
title: "Add wind gust and UV index to the current panel"
status: Todo
priority: Medium
assignee: Claude-Agent
created: 2026-07-30
domain: app
owner:
  name: bx
  team: weather-core
description: |
  Open-Meteo already returns wind_gusts_10m and uv_index under `current`.
  Add both to the metadata row, matching the existing Feels like / Humidity
  / Wind treatment.
next_step_hint: check the #42 rollout thread before shipping
review-status: pending
sample_path: "C:\\Users\\bx\\weather.csv"
tags:
  - api
  - ux
depends_on: []
blocks: []
related: [TKT-102]
files_touched: []
complexity: 2
---

### Objective

Surface wind gust and UV index alongside the existing current-conditions metadata.

### Context

`fetchForecast` in `src/weather.ts` already builds a `URLSearchParams` for the
`current` fields; adding two more is a one-line change there plus two rows in
`renderCurrent`.

### Acceptance criteria

- [ ] `current` request includes `wind_gusts_10m` and `uv_index`
- [ ] Both render in `.current-meta` with units
- [ ] `CurrentWeather` type extended; `bun run typecheck` clean
