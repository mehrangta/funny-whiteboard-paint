import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Tool = "brush" | "line" | "rect";
type Point = { x: number; y: number };

const canvas = document.getElementById("paint") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const colorPicker = document.getElementById("colorPicker") as HTMLInputElement;
const brushSize = document.getElementById("brushSize") as HTMLInputElement;
const sizeValue = document.getElementById("sizeValue") as HTMLOutputElement;
const colorValue = document.getElementById("colorValue") as HTMLElement;
const rangeFill = document.getElementById("rangeFill") as HTMLDivElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const loadBtn = document.getElementById("loadBtn") as HTMLButtonElement;
const fileNameInput = document.getElementById("fileName") as HTMLInputElement;
const undoBtn = document.getElementById("undoBtn") as HTMLButtonElement;
const redoBtn = document.getElementById("redoBtn") as HTMLButtonElement;
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-tool]"),
);

let drawing = false;
let activeTool: Tool = "brush";
let startPoint: Point = { x: 0, y: 0 };
let lastPoint: Point = { x: 0, y: 0 };
let previewState: ImageData | null = null;
let resizeToken = 0;

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

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const previous = canvas.width && canvas.height ? canvas.toDataURL("image/png") : "";
  const dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.round(rect.width * dpr));
  const nextHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width === nextWidth && canvas.height === nextHeight) return;

  const token = ++resizeToken;
  canvas.width = nextWidth;
  canvas.height = nextHeight;
  applyCanvasDefaults();

  if (!previous) return;

  void loadImage(previous).then((img) => {
    if (token === resizeToken) drawImageOnBoard(img);
  });
}

function pointFromEvent(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function applyStrokeStyle() {
  ctx.lineWidth = Number.parseInt(brushSize.value, 10);
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

function normalizedFileName() {
  let fileName = fileNameInput.value.trim();
  if (!fileName) return null;
  if (!fileName.toLowerCase().endsWith(".png")) fileName += ".png";
  return fileName;
}

function setTool(tool: Tool) {
  activeTool = tool;
  toolButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === tool);
  });
}

function updateBrushReadout() {
  const min = Number.parseInt(brushSize.min, 10);
  const max = Number.parseInt(brushSize.max, 10);
  const value = Number.parseInt(brushSize.value, 10);
  const progress = ((value - min) / (max - min)) * 100;

  sizeValue.value = `${value}PX`;
  rangeFill.style.width = `${progress}%`;
}

function updateColorReadout() {
  colorValue.textContent = colorPicker.value.toUpperCase();
}

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  resizeCanvas();

  drawing = true;
  startPoint = pointFromEvent(event);
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

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextTool = button.dataset.tool;
    if (nextTool === "brush" || nextTool === "line" || nextTool === "rect") {
      setTool(nextTool);
    }
  });
});

brushSize.addEventListener("input", () => {
  updateBrushReadout();
});

colorPicker.addEventListener("input", () => {
  updateColorReadout();
});

clearBtn.addEventListener("click", async () => {
  clearBoard();
  await pushSnapshot();
});

saveBtn.addEventListener("click", async () => {
  const fileName = normalizedFileName();
  if (!fileName) {
    alert("Enter a file name first.");
    return;
  }

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

  const path = `saved_images/${fileName}`;
  const dataUrl = await tauriInvoke<string>("load_image", { path });
  if (!dataUrl) {
    alert("Load failed. Check the console for details.");
    return;
  }

  const img = await loadImage(dataUrl);
  drawImageOnBoard(img);
  await pushSnapshot();
});

undoBtn.addEventListener("click", async () => {
  const state = await tauriInvoke<string | null>("undo");
  if (!state) return;

  const img = await loadImage(state);
  drawImageOnBoard(img);
});

redoBtn.addEventListener("click", async () => {
  const state = await tauriInvoke<string | null>("redo");
  if (!state) return;

  const img = await loadImage(state);
  drawImageOnBoard(img);
});

const resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(canvas);
window.addEventListener("resize", resizeCanvas);

requestAnimationFrame(async () => {
  setTool(activeTool);
  updateBrushReadout();
  updateColorReadout();
  resizeCanvas();
  await pushSnapshot();
});
