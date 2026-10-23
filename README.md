# omp-omarchy-theme

Keeps the [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) TUI theme derived
from the palette that feeds the terminal, instead of shipping a hand-picked
palette that drifts when the theme changes.

It is an omp extension: it writes `~/.omp/agent/themes/omp.json`, asks omp to
switch to it, and repaints a running session when the palette changes.

## Install

```bash
# from GitHub
omp plugin install github:numago/omp-omarchy-theme

# or as a marketplace source
omp plugin marketplace add numago/omp-omarchy-theme
omp plugin install omp-omarchy-theme@numago

# or from a local checkout
omp plugin install ~/path/to/omp-omarchy-theme
```

Then select the generated theme (or let the plugin do it — see *Adoption*):

```yaml
# ~/.omp/agent/config.yml
theme:
  dark: omp
  light: omp
```

## Palette source

| provider | source |
| --- | --- |
| `$OMP_TERMINAL_THEME_FILE` | a `colors.toml` or palette `.json` (escape hatch) |
| omarchy | `~/.local/state/omarchy/current/theme/colors.toml` |

One source, not one adapter per terminal. omarchy already writes the palette
every terminal on this machine reads, and its file is exact: for everforest it
matches `ghostty +show-config` after defaults, config and includes are resolved.
Supporting each emulator's own color query would add code without adding
accuracy.

The file reader accepts `key = "#rrggbb"`, `key #rrggbb`, `"key": "#rrggbb"` and
ghostty's `palette = N=#rrggbb`. `background`, `foreground`, `accent` and the
`red`/`green`/`yellow`/`blue`/`magenta`/`cyan` slots are required; aliases and
derived shades fall back to `omarchy-theme-color --file … --all` when installed.

Point `OMP_TERMINAL_THEME_FILE` at any file in that shape to use this away from
omarchy — no per-emulator code involved.

## What it derives

Surfaces use the same blends omarchy uses for its own themed configs:

| token | blend |
| --- | --- |
| `panel` | `mix(background, foreground, 6%)` |
| `panelAlt` | `mix(background, foreground, 10%)` |
| `panelPending` | `mix(background, accent, 12%)` |
| `panelSuccess` / `panelError` | `mix(background, green/red, 12%)` |
| `border` / `borderMuted` | `mix(background, foreground, 30%)` / `20%` |
| `selectedBackground` | `mix(background, accent, 22%)` |
| `mutedText` / `dimText` | `mix(foreground, background, 34%)` / `52%` |

Semantic accents map to the ANSI slots (`success` → green, `error` → red,
`warning` → yellow, `syntaxKeyword` → magenta, `syntaxFunction` → blue,
`mdCode` → cyan). `text`, `toolOutput`, `mdCodeBlock` and `statusLineBg` are left
empty so they resolve to the terminal's own foreground/background.

`mdCodeBlockBorder` maps to `mutedText` on purpose: fence labels such as
` ```rust ` are body-adjacent text, not decoration, and a border-level color
renders them unreadable on most dark palettes.

## Behavior

- Runs on `session_start`, main agent only; subagent sessions are ignored.
- Writes atomically, and skips the write when the palette has not changed.
- Watches the palette directories (300 ms debounce) and re-derives on change;
  the running TUI repaints through omp's theme watcher.
- **Adoption:** the plugin switches omp to the generated theme only when
  `theme.dark`/`theme.light` already names it, or when no theme was explicitly
  configured. A theme you picked by hand is left alone; the file is still
  refreshed.
- `/theme-sync` re-derives on demand and reports the palette path.

## Tern

[Tern](https://stencil.so/tern) consumes omp's *resolved* theme: every theme
token travels to a native surface as hex, and is re-sent when the resolved
palette changes. A Tern pane therefore follows the generated theme live,
including the switch triggered by a theme change. Tern is a consumer here, not a
palette source.

## Limits

- No OSC 4/10/11 queries: omp owns the tty's input loop while the TUI runs, and
  terminal replies are not delivered to extensions (`ctx.ui.onTerminalInput`
  sees keystrokes only, verified). A `queryTerminalColors()` host API would make
  every emulator work identically; until then the palette comes from a file.
- The generated theme file is refreshed while omp runs (or at the next session
  start), not by the terminal itself.

## Development

```bash
omp plugin install ~/path/to/omp-omarchy-theme   # link a checkout
omp -p "say ok" --no-tools                      # regenerates the theme file
omp gallery                                     # render surfaces with the active theme
```

## License

MIT
