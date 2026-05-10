# Change Mascot

The mascot and whiteboard background are one PNG asset:

```text
src/assets/held-whiteboard.png
```

For a built app, you do not need to rebuild. Put a replacement PNG beside the `.exe`:

```text
src-tauri/target/release/held-whiteboard.png
```

The app loads this local file on startup. If it is missing, it falls back to the built-in asset.

## Image Requirements

- Format: PNG
- Background: real transparency, not checkerboard pixels
- Keep the whiteboard visible in the image
- Recommended size: close to the current image size and ratio
  - Current ratio: `1448 x 1086`
  - Aspect ratio: about `4:3`
- Keep the whiteboard in roughly the same position if possible

## Steps

1. Create or export the new mascot image as a transparent PNG.
2. Rename it to:

```text
held-whiteboard.png
```

3. Copy it next to the app executable:

```text
src-tauri/target/release/held-whiteboard.png
```

4. Run the built app again.

For development, you can also replace the source asset:

```text
src/assets/held-whiteboard.png
```

## If The Drawing Area Is Misaligned

The drawable canvas is positioned over the whiteboard with CSS in:

```text
src/styles.css
```

Update this block:

```css
#paint {
  top: 12.57%;
  left: 26.79%;
  width: 65.1%;
  height: 60.83%;
}
```

Adjust:

- `top`: moves drawing area down/up
- `left`: moves drawing area right/left
- `width`: changes drawing area width
- `height`: changes drawing area height

Use percentages so resizing still works.

## Transparency Check

If the app shows a checkerboard around the mascot, the PNG background is not transparent. Re-export the image with alpha transparency enabled.

## Prompt To Generate A Similar Mascot Image

Use this prompt with an image generator:

```text
Create a transparent-background PNG of a stylized 3D game character holding a large blank whiteboard. The character stands on the left side, leaning slightly from behind the board, with one hand gripping the left edge and the other arm extended under the bottom edge as if presenting the board. The whiteboard fills most of the image, positioned on the right side, with a clean blank off-white drawing surface and a gray metal frame with rounded corner caps. The character should have a mildly funny, skeptical expression and wear a dark red short-sleeve shirt and dark pants. Use a low-poly, retro 3D videogame style similar to early-2000s open-world game characters. Full body or upper body visible on the left, board fully visible on the right. No text, no logos, no background, no shadow outside the character and board. The background must be true alpha transparency, not a checkerboard pattern. Output as a high-resolution PNG around 1448 x 1086 pixels, 4:3 aspect ratio.
```

If the generator cannot output transparency directly, generate on a flat solid color background and remove the background afterward. Do not keep checkerboard pixels in the final PNG.
