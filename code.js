"use strict";
// ── Text Blocks — Figma Plugin ─────────────────────────────────────────
// Headless plugin: no UI. Converts all text nodes in the selected frame to
// rounded rectangle skeleton representations.
//
// Usage: Select a frame, group, component, or instance, then run the plugin.
// Each text node is replaced with a rounded rectangle (or a set of rectangles
// in a vertical auto-layout frame for multi-line text) that matches the text's
// fill color at 40% opacity.
//
// If the plugin fails mid-operation, press Cmd+Z (Mac) / Ctrl+Z (Windows) to
// undo all partial changes — all plugin changes are a single undo step.
// ── Constants ──────────────────────────────────────────────────────────────
const FALLBACK_FONT_SIZE = 16;
const FALLBACK_FILL = {
    type: "SOLID",
    color: { r: 0.2, g: 0.2, b: 0.2 },
    opacity: 1,
};
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
    opacity: 0.4,
    cornerRadius: 10,
    skipPrefix: "",
};
// Loaded once at startup; mutated by loadSettings() before any processing.
let settings = Object.assign({}, DEFAULT_SETTINGS);
// Tracks fonts loaded during this plugin run to avoid redundant loadFontAsync calls.
// Figma caches loaded fonts internally but still incurs async overhead per call.
const loadedFonts = new Set();
// Timestamp of the last macrotask yield; reset at the start of each conversion run.
// Used by yieldToUI() to throttle yields so the spinner stays alive without
// adding a setTimeout pause after every single node.
let lastYieldTime = 0;
async function loadSettings() {
    const stored = await figma.clientStorage.getAsync(SETTINGS_KEY);
    // Spread stored values over defaults so added keys in future versions are backfilled.
    return stored ? Object.assign(Object.assign({}, DEFAULT_SETTINGS), stored) : Object.assign({}, DEFAULT_SETTINGS);
}
// Tracks the name of the node currently being processed for error reporting.
let currentNodeName = "(unknown)";
// ── Property helpers ───────────────────────────────────────────────────────
function getEffectiveFontSize(node) {
    const fs = node.fontSize;
    if (typeof fs === "number")
        return fs;
    // Mixed font sizes — use the size of the first character
    const rangeFs = node.getRangeFontSize(0, 1);
    if (typeof rangeFs === "number")
        return rangeFs;
    return FALLBACK_FONT_SIZE;
}
function getEffectiveLineHeight(node) {
    const fontSize = getEffectiveFontSize(node);
    const lh = node.lineHeight;
    // figma.mixed is a unique symbol; symbols are not objects
    if (typeof lh !== "object" || lh === null)
        return fontSize * 1.2;
    if (lh.unit === "AUTO")
        return fontSize * 1.2;
    if (lh.unit === "PIXELS")
        return lh.value;
    // PERCENT
    return (fontSize * lh.value) / 100;
}
function getTextFills(node) {
    const fills = node.fills;
    // figma.mixed is a symbol; a symbol is not an array
    if (Array.isArray(fills) && fills.length > 0) {
        return fills;
    }
    return [FALLBACK_FILL];
}
// Returns the width of the actual rendered text content, using absoluteRenderBounds
// (the tight pixel bounding box) rather than the container box (absoluteBoundingBox).
// This handles cases where text doesn't fill its container width.
function getContentWidth(node) {
    const renderBounds = node.absoluteRenderBounds;
    if (!renderBounds || renderBounds.width <= 0)
        return node.width;
    // Clamp to node.width in case of subpixel rounding differences
    return Math.min(renderBounds.width, node.width);
}
// Returns the horizontal offset from the text node's left edge to the render bounds'
// left edge. Non-zero for CENTER-aligned (positive) and RIGHT-aligned (larger positive)
// text that doesn't fill its container.
function getContentXOffset(node) {
    const renderBounds = node.absoluteRenderBounds;
    const bboxBounds = node.absoluteBoundingBox;
    if (!renderBounds || !bboxBounds)
        return 0;
    return renderBounds.x - bboxBounds.x;
}
// Maps textAlignHorizontal to the counterAxisAlignItems value for the wrapper frame,
// so stacked line-rects are aligned the same way as the original text.
function getCounterAxisAlign(node) {
    switch (node.textAlignHorizontal) {
        case "CENTER":
            return "CENTER";
        case "RIGHT":
            return "MAX";
        default:
            return "MIN"; // LEFT or JUSTIFIED
    }
}
// Returns paragraph spacing in pixels (the extra gap Figma adds after each \n-delimited
// paragraph). Returns 0 for mixed or unset values.
function getParagraphSpacing(node) {
    const ps = node.paragraphSpacing;
    if (typeof ps === "number")
        return Math.max(0, ps);
    return 0; // figma.mixed
}
// Returns the first concrete FontName from the text node, falling back to Inter Regular.
function getFirstFontName(node) {
    const fn = node.fontName;
    if (typeof fn !== "symbol")
        return fn;
    if (node.characters.length > 0) {
        const rangeFn = node.getRangeFontName(0, 1);
        if (typeof rangeFn !== "symbol")
            return rangeFn;
    }
    return { family: "Inter", style: "Regular" };
}
// Loads all fonts referenced in the text node, plus the font we'll use on the
// temporary measurement node, so all subsequent character assignments succeed.
async function loadFontsForTextNode(node) {
    const primaryFont = getFirstFontName(node);
    const seen = new Set([`${primaryFont.family}::${primaryFont.style}`]);
    const toLoad = [primaryFont];
    for (const seg of node.getStyledTextSegments(["fontName"])) {
        const fn = seg.fontName;
        if (typeof fn === "symbol")
            continue;
        const key = `${fn.family}::${fn.style}`;
        if (!seen.has(key)) {
            seen.add(key);
            toLoad.push(fn);
        }
    }
    // Filter out fonts already loaded in this run to avoid redundant async calls.
    const uncached = toLoad.filter((fn) => {
        const key = `${fn.family}::${fn.style}`;
        if (loadedFonts.has(key))
            return false;
        loadedFonts.add(key);
        return true;
    });
    if (uncached.length > 0) {
        await Promise.all(uncached.map((fn) => figma.loadFontAsync(fn)));
    }
}
// ── Per-line width measurement ─────────────────────────────────────────────
// Simulates Figma's word-wrap for `text` within `maxWidth`, using a pre-configured
// temporary text node (`temp`) in WIDTH_AND_HEIGHT mode for measurement.
// Returns an array of widths — one per visual line — matching how Figma would
// render the text at that container width.
//
// Limitation: splits on whitespace, so CJK or hyphenated text may not match
// Figma's exact break points, but it's a good approximation for Western text.
function simulateWordWrap(text, maxWidth, temp) {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0)
        return [0];
    const lineWidths = [];
    let currentLine = "";
    for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        temp.characters = candidate;
        if (temp.width > maxWidth && currentLine.length > 0) {
            // This word tips the line over maxWidth — flush the current line
            temp.characters = currentLine;
            lineWidths.push(Math.min(temp.width, maxWidth));
            currentLine = word;
        }
        else {
            // Word fits (or it's the only word and it's wider than maxWidth — no choice)
            currentLine = candidate;
        }
    }
    // Flush the last (usually shortest) line
    if (currentLine) {
        temp.characters = currentLine;
        lineWidths.push(Math.min(temp.width, maxWidth));
    }
    return lineWidths;
}
// Returns per-segment, per-line widths for the text node.
//
// Figma stores two kinds of newline in node.characters:
//   \n              — hard return (Enter): new paragraph; paragraphSpacing applies.
//   \u2028 / \u000B — soft return (Shift+Enter): line break within the same paragraph;
//                     only normal lineSpacing applies, no paragraphSpacing.
//                     Figma uses U+2028 (Unicode LINE SEPARATOR) in practice.
//
// The outer array has one entry per \n-paragraph. Within each paragraph, soft-return
// lines are additional widths in the same inner array — they share the paragraph's
// segment frame and get lineSpacing between them, not paragraphSpacing.
//
// `wrapWidth` must be node.width — the container boundary where Figma breaks
// lines. Do NOT pass absoluteRenderBounds.width here: that is the width of the
// widest rendered line, which is narrower than the container for wrapped text,
// and would cause the simulation to produce too many lines.
//
// Algorithm:
//  1. Load all fonts referenced in the node.
//  2. Create one reusable temp text node (hidden, WIDTH_AND_HEIGHT mode).
//  3. For each \n-paragraph:
//     a. Split again on \u2028 (soft returns) to get individual lines.
//     b. For each line: empty → 0, fits → measured width, wraps → word-break simulation.
//     c. Collect all line widths into one inner array for this paragraph.
//  4. Remove the temp node (in a finally block).
// `sharedTemp` may be passed in from the caller to avoid per-node create/destroy overhead.
// If omitted, a local temp node is created and cleaned up within this call.
async function measureLineWidths(node, wrapWidth, sharedTemp) {
    await loadFontsForTextNode(node);
    const ownTemp = sharedTemp === undefined;
    const temp = ownTemp ? figma.createText() : sharedTemp;
    if (ownTemp)
        temp.visible = false;
    try {
        temp.fontName = getFirstFontName(node);
        temp.fontSize = getEffectiveFontSize(node);
        // Copy letter spacing so width measurements account for tracking
        const ls = node.letterSpacing;
        if (typeof ls === "object" && ls !== null) {
            temp.letterSpacing = ls;
        }
        // Copy text case — affects visual width (e.g. ALL_CAPS widens characters)
        const tc = node.textCase;
        if (typeof tc === "string") {
            temp.textCase = tc;
        }
        temp.textAutoResize = "WIDTH_AND_HEIGHT";
        const segments = [];
        for (const paragraph of node.characters.split("\n")) {
            // Split each \n-paragraph on soft-return characters to get individual lines.
            // Figma uses U+2028 (LINE SEPARATOR) for soft returns; \u000B is kept as
            // a fallback in case it appears in older files.
            const softLines = paragraph.split(/\u2028|\u000B/);
            const segmentWidths = [];
            for (const line of softLines) {
                if (line.trim().length === 0) {
                    // Blank line (empty paragraph or empty soft-return line) — placeholder
                    segmentWidths.push(0);
                    continue;
                }
                // Measure the line's natural (no-wrap) width
                temp.characters = line;
                if (temp.width <= wrapWidth) {
                    segmentWidths.push(temp.width);
                }
                else {
                    // Line wraps — simulate word-breaking at the container boundary
                    segmentWidths.push(...simulateWordWrap(line, wrapWidth, temp));
                }
            }
            segments.push(segmentWidths);
        }
        return segments;
    }
    finally {
        if (ownTemp)
            temp.remove();
    }
}
// ── Shape builders ─────────────────────────────────────────────────────────
function createLineRect(width, height, fills) {
    const rect = figma.createRectangle();
    rect.resize(Math.max(1, width), Math.max(1, height));
    rect.fills = [...fills];
    rect.cornerRadius = settings.cornerRadius;
    rect.opacity = settings.opacity;
    return rect;
}
// Builds a vertical auto-layout frame representing one paragraph/segment.
//
// Key: paddingBottom = lineSpacing so that the frame's total HUG height equals
// lineCount × effectiveLH, not lineCount × fontSize + (lineCount-1) × lineSpacing.
// Without this padding the frame is one `lineSpacing` shorter than expected because
// itemSpacing only adds leading BETWEEN lines, not after the last one.
//
//   height = paddingTop(0) + N×fontSize + (N-1)×lineSpacing + paddingBottom(lineSpacing)
//          = N×fontSize + N×lineSpacing
//          = N × effectiveLH  ✓
function buildSegmentFrame(lineWidths, maxWidth, blockHeight, lineSpacing, fills, align) {
    const frame = figma.createFrame();
    frame.layoutMode = "VERTICAL";
    frame.counterAxisSizingMode = "FIXED";
    frame.counterAxisAlignItems = align;
    // resize() before primaryAxisSizingMode = AUTO — resize() implicitly resets
    // primary axis to FIXED, so AUTO must be set after children are appended.
    frame.resize(Math.max(1, maxWidth), 1);
    frame.itemSpacing = lineSpacing;
    frame.paddingTop = 0;
    frame.paddingBottom = lineSpacing; // trailing leading — fixes collapsed height
    frame.paddingLeft = 0;
    frame.paddingRight = 0;
    frame.fills = [];
    frame.clipsContent = false;
    for (const lineWidth of lineWidths) {
        // Clamp: simulation runs at node.width so a line could theoretically exceed
        // maxWidth (= contentWidth) by approximation; also guard against negatives.
        const clampedWidth = Math.min(Math.max(lineWidth, 0), maxWidth);
        const rect = createLineRect(clampedWidth, blockHeight, fills);
        rect.layoutAlign = "INHERIT"; // keep measured width, don't stretch
        rect.layoutGrow = 0;
        frame.appendChild(rect);
    }
    // Set HUG after resize() and after children are appended so Figma computes
    // the real height from child content rather than the placeholder 1px.
    frame.primaryAxisSizingMode = "AUTO";
    return frame;
}
// Builds the complete block replacement for a TextNode.
//
// Two structural cases:
//   1. Single segment (one or more lines, including soft returns)
//        → one segment FrameNode (vertical auto-layout)
//   2. Multiple segments (\n-separated paragraphs)
//        → outer FrameNode (itemSpacing = paragraphSpacing)
//          containing one inner segment frame per paragraph
async function createBlockReplacement(node, sharedTemp) {
    const fontSize = getEffectiveFontSize(node);
    const effectiveLH = getEffectiveLineHeight(node);
    const fills = getTextFills(node);
    const contentWidth = getContentWidth(node);
    const xOffset = getContentXOffset(node);
    const blockHeight = fontSize;
    const lineSpacing = Math.max(0, effectiveLH - fontSize);
    const paragraphSpacing = getParagraphSpacing(node);
    const align = getCounterAxisAlign(node);
    // Simulate word-wrapping at the container boundary (node.width), NOT at
    // contentWidth. contentWidth is the widest rendered line — using it as the
    // wrap threshold would be too narrow and produce extra lines.
    const segments = await measureLineWidths(node, node.width, sharedTemp);
    const totalLines = segments.reduce((sum, s) => sum + s.length, 0);
    // ── Case 1 & 2: Single segment (one or more lines) → one segment frame ────
    // Single-line nodes go through buildSegmentFrame too (not a bare rect) so that
    // paddingBottom = lineSpacing gives the correct total height = effectiveLH,
    // matching the vertical footprint of the original text node.
    if (segments.length === 1) {
        const frame = buildSegmentFrame(segments[0], contentWidth, blockHeight, lineSpacing, fills, align);
        applyLayoutProps(node, frame, xOffset);
        return frame;
    }
    // ── Case 3: Multiple segments → outer frame + inner segment frames ────────
    // The outer frame's itemSpacing represents paragraphSpacing between segments.
    // Each inner segment frame uses buildSegmentFrame (with paddingBottom = lineSpacing)
    // so its height = segmentLineCount × effectiveLH.
    const outer = figma.createFrame();
    outer.layoutMode = "VERTICAL";
    outer.counterAxisSizingMode = "FIXED";
    outer.counterAxisAlignItems = align;
    outer.resize(Math.max(1, contentWidth), 1);
    outer.itemSpacing = paragraphSpacing;
    outer.paddingTop = 0;
    outer.paddingBottom = 0;
    outer.paddingLeft = 0;
    outer.paddingRight = 0;
    outer.fills = [];
    outer.clipsContent = false;
    for (const segmentLines of segments) {
        const inner = buildSegmentFrame(segmentLines, contentWidth, blockHeight, lineSpacing, fills, align);
        inner.layoutAlign = "INHERIT";
        inner.layoutGrow = 0;
        outer.appendChild(inner);
    }
    outer.primaryAxisSizingMode = "AUTO";
    applyLayoutProps(node, outer, xOffset);
    return outer;
}
// ── Layout property transfer ───────────────────────────────────────────────
function applyLayoutProps(from, to, xOffset = 0) {
    to.name = `[block] ${from.name}`;
    // Preserve visibility — hidden text nodes produce hidden blocks
    to.visible = from.visible;
    // Position — meaningful for non-auto-layout parents and absolute-positioned children.
    // xOffset shifts x to align with the actual rendered text content (e.g. for right-
    // or center-aligned text whose bounding box is narrower than its container).
    to.x = from.x + xOffset;
    to.y = from.y;
    // Constraints (used in non-auto-layout frames)
    to.constraints = from.constraints;
    // Copy layoutAlign (counter-axis alignment within an auto-layout parent).
    // STRETCH is intentionally NOT propagated: the replacement is already sized to
    // contentWidth via resize(), and layoutAlign='STRETCH' would override that fixed
    // width, causing the block to fill the parent container instead of the text width.
    // layoutGrow is also NOT copied — FILL (grow=1) has the same problem on the primary axis.
    const f = from;
    const t = to;
    if (typeof f.layoutAlign === "string" && f.layoutAlign !== "STRETCH") {
        t.layoutAlign = f.layoutAlign;
    }
}
// ── Tree traversal ─────────────────────────────────────────────────────────
function hasTextDescendant(node) {
    return node.findOne((n) => n.type === "TEXT") !== null;
}
// Yields a macrotask to the event loop so Figma's renderer can update the
// progress spinner and canvas — but only if at least YIELD_INTERVAL_MS have
// elapsed since the last yield. This keeps the UI alive without adding a
// setTimeout pause after every single node (which would negate the speedup).
//
// Must use setTimeout (macrotask), not Promise.resolve() (microtask) —
// only macrotask boundaries allow a rendering pass to occur.
const YIELD_INTERVAL_MS = 50; // ~20 renders/sec; enough to keep the spinner smooth
async function yieldToUI() {
    const now = Date.now();
    if (now - lastYieldTime >= YIELD_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYieldTime = Date.now();
    }
}
async function replaceTextNode(textNode, parent, sharedTemp) {
    currentNodeName = textNode.name;
    const children = parent.children;
    const index = children.indexOf(textNode);
    if (index === -1)
        return; // Defensive: node not found in parent
    // Build replacement BEFORE remove() — node properties become unreliable after removal
    const replacement = await createBlockReplacement(textNode, sharedTemp);
    // Remove original, then insert replacement at the same slot.
    // After remove(), all subsequent indices shift down by 1, so `index` now
    // correctly points to the vacated position.
    textNode.remove();
    parent.insertChild(index, replacement);
}
async function processNode(node, sharedTemp) {
    currentNodeName = node.name;
    if (node.type === "INSTANCE") {
        if (hasTextDescendant(node)) {
            currentNodeName = node.name;
            const detached = node.detachInstance();
            await processNode(detached, sharedTemp);
        }
        // Instances without text are left intact
        return;
    }
    if (!("children" in node))
        return;
    const container = node;
    // Snapshot children BEFORE iterating — insertions/removals during the loop
    // mutate the live children array, shifting indices and causing skips or double-processing
    const childSnapshot = [...container.children];
    for (const child of childSnapshot) {
        currentNodeName = child.name;
        // Skip any layer (text, frame, instance, group…) whose name starts with
        // the configured prefix — the entire subtree is left untouched.
        if (settings.skipPrefix && child.name.startsWith(settings.skipPrefix))
            continue;
        if (child.type === "TEXT") {
            await replaceTextNode(child, container, sharedTemp);
            await yieldToUI(); // let Figma's renderer update between replacements
        }
        else if (child.type === "INSTANCE") {
            if (hasTextDescendant(child)) {
                const detached = child.detachInstance();
                await processNode(detached, sharedTemp);
            }
            // Instances without text are left intact
        }
        else if ("children" in child) {
            await processNode(child, sharedTemp);
        }
        // All other leaf node types (rectangles, ellipses, vectors, etc.) are skipped
    }
}
// ── Entry point ────────────────────────────────────────────────────────────
(async function main() {
    // ── Settings command ──────────────────────────────────────────────────────
    // Invoked via "Text Blocks — Settings…" in the plugin menu.
    // Shows a small UI panel; the main conversion command never opens any UI.
    if (figma.command === "settings") {
        settings = await loadSettings();
        figma.showUI(__html__, { width: 300, height: 305, title: "Settings" });
        figma.ui.postMessage({ type: "init", settings });
        figma.ui.onmessage = async (msg) => {
            if (msg.type === "save" && msg.settings) {
                await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
                figma.notify("Settings saved.");
            }
            figma.closePlugin();
        };
        return; // keep open until the UI posts a message
    }
    // ── Main conversion command ───────────────────────────────────────────────
    settings = await loadSettings();
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
        figma.closePlugin("Select a frame, group, component, or instance to convert text to blocks.");
        return;
    }
    if (selection.length > 1) {
        figma.closePlugin("Select only one node.");
        return;
    }
    const node = selection[0];
    // Reset yield timer so the first yield fires after YIELD_INTERVAL_MS of actual work,
    // not immediately on the first node.
    lastYieldTime = Date.now();
    // Create one shared temp text node for all measurements in this run.
    // Reusing it avoids per-node create/destroy overhead across many text nodes.
    // It must be removed before closePlugin() in every exit path.
    const measureTemp = figma.createText();
    measureTemp.visible = false;
    try {
        // Allow directly-selected text nodes — replace just that one node.
        if (node.type === "TEXT") {
            const parent = node.parent;
            if (!parent || !("children" in parent)) {
                measureTemp.remove();
                figma.closePlugin("Cannot replace text node — no valid parent container.");
                return;
            }
            await replaceTextNode(node, parent, measureTemp);
            measureTemp.remove();
            figma.notify("Text converted to block.");
            figma.closePlugin();
            return;
        }
        if (!("children" in node)) {
            measureTemp.remove();
            figma.closePlugin("Selected node has no children. Select a frame, group, or component.");
            return;
        }
        await processNode(node, measureTemp);
        measureTemp.remove();
        figma.notify("Text converted to blocks.");
        figma.closePlugin();
    }
    catch (err) {
        measureTemp.remove();
        const msg = err instanceof Error ? err.message : String(err);
        figma.closePlugin(`Error processing "${currentNodeName}": ${msg}. Press Cmd+Z to undo any partial changes.`);
    }
})();
