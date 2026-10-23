/**
 * omp-omarchy-theme
 *
 * Derives omp's theme from the terminal's own palette so the TUI never drifts
 * from the theme it runs inside.
 *
 * Modes ($OMP_TERMINAL_THEME_MODE):
 *   auto (default) — exact palette when one is discoverable, else ANSI indices
 *   hex            — exact palette only; do nothing when none is discoverable
 *   indices        — always reference the terminal's own ANSI slots
 *
 * Exact-palette providers (first match wins):
 *   1. $OMP_TERMINAL_THEME_FILE  — colors.toml / palette JSON / key=#rrggbb text
 *   2. $OMP_TERMINAL_THEME_CMD   — any command whose stdout carries palette lines
 *   3. kitty                     — `kitten @ get-colors`
 *   4. ghostty                   — `ghostty +show-config` (effective palette)
 *   5. omarchy                   — ~/.local/state/omarchy/current/theme/colors.toml
 *
 * The palette is normalized to omp theme tokens (same surface blends omarchy
 * uses for its own themed configs) and written to <agentDir>/themes/omp.json.
 * omp's theme watcher repaints a running TUI when that file changes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getCurrentThemeName, setTheme } from "@oh-my-pi/pi-tui/theme/index";

const THEME_NAME = "omp";
const SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/theme-schema.json";
const DEBOUNCE_MS = 300;

const HOME = os.homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".omp", "agent");
const THEME_FILE = path.join(AGENT_DIR, "themes", `${THEME_NAME}.json`);
const OMARCHY_CURRENT = path.join(
	process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"),
	"omarchy",
	"current",
);
const OMARCHY_PALETTE = path.join(OMARCHY_CURRENT, "theme", "colors.toml");
const GHOSTTY_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "ghostty");

type Palette = Record<string, string>;
type RawPalette = Record<string, string>;
type Mode = "auto" | "hex" | "indices";
type ProviderKind = "file" | "command" | "kitty" | "ghostty" | "omarchy";
type PaletteSource = { palette: Palette; label: string; kind: ProviderKind };

/** Only the host surfaces this extension touches, so nothing is assumed beyond what it uses. */
interface SessionContext {
	mode?: "tui" | "rpc" | "json" | "print";
	agent?: { kind: "main" | "sub" };
	ui?: { notify?(message: string, level?: "info" | "success" | "warn" | "error"): void };
	setTimeout?(fn: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

function themeMode(): Mode {
	const raw = (process.env.OMP_TERMINAL_THEME_MODE ?? "auto").trim().toLowerCase();
	return raw === "hex" || raw === "indices" ? raw : "auto";
}

/* ------------------------------------------------------------------ colors */

function parseHex(value: string): [number, number, number] | undefined {
	const hex = value.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
	return `#${rgb.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

/** Blend `end` into `start` by `amount` (0..1), rounding half up like omarchy's renderer. */
function mix(start: string, end: string, amount: number): string {
	const a = parseHex(start);
	const b = parseHex(end);
	if (!a || !b) return start;
	return toHex(a.map((c, i) => Math.floor(c * (1 - amount) + b[i]! * amount + 0.5)));
}

/* ----------------------------------------------------------------- palette */

/**
 * Tolerant reader for the line formats terminals and theme managers emit:
 *   palette = 3=#459451     (ghostty)
 *   color4 #509475          (kitty)
 *   accent = "#509475"      (omarchy / TOML)
 *   "blue": "#509475"       (JSON, via the JSON branch)
 */
function parsePaletteText(text: string): RawPalette {
	const raw: RawPalette = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("//")) continue;

		const slot = /^palette\s*=\s*(\d+)\s*=\s*"?\s*#?([0-9a-fA-F]{6})"?$/.exec(line);
		if (slot) {
			raw[`palette${slot[1]}`] = `#${slot[2]!.toLowerCase()}`;
			continue;
		}

		const pair = /^["']?([A-Za-z0-9_]+)["']?\s*(?:=|:|\s)\s*["']?\s*#?([0-9a-fA-F]{6})["']?\s*,?$/.exec(line);
		if (pair) raw[pair[1]!.toLowerCase()] = `#${pair[2]!.toLowerCase()}`;
	}
	return raw;
}

function parsePaletteJson(text: string): RawPalette {
	const raw: RawPalette = {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "string" && parseHex(value)) raw[key.toLowerCase()] = value.toLowerCase();
		}
	} catch {
		// Malformed JSON: treat it as text below by the caller's own parsing.
	}
	return raw;
}

/** Map a raw palette (any provider's vocabulary) onto the tokens this theme needs. */
function semanticPalette(raw: RawPalette): Palette | undefined {
	const pick = (...keys: string[]) => keys.map(key => raw[key]).find(value => value && parseHex(value));
	const background = pick("background", "bg");
	const foreground = pick("foreground", "fg");
	const red = pick("red", "color1", "palette1");
	const green = pick("green", "color2", "palette2");
	const yellow = pick("yellow", "color3", "palette3");
	const blue = pick("blue", "color4", "palette4");
	const magenta = pick("magenta", "color5", "palette5");
	const cyan = pick("cyan", "color6", "palette6");
	if (!background || !foreground || !red || !green || !yellow || !blue || !magenta || !cyan) return undefined;
	return {
		background,
		foreground,
		accent: pick("accent") ?? blue,
		red,
		green,
		yellow,
		blue,
		magenta,
		cyan,
	};
}

function readPaletteFile(file: string): Palette | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const raw = file.endsWith(".json") ? { ...parsePaletteText(text), ...parsePaletteJson(text) } : parsePaletteText(text);
	const missing = !raw.background || !raw.foreground;
	// omarchy resolves aliases and derived shades for its own colors.toml.
	const viaOmarchy = missing ? parseWithOmarchyThemeColor(file) : undefined;
	return semanticPalette({ ...raw, ...viaOmarchy });
}

/**
 * omarchy-theme-color resolves color aliases (colorN, bright_*, derived shades)
 * exactly as omarchy itself does; prefer it for omarchy's colors.toml.
 */
function parseWithOmarchyThemeColor(file: string): RawPalette | undefined {
	const run = spawnSync("omarchy-theme-color", ["--file", file, "--all"], { encoding: "utf8", timeout: 5000 });
	if (run.error || run.status !== 0 || !run.stdout) return undefined;
	return parsePaletteText(run.stdout.replace(/\t/g, " "));
}

function runPaletteCommand(command: string): RawPalette | undefined {
	const run = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 5000 });
	if (run.error || run.status !== 0 || !run.stdout) return undefined;
	return parsePaletteText(run.stdout);
}

function providers(): PaletteSource[] {
	const sources: PaletteSource[] = [];

	const file = process.env.OMP_TERMINAL_THEME_FILE;
	if (file) {
		const palette = readPaletteFile(file);
		if (palette) sources.push({ palette, label: file, kind: "file" });
	}

	const command = process.env.OMP_TERMINAL_THEME_CMD;
	if (command) {
		const raw = runPaletteCommand(command);
		const palette = raw && semanticPalette(raw);
		if (palette) sources.push({ palette, label: `$OMP_TERMINAL_THEME_CMD (${command})`, kind: "command" });
	}

	if (process.env.KITTY_WINDOW_ID) {
		const raw = runPaletteCommand("kitten @ get-colors");
		const palette = raw && semanticPalette(raw);
		if (palette) sources.push({ palette, label: "kitten @ get-colors", kind: "kitty" });
	}

	// Inside a Tern pane the visible surface is Tern's, so ghostty's config is not it.
	if (process.env.TERM_PROGRAM !== "tern" && (process.env.GHOSTTY_RESOURCES_DIR || process.env.GHOSTTY_BIN_DIR)) {
		const raw = runPaletteCommand("ghostty +show-config");
		const palette = raw && semanticPalette(raw);
		if (palette) sources.push({ palette, label: "ghostty +show-config", kind: "ghostty" });
	}

	if (fs.existsSync(OMARCHY_PALETTE)) {
		const palette = readPaletteFile(OMARCHY_PALETTE);
		if (palette) sources.push({ palette, label: OMARCHY_PALETTE, kind: "omarchy" });
	}

	return sources;
}

/* ------------------------------------------------------------------- theme */

function need(palette: Palette, key: string): string {
	const value = palette[key];
	if (!value) throw new Error(`palette has no '${key}'`);
	return value;
}

function buildTheme(palette: Palette) {
	const background = need(palette, "background");
	const foreground = need(palette, "foreground");
	const accent = need(palette, "accent");
	const red = need(palette, "red");
	const green = need(palette, "green");
	const yellow = need(palette, "yellow");

	// Derived surfaces use the same blends as omarchy's own themed templates.
	const vars = {
		background,
		foreground,
		accent,
		selectedBackground: mix(background, accent, 0.22),
		color0: background,
		color1: red,
		color2: green,
		color3: yellow,
		color4: need(palette, "blue"),
		color5: need(palette, "magenta"),
		color6: need(palette, "cyan"),
		color7: foreground,
		panel: mix(background, foreground, 0.06),
		panelAlt: mix(background, foreground, 0.1),
		panelPending: mix(background, accent, 0.12),
		panelSuccess: mix(background, green, 0.12),
		panelError: mix(background, red, 0.12),
		border: mix(background, foreground, 0.3),
		borderMuted: mix(background, foreground, 0.2),
		mutedText: mix(foreground, background, 0.34),
		dimText: mix(foreground, background, 0.52),
	};

	return {
		$schema: SCHEMA_URL,
		name: THEME_NAME,
		vars,
		colors: {
			accent: "accent",
			border: "border",
			borderAccent: "accent",
			borderMuted: "border",
			success: "color2",
			error: "color1",
			warning: "color3",
			muted: "mutedText",
			dim: "dimText",
			text: "",
			thinkingText: "dimText",

			selectedBg: "selectedBackground",
			userMessageBg: "panel",
			userMessageText: "",
			customMessageBg: "panelAlt",
			customMessageText: "",
			customMessageLabel: "color5",
			toolPendingBg: "panelPending",
			toolSuccessBg: "panelSuccess",
			toolErrorBg: "panelError",
			toolTitle: "accent",
			toolOutput: "",

			mdHeading: "color5",
			mdLink: "accent",
			mdLinkUrl: "color6",
			mdCode: "color6",
			mdCodeBlock: "",
			mdCodeBlockBorder: "mutedText",
			mdQuote: "mutedText",
			mdQuoteBorder: "borderMuted",
			mdHr: "borderMuted",
			mdListBullet: "color5",

			toolDiffAdded: "color2",
			toolDiffRemoved: "color1",
			toolDiffContext: "mutedText",

			syntaxComment: "dimText",
			syntaxKeyword: "color5",
			syntaxFunction: "color4",
			syntaxVariable: "",
			syntaxString: "color2",
			syntaxNumber: "color3",
			syntaxType: "color4",
			syntaxOperator: "color5",
			syntaxPunctuation: "mutedText",

			thinkingOff: "borderMuted",
			thinkingMinimal: "mutedText",
			thinkingLow: "color4",
			thinkingMedium: "color5",
			thinkingHigh: "color3",
			thinkingXhigh: "color1",

			bashMode: "color3",
			pythonMode: "color3",

			statusLineBg: "",
			statusLineSep: "border",
			statusLineModel: "color5",
			statusLinePath: "",
			statusLineGitClean: "color2",
			statusLineGitDirty: "color3",
			statusLineContext: "color6",
			statusLineSpend: "color3",
			statusLineStaged: "color2",
			statusLineDirty: "color3",
			statusLineUntracked: "color1",
			statusLineOutput: "color4",
			statusLineCost: "color3",
			statusLineSubagents: "color5",
		},
		export: {
			pageBg: "background",
			cardBg: "panel",
			infoBg: "panelAlt",
		},
	};
}

/**
 * Emulator-agnostic theme: every token is an ANSI slot index, resolved by the
 * terminal itself. No palette is read, so it cannot drift — but surfaces cannot
 * be derived, and consumers that need hex (Tern's native surface, HTML export)
 * receive omp's fixed xterm values for those slots.
 */
function buildIndexTheme() {
	return {
		$schema: SCHEMA_URL,
		name: THEME_NAME,
		colors: {
			accent: 4,
			border: 8,
			borderAccent: 4,
			borderMuted: 8,
			success: 2,
			error: 1,
			warning: 3,
			muted: 8,
			dim: 8,
			text: "",
			thinkingText: 8,

			selectedBg: 8,
			userMessageBg: "",
			userMessageText: "",
			customMessageBg: "",
			customMessageText: "",
			customMessageLabel: 6,
			toolPendingBg: "",
			toolSuccessBg: "",
			toolErrorBg: "",
			toolTitle: 4,
			toolOutput: "",

			mdHeading: 5,
			mdLink: 4,
			mdLinkUrl: 6,
			mdCode: 6,
			mdCodeBlock: "",
			mdCodeBlockBorder: 7,
			mdQuote: 8,
			mdQuoteBorder: 8,
			mdHr: 8,
			mdListBullet: 6,

			toolDiffAdded: 2,
			toolDiffRemoved: 1,
			toolDiffContext: 8,

			syntaxComment: 8,
			syntaxKeyword: 5,
			syntaxFunction: 4,
			syntaxVariable: "",
			syntaxString: 2,
			syntaxNumber: 3,
			syntaxType: 6,
			syntaxOperator: 5,
			syntaxPunctuation: 8,

			thinkingOff: 8,
			thinkingMinimal: 8,
			thinkingLow: 4,
			thinkingMedium: 5,
			thinkingHigh: 3,
			thinkingXhigh: 1,

			bashMode: 2,
			pythonMode: 3,

			statusLineBg: "",
			statusLineSep: 8,
			statusLineModel: 5,
			statusLinePath: 7,
			statusLineGitClean: 2,
			statusLineGitDirty: 3,
			statusLineContext: 6,
			statusLineSpend: 3,
			statusLineStaged: 2,
			statusLineDirty: 3,
			statusLineUntracked: 1,
			statusLineOutput: 4,
			statusLineCost: 3,
			statusLineSubagents: 5,
		},
		export: {},
	};
}

type Resolved = { theme: object; label: string; watch: boolean };
type SyncResult = { status: "written" | "unchanged" | "skipped"; detail: string; watch: boolean };

function resolveTheme(): Resolved | undefined {
	const mode = themeMode();
	const sources = mode === "indices" ? [] : providers();
	const source = sources[0];
	if (source) {
		return {
			theme: buildTheme(source.palette),
			label: source.label,
			watch: source.kind === "file" || source.kind === "ghostty" || source.kind === "omarchy",
		};
	}
	if (mode === "hex") return undefined;
	return {
		theme: buildIndexTheme(),
		label: mode === "indices" ? "ANSI palette indices" : "ANSI palette indices (no exact palette source)",
		watch: false,
	};
}

function sync(): SyncResult {
	const resolved = resolveTheme();
	if (!resolved) {
		return { status: "skipped", detail: "no terminal palette found and mode=hex", watch: false };
	}

	const text = `${JSON.stringify(resolved.theme, null, 2)}\n`;
	const previous = fs.existsSync(THEME_FILE) ? fs.readFileSync(THEME_FILE, "utf8") : undefined;
	if (previous === text) return { status: "unchanged", detail: resolved.label, watch: resolved.watch };

	fs.mkdirSync(path.dirname(THEME_FILE), { recursive: true });
	const temp = `${THEME_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(temp, text);
	fs.renameSync(temp, THEME_FILE);
	return { status: "written", detail: resolved.label, watch: resolved.watch };
}

/* ---------------------------------------------------------------- watching */

function watchDirectories(): string[] {
	const dirs = new Set<string>([GHOSTTY_CONFIG_DIR, OMARCHY_CURRENT, path.join(OMARCHY_CURRENT, "theme")]);
	const file = process.env.OMP_TERMINAL_THEME_FILE;
	if (file) dirs.add(path.dirname(file));
	return [...dirs];
}

class PaletteWatcher {
	#watchers: fs.FSWatcher[] = [];
	#timer: unknown;
	#ctx: SessionContext;

	constructor(ctx: SessionContext) {
		this.#ctx = ctx;
	}

	start(): void {
		this.stop();
		for (const dir of watchDirectories()) {
			if (!fs.existsSync(dir)) continue;
			try {
				const watcher = fs.watch(dir, { persistent: false }, () => this.#schedule());
				watcher.on("error", () => {});
				this.#watchers.push(watcher);
			} catch {
				// A directory we cannot watch is not fatal; the next session retries.
			}
		}
	}

	stop(): void {
		if (this.#timer !== undefined) {
			try {
				this.#ctx.clearTimer?.(this.#timer);
			} catch {}
			this.#timer = undefined;
		}
		for (const watcher of this.#watchers) {
			try {
				watcher.close();
			} catch {}
		}
		this.#watchers = [];
	}

	#schedule(): void {
		if (this.#timer !== undefined) return;
		const arm = this.#ctx.setTimeout?.bind(this.#ctx) ?? setTimeout;
		this.#timer = arm(() => {
			this.#timer = undefined;
			try {
				if (sync().status !== "written") return;
				// The generated theme is the live one, so repaint from its new values.
				if (getCurrentThemeName() !== THEME_NAME) return;
				void setTheme(THEME_NAME, true);
			} catch (error) {
				this.#ctx.ui?.notify?.(`terminal theme: ${String(error)}`, "warn");
			}
		}, DEBOUNCE_MS);
	}
}

/* ------------------------------------------------------------------ plugin */

/** True when the generated theme is the operator's choice, or no theme was ever configured. */
function optIn(pi: ExtensionAPI): boolean {
	try {
		const slots = (["theme.dark", "theme.light"] as const).map(key => {
			const handle = lookup(key) as
				| { get(scope: unknown): unknown; provenance?(scope: unknown): string | undefined }
				| undefined;
			if (!handle) return undefined;
			return { value: handle.get(pi.pi.settings), provenance: handle.provenance?.(pi.pi.settings) };
		});
		return slots.some(slot => slot?.value === THEME_NAME || slot?.provenance === "default");
	} catch {
		// Settings unavailable (early load, exotic host): let the write stand, skip the switch.
		return false;
	}
}

export default function terminalTheme(pi: ExtensionAPI) {
	pi.setLabel("Terminal Theme");
	let watcher: PaletteWatcher | undefined;

	pi.on("session_start", async (_event: unknown, ctx: SessionContext) => {
		if (ctx.agent?.kind === "sub") return;

		let result: SyncResult;
		try {
			result = sync();
		} catch (error) {
			ctx.ui?.notify?.(`terminal theme: ${String(error)}`, "warn");
			return;
		}
		if (result.status === "skipped" || !optIn(pi)) return;

		if (getCurrentThemeName() !== THEME_NAME) {
			const applied = await setTheme(THEME_NAME, true);
			if (!applied.success) {
				ctx.ui?.notify?.(`terminal theme: ${applied.error ?? "theme switch failed"}`, "warn");
				return;
			}
		}

		if (ctx.mode === "tui" && result.watch) {
			watcher = new PaletteWatcher(ctx);
			watcher.start();
		}
	});

	pi.on("session_shutdown", () => {
		watcher?.stop();
		watcher = undefined;
	});

	pi.registerCommand("theme-sync", {
		description: "Re-derive the omp theme from the terminal palette",
		handler: async (_args: unknown, ctx: SessionContext) => {
			try {
				const result = sync();
				if (result.status === "skipped") {
					ctx.ui?.notify?.(`terminal theme: ${result.detail}`, "warn");
					return;
				}
				const applied = await setTheme(THEME_NAME, true);
				ctx.ui?.notify?.(
					applied.success
						? `terminal theme: ${result.status} from ${result.detail}`
						: `terminal theme: ${applied.error ?? "theme switch failed"}`,
					applied.success && result.status === "written" ? "success" : applied.success ? "info" : "error",
				);
			} catch (error) {
				ctx.ui?.notify?.(`terminal theme: ${String(error)}`, "error");
			}
		},
	});
}
