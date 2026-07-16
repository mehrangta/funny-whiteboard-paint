import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Tool = "brush" | "line" | "rect" | "text";
type Point = { x: number; y: number };
type TextSession = {
  anchor: Point;
  anchorRatio: Point;
};

const STROKE_SIZE_MIN = 1;
const STROKE_SIZE_MAX = 30;
const TEXT_SIZE_MIN = 8;
const TEXT_SIZE_MAX = 96;
const TEXT_LINE_HEIGHT = 1.2;
const TEXT_FONT_FAMILY = '"Segoe UI", Arial, sans-serif';

const boardLayer = document.querySelector<HTMLDivElement>(".board-layer")!;
const canvas = document.getElementById("paint") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const textEditor = document.getElementById("textEditor") as HTMLTextAreaElement;
const colorPicker = document.getElementById("colorPicker") as HTMLInputElement;
const sizeInput = document.getElementById("toolSize") as HTMLInputElement;
const sizeValue = document.getElementById("sizeValue") as HTMLOutputElement;
const colorValue = document.getElementById("colorValue") as HTMLElement;
const rangeFill = document.getElementById("rangeFill") as HTMLDivElement;
const textFormatControls = document.getElementById(
  "textFormatControls",
) as HTMLDivElement;
const boldBtn = document.getElementById("boldBtn") as HTMLButtonElement;
const italicBtn = document.getElementById("italicBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const loadBtn = document.getElementById("loadBtn") as HTMLButtonElement;
const fileNameInput = document.getElementById("fileName") as HTMLInputElement;
const undoBtn = document.getElementById("undoBtn") as HTMLButtonElement;
const redoBtn = document.getElementById("redoBtn") as HTMLButtonElement;
const sceneImage = document.getElementById("sceneImage") as HTMLImageElement;
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-tool]"),
);

let drawing = false;
let activeTool: Tool = "brush";
let startPoint: Point = { x: 0, y: 0 };
let lastPoint: Point = { x: 0, y: 0 };
let previewState: ImageData | null = null;
let resizeToken = 0;
let resizeCompletion: Promise<void> = Promise.resolve();
let strokeSize = 5;
let textSize = 32;
let textBold = false;
let textItalic = false;
let textSession: TextSession | null = null;
let textCommit: Promise<boolean> | null = null;

function boardSize() {
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

function applyCanvasDefaults() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });
}

function clearBoard() {
  const size = boardSize();
  ctx.clearRect(0, 0, size.width, size.height);
}

function drawImageOnBoard(img: CanvasImageSource) {
  const size = boardSize();
  clearBoard();
  ctx.drawImage(img, 0, 0, size.width, size.height);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function updateTextEditorLayout() {
  if (!textSession) return;

  const size = boardSize();
  const anchor = {
    x: clamp(textSession.anchorRatio.x * size.width, 0, size.width - 1),
    y: clamp(textSession.anchorRatio.y * size.height, 0, size.height - 1),
  };
  const availableWidth = Math.max(1, size.width - anchor.x);
  const availableHeight = Math.max(1, size.height - anchor.y);

  textSession.anchor = anchor;
  textEditor.style.left = `${anchor.x}px`;
  textEditor.style.top = `${anchor.y}px`;
  textEditor.style.width = `${availableWidth}px`;
  textEditor.style.maxHeight = `${availableHeight}px`;
  textEditor.style.height = "auto";
  textEditor.style.height = `${Math.min(textEditor.scrollHeight, availableHeight)}px`;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return resizeCompletion;

  const dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.round(rect.width * dpr));
  const nextHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width === nextWidth && canvas.height === nextHeight) {
    updateTextEditorLayout();
    return resizeCompletion;
  }

  const previous = canvas.width && canvas.height ? canvas.toDataURL("image/png") : "";
  const token = ++resizeToken;
  canvas.width = nextWidth;
  canvas.height = nextHeight;
  applyCanvasDefaults();

  const completion = previous
    ? loadImage(previous)
        .then((img) => {
          if (token === resizeToken) drawImageOnBoard(img);
        })
        .catch((error) => {
          console.warn("Canvas resize restore failed", error);
        })
    : Promise.resolve();

  resizeCompletion = completion.then(() => {
    if (token === resizeToken) updateTextEditorLayout();
  });
  return resizeCompletion;
}

async function waitForCanvasReady() {
  let pending: Promise<void>;
  do {
    pending = resizeCompletion;
    await pending;
  } while (pending !== resizeCompletion);
}

function pointFromEvent(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function applyStrokeStyle() {
  ctx.lineWidth = strokeSize;
  ctx.strokeStyle = colorPicker.value;
}

function drawShape(from: Point, to: Point) {
  applyStrokeStyle();

  if (activeTool === "line") {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    return;
  }

  if (activeTool === "rect") {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    ctx.strokeRect(x, y, width, height);
  }
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`Tauri command failed: ${command}`, error);
    return null;
  }
}

async function pushSnapshot() {
  await tauriInvoke<void>("push_state", { snapshot: canvas.toDataURL("image/png") });
}

async function loadRuntimeMascotImage() {
  const dataUrl = await tauriInvoke<string | null>("load_mascot_image");
  if (dataUrl) sceneImage.src = dataUrl;
}

function normalizedFileName() {
  let fileName = fileNameInput.value.trim();
  if (!fileName) return null;
  if (!fileName.toLowerCase().endsWith(".png")) fileName += ".png";
  return fileName;
}

function currentTextFont() {
  const style = textItalic ? "italic" : "normal";
  const weight = textBold ? 700 : 400;
  return `${style} ${weight} ${textSize}px ${TEXT_FONT_FAMILY}`;
}

function updateFormatButtons() {
  boldBtn.classList.toggle("is-active", textBold);
  boldBtn.setAttribute("aria-pressed", String(textBold));
  italicBtn.classList.toggle("is-active", textItalic);
  italicBtn.setAttribute("aria-pressed", String(textItalic));
}

function syncTextEditorStyle() {
  textEditor.style.color = colorPicker.value;
  textEditor.style.fontFamily = TEXT_FONT_FAMILY;
  textEditor.style.fontSize = `${textSize}px`;
  textEditor.style.fontWeight = textBold ? "700" : "400";
  textEditor.style.fontStyle = textItalic ? "italic" : "normal";
  textEditor.style.lineHeight = String(TEXT_LINE_HEIGHT);
  updateTextEditorLayout();
}

function updateSizeReadout() {
  const min = Number.parseInt(sizeInput.min, 10);
  const max = Number.parseInt(sizeInput.max, 10);
  const value = Number.parseInt(sizeInput.value, 10);
  const progress = ((value - min) / (max - min)) * 100;

  sizeValue.value = `${value}PX`;
  rangeFill.style.width = `${progress}%`;
}

function updateToolControls() {
  const textActive = activeTool === "text";
  sizeInput.min = String(textActive ? TEXT_SIZE_MIN : STROKE_SIZE_MIN);
  sizeInput.max = String(textActive ? TEXT_SIZE_MAX : STROKE_SIZE_MAX);
  sizeInput.value = String(textActive ? textSize : strokeSize);
  sizeInput.setAttribute("aria-label", textActive ? "Text size" : "Stroke size");
  textFormatControls.hidden = !textActive;
  boldBtn.disabled = !textActive;
  italicBtn.disabled = !textActive;
  boardLayer.classList.toggle("is-text-tool", textActive);
  updateFormatButtons();
  updateSizeReadout();
}

function setTool(tool: Tool) {
  activeTool = tool;
  toolButtons.forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateToolControls();
}

function updateColorReadout() {
  colorValue.textContent = colorPicker.value.toUpperCase();
}

function closeTextEditor(session: TextSession) {
  if (textSession !== session) return;
  textSession = null;
  textEditor.hidden = true;
  textEditor.value = "";
  textEditor.style.removeProperty("left");
  textEditor.style.removeProperty("top");
  textEditor.style.removeProperty("width");
  textEditor.style.removeProperty("height");
  textEditor.style.removeProperty("max-height");
}

function cancelTextSession() {
  if (!textSession) return false;
  const session = textSession;
  closeTextEditor(session);
  canvas.focus({ preventScroll: true });
  return true;
}

function startTextSession(point: Point) {
  const size = boardSize();
  const anchor = {
    x: clamp(point.x, 0, size.width - 1),
    y: clamp(point.y, 0, size.height - 1),
  };

  textSession = {
    anchor,
    anchorRatio: {
      x: anchor.x / size.width,
      y: anchor.y / size.height,
    },
  };
  textEditor.value = "";
  textEditor.hidden = false;
  syncTextEditorStyle();
  textEditor.focus({ preventScroll: true });
}

function commitTextSession() {
  if (textCommit) return textCommit;

  const session = textSession;
  if (!session) return Promise.resolve(false);

  textCommit = (async () => {
    const value = textEditor.value.replace(/\r\n?/g, "\n");
    if (!/\S/u.test(value)) {
      closeTextEditor(session);
      return false;
    }

    await waitForCanvasReady();
    if (textSession !== session) return false;

    updateTextEditorLayout();
    const lineHeight = textSize * TEXT_LINE_HEIGHT;
    ctx.save();
    ctx.fillStyle = colorPicker.value;
    ctx.textBaseline = "top";
    ctx.font = currentTextFont();
    value.split("\n").forEach((line, index) => {
      ctx.fillText(line, session.anchor.x, session.anchor.y + index * lineHeight);
    });
    ctx.restore();

    closeTextEditor(session);
    await pushSnapshot();
    return true;
  })().finally(() => {
    textCommit = null;
  });

  return textCommit;
}

async function handleCanvasPointerDown(event: PointerEvent) {
  event.preventDefault();
  await resizeCanvas();
  await waitForCanvasReady();

  const point = pointFromEvent(event);
  if (activeTool === "text") {
    if (textCommit) await textCommit;
    if (textSession) {
      if (/\S/u.test(textEditor.value)) {
        await commitTextSession();
      } else {
        cancelTextSession();
      }
    }
    startTextSession(point);
    return;
  }

  drawing = true;
  startPoint = point;
  lastPoint = startPoint;
  previewState = null;
  canvas.setPointerCapture(event.pointerId);
  applyStrokeStyle();

  if (activeTool === "brush") {
    ctx.beginPath();
    ctx.moveTo(startPoint.x, startPoint.y);
  } else {
    previewState = ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  void handleCanvasPointerDown(event);
});

canvas.addEventListener("pointermove", (event) => {
  if (!drawing) return;
  event.preventDefault();

  const point = pointFromEvent(event);

  if (activeTool === "brush") {
    applyStrokeStyle();
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint = point;
    return;
  }

  if (previewState) ctx.putImageData(previewState, 0, 0);
  drawShape(startPoint, point);
});

canvas.addEventListener("pointerup", async (event) => {
  if (!drawing) return;
  event.preventDefault();

  const point = pointFromEvent(event);
  drawing = false;
  canvas.releasePointerCapture(event.pointerId);

  if (activeTool !== "brush") {
    if (previewState) ctx.putImageData(previewState, 0, 0);
    drawShape(startPoint, point);
  }

  previewState = null;
  await pushSnapshot();
});

canvas.addEventListener("pointercancel", () => {
  drawing = false;
  if (previewState) ctx.putImageData(previewState, 0, 0);
  previewState = null;
});

textEditor.addEventListener("input", updateTextEditorLayout);

textEditor.addEventListener("keydown", (event) => {
  if (event.isComposing) return;

  if (event.key === "Escape") {
    event.preventDefault();
    cancelTextSession();
    return;
  }

  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void commitTextSession().then(() => {
      canvas.focus({ preventScroll: true });
    });
  }
});

toolButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const nextTool = button.dataset.tool;
    if (
      nextTool !== "brush" &&
      nextTool !== "line" &&
      nextTool !== "rect" &&
      nextTool !== "text"
    ) {
      return;
    }
    if (nextTool === activeTool) return;

    if (activeTool === "text") await commitTextSession();
    setTool(nextTool);
  });
});

sizeInput.addEventListener("input", () => {
  const value = Number.parseInt(sizeInput.value, 10);
  if (activeTool === "text") {
    textSize = value;
    syncTextEditorStyle();
  } else {
    strokeSize = value;
  }
  updateSizeReadout();
});

sizeInput.addEventListener("change", () => {
  if (textSession) textEditor.focus({ preventScroll: true });
});

colorPicker.addEventListener("input", () => {
  updateColorReadout();
  syncTextEditorStyle();
});

colorPicker.addEventListener("change", () => {
  if (textSession) textEditor.focus({ preventScroll: true });
});

[boldBtn, italicBtn].forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    if (textSession) event.preventDefault();
  });
});

boldBtn.addEventListener("click", () => {
  textBold = !textBold;
  updateFormatButtons();
  syncTextEditorStyle();
  if (textSession) textEditor.focus({ preventScroll: true });
});

italicBtn.addEventListener("click", () => {
  textItalic = !textItalic;
  updateFormatButtons();
  syncTextEditorStyle();
  if (textSession) textEditor.focus({ preventScroll: true });
});

clearBtn.addEventListener("click", async () => {
  cancelTextSession();
  if (textCommit) await textCommit;
  await waitForCanvasReady();
  clearBoard();
  await pushSnapshot();
});

saveBtn.addEventListener("click", async () => {
  const fileName = normalizedFileName();
  if (!fileName) {
    alert("Enter a file name first.");
    return;
  }

  await commitTextSession();
  await waitForCanvasReady();
  const path = `saved_images/${fileName}`;
  const data = canvas.toDataURL("image/png");
  const savedPath = await tauriInvoke<string>("save_image", { path, data });
  if (savedPath === null) {
    alert("Save failed. Check the console for details.");
    return;
  }

  alert(`Saved as ${savedPath}`);
});

loadBtn.addEventListener("click", async () => {
  const fileName = normalizedFileName();
  if (!fileName) {
    alert("Enter a file name first.");
    return;
  }

  cancelTextSession();
  if (textCommit) await textCommit;
  const path = `saved_images/${fileName}`;
  const dataUrl = await tauriInvoke<string>("load_image", { path });
  if (!dataUrl) {
    alert("Load failed. Check the console for details.");
    return;
  }

  const img = await loadImage(dataUrl);
  await waitForCanvasReady();
  drawImageOnBoard(img);
  await pushSnapshot();
});

undoBtn.addEventListener("click", async () => {
  if (cancelTextSession()) return;
  if (textCommit) await textCommit;

  const state = await tauriInvoke<string | null>("undo");
  if (!state) return;

  const img = await loadImage(state);
  await waitForCanvasReady();
  drawImageOnBoard(img);
});

redoBtn.addEventListener("click", async () => {
  if (cancelTextSession()) return;
  if (textCommit) await textCommit;

  const state = await tauriInvoke<string | null>("redo");
  if (!state) return;

  const img = await loadImage(state);
  await waitForCanvasReady();
  drawImageOnBoard(img);
});

const resizeObserver = new ResizeObserver(() => {
  void resizeCanvas();
});
resizeObserver.observe(canvas);
window.addEventListener("resize", () => {
  void resizeCanvas();
});

requestAnimationFrame(async () => {
  await loadRuntimeMascotImage();
  setTool(activeTool);
  updateColorReadout();
  await resizeCanvas();
  await pushSnapshot();
});
