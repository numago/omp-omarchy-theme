# omp-omarchy-theme

Keeps the [omp](https://github.com/can1357/oh-my-pi) (oh-my-pi) TUI theme derived
from your terminal's palette, instead of shipping a hand-picked palette that
drifts the moment you change terminal themes.

It is an omp extension: it writes `~/.omp/agent/themes/omp.json`, asks omp to
switch to it, and watches the palette so a terminal theme switch repaints a
running session — no restart.

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

## Where the colors come from

A theme manager does not paint the terminal — it writes the terminal's config,
and the terminal resolves it. For ghostty under omarchy that chain is:

```text
omarchy theme → ~/.local/state/omarchy/current/theme/ghostty.conf (included)
              → ghostty resolves defaults + config + includes
              → the palette the pane actually shows
```

Reading only omarchy's `colors.toml` is one hop upstream: it misses local
terminal overrides, non-omarchy setups, and other terminals. So the plugin asks
the terminal first.

Providers, first match wins:

1. `$OMP_TERMINAL_THEME_FILE` — path to a `colors.toml` or a flat JSON object of
   `#rrggbb` colors. Explicit wins over everything.
2. **ghostty** — `ghostty +show-config`, i.e. the *effective* config after
   defaults, `~/.config/ghostty/config` and every `config-file` include. Works
   with or without omarchy, and picks up a manual `palette = …` override.
3. **omarchy** — `~/.local/state/omarchy/current/theme/colors.toml`.

Aliases (`colorN`, `bright_*`, derived shades) in provider 1/3 are resolved with
`omarchy-theme-color --file … --all` when that binary is on `PATH`; otherwise the
file is parsed in-process.

Terminal palette → token mapping for providers 2: `background`/`foreground` →
the terminal's own, `palette 1..6` → red/green/yellow/blue/magenta/cyan, and
`accent` = palette 4 (blue), the slot omarchy also uses for its accent.

The plugin reads a palette **file or the terminal's own config query**; it does
not send OSC color queries, because omp owns the tty's input loop while the TUI
runs. Any theme that leaves a palette file behind works through
`OMP_TERMINAL_THEME_FILE`.

## What it derives

Required palette keys: `background`, `foreground`, `accent`, `red`, `green`,
`yellow` (plus `blue`, `magenta`, `cyan`).

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
- Watches the palette directory (300 ms debounce) and re-derives on change; the
  running TUI repaints through omp's theme watcher.
- **Adoption:** the plugin switches omp to the generated theme only when
  `theme.dark`/`theme.light` already names it, or when no theme was explicitly
  configured. A theme you picked by hand is left alone; the file is still
  refreshed.
- `/theme-sync` re-derives on demand and reports the palette path.

## Tern

[Tern](https://stencil.so/tern) consumes omp's *resolved* theme: every theme
token travels to a native surface as hex, and is re-sent when the resolved
palette changes. So a Tern pane follows the generated theme live — including the
switch triggered by an omarchy theme change. Tern is not a palette source for
this plugin; it is a consumer of the theme this plugin produces.

## Limits

- Terminal-native discovery is ghostty-only today (`ghostty +show-config`). Other
  terminals work through `OMP_TERMINAL_THEME_FILE`; adding a provider is one
  function (kitty's `kitten @ get-colors`, wezterm, foot, …).
- No OSC 4/10/11 queries: omp owns the tty's input loop while the TUI runs, so an
  extension cannot safely read a terminal's reply. A `queryTerminalColors()` host
  API would make every terminal work identically.
- The generated theme file is refreshed while omp runs (or at the next session
  start), not by the terminal itself.
- Inside a Tern pane the ghostty provider is skipped (Tern is the visible
  surface); the omarchy/file providers still apply.

## Development

```bash
omp plugin install ~/path/to/omp-omarchy-theme   # link a checkout
omp -p "say ok" --no-tools                      # regenerates the theme file
```

`omp gallery` renders tool/composer/status surfaces with the active theme, which
is a quick way to eyeball a palette without starting a full session.

## License

MIT
