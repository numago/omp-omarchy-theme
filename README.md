# omp-omarchy-theme

Keeps the [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) TUI theme derived
from your terminal's palette, instead of shipping a hand-picked palette that
drifts the moment you change terminal themes.

The package name is historical: nothing here requires omarchy, and the ghostty
adapter is optional. It is an omp extension that writes
`~/.omp/agent/themes/omp.json`, asks omp to switch to it, and repaints a running
session when the palette changes.

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

## Modes

`OMP_TERMINAL_THEME_MODE`:

| mode | behavior |
| --- | --- |
| `auto` (default) | exact palette when one is discoverable, otherwise the ANSI-index theme |
| `hex` | exact palette only; do nothing when none is discoverable |
| `indices` | always the ANSI-index theme — no palette is read at all |

The two theme shapes differ in what they can express:

- **Exact palette (hex)** — every token is a resolved color, so surfaces can be
  derived by blending (panels, borders, selection). This is what Tern's native
  surface and HTML export consume, since both need hex values.
- **ANSI indices** — every token is a slot number (`4`, `8`, …) that the terminal
  resolves against its own palette. Works in any emulator with zero discovery,
  and recolors automatically when the terminal theme changes. Costs the derived
  surfaces (they fall back to the terminal's default background), and hex
  consumers see omp's fixed xterm values for those slots — e.g. `accent: 4`
  becomes `#000080`, xterm's default blue, not your palette's blue. That is why
  `auto` prefers an exact palette when one exists.

## Where the colors come from

A theme manager does not paint the terminal — it writes the terminal's config,
and the terminal resolves it. For ghostty under omarchy:

```text
omarchy theme → ~/.local/state/omarchy/current/theme/ghostty.conf (included)
              → ghostty resolves defaults + config + includes
              → the palette the pane actually shows
```

Exact-palette providers, first match wins:

| provider | source |
| --- | --- |
| `$OMP_TERMINAL_THEME_FILE` | a `colors.toml`, palette `.json`, or `key = #rrggbb` text file |
| `$OMP_TERMINAL_THEME_CMD` | any command whose stdout prints palette lines |
| kitty | `kitten @ get-colors`, when `KITTY_WINDOW_ID` is set |
| ghostty | `ghostty +show-config` — effective config: defaults + user config + includes |
| omarchy | `current/theme/colors.toml`, aliases resolved via `omarchy-theme-color` |

Palette lines are read tolerantly, so these all work:

```text
palette = 4=#509475        # ghostty
color4 #509475             # kitty
blue = "#509475"           # omarchy / TOML
"blue": "#509475"          # JSON
```

Mapped to theme tokens: `background`/`foreground` from the terminal, `palette
1..6` → red/green/yellow/blue/magenta/cyan, `accent` = the palette's `accent` if
it has one, else blue.

Wire any other emulator with the command contract, e.g.:

```bash
# a theme manager that can dump its palette
export OMP_TERMINAL_THEME_CMD='wal --theme current --format json'
# a terminal with a color-query CLI
export OMP_TERMINAL_THEME_CMD='myterm colors --lines'
```

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
renders them unreadable on most dark palettes. The index theme uses ANSI 7 for
the same reason.

## Behavior

- Runs on `session_start`, main agent only; subagent sessions are ignored.
- Writes atomically, and skips the write when the palette has not changed.
- In exact-palette mode, watches the palette directories (300 ms debounce) and
  re-derives on change; the running TUI repaints through omp's theme watcher.
  The index theme needs no watching: the terminal recolors the slots itself.
- **Adoption:** the plugin switches omp to the generated theme only when
  `theme.dark`/`theme.light` already names it, or when no theme was explicitly
  configured. A theme you picked by hand is left alone; the file is still
  refreshed.
- `/theme-sync` re-derives on demand and reports which mode/provider supplied the
  palette.

## Tern

[Tern](https://stencil.so/tern) consumes omp's *resolved* theme: every theme
token travels to a native surface as hex, and is re-sent when the resolved
palette changes. An exact-palette theme therefore drives Tern's omp surface live.
Tern is not a palette source here — it is a consumer — and the ghostty adapter is
skipped inside a Tern pane, since Tern is the visible surface.

## Limits

- No OSC 4/10/11 queries. omp owns the tty's input loop while the TUI runs, and
  terminal replies are not delivered to extensions (`ctx.ui.onTerminalInput`
  sees keystrokes only, verified). A `queryTerminalColors()` host API would make
  every emulator work identically and retire this provider list.
- Discovery covers kitty and ghostty CLIs; everything else goes through
  `OMP_TERMINAL_THEME_FILE` / `OMP_TERMINAL_THEME_CMD`. Adding a provider is one
  function.
- Index mode is exact for ANSI rendering only; it is not a substitute for an
  exact palette when Tern-native rendering or HTML export matters.
- The generated theme file is refreshed while omp runs (or at the next session
  start), not by the terminal itself.

## Development

```bash
omp plugin install ~/path/to/omp-omarchy-theme   # link a checkout
omp -p "say ok" --no-tools                      # regenerates the theme file
OMP_TERMINAL_THEME_MODE=indices omp             # try the index theme
omp gallery                                     # render surfaces with the active theme
```

## License

MIT
