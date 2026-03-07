# Text Blocks — Figma Plugin

Converts every text layer inside a selected frame into a rounded-rectangle skeleton block. Useful for quickly generating lo-fi wireframes or placeholder layouts from real copy.

---

## What it does

- Replaces each line of text with a filled rectangle that matches the text's color and approximate width.
- Component instances that contain text are automatically detached before processing.
- All changes are grouped into a single undo step.
- Opacity and corner radius can be customized in Settings, and a layer prefix can be set to skip select layers or containers.

---

## Installation

1. Clone or download this repository.
2. In Figma Desktop, go to **Plugins → Development → Import plugin from manifest…** and select `manifest.json`.

---

## Usage

Select a frame, group, component, or instance in Figma, then run Text Blocks > Convert.

**Convert:** Converts the selected text layer or all of its nested text layers.

**Settings:** Opens a small panel to customize conversion options.

---

## Settings

| Option            | Default  | Description                                                                          |
| ----------------- | -------- | ------------------------------------------------------------------------------------ |
| **Opacity**       | 40%      | Opacity of blocks.                                                                   |
| **Corner Radius** | 10 px    | Corner radius of blocks.                                                             |
| **Skip Prefix**   | _(none)_ | All child elements whose name starts with this string are skipped and not converted. |

## Development

If you make changes to `code.ts`:
Run `npm install` then `npm run build` to compile `code.ts` → `code.js`.
