import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CanvasRenderer } from "./canvas-renderer";
import { DocumentHistory } from "./editor-history";
import {
  CornerHandle,
  clampPoint,
  hitResizeHandle,
  hitTestObject,
  moveObject,
  normalizeRect,
  objectBounds,
  resizeLine,
  resizePath,
  resizeRect,
  ResizeHandle,
} from "./geometry";
import {
  BoardObject,
  cloneDocument,
  createDocument,
  createObjectId,
  findObject,
  FwbDocumentV1,
  isStrokeObject,
  LineObject,
  PathObject,
  Point,
  ProjectBackground,
  RectObject,
  StrokeStyle,
  TextObject,
  TextStyle,
  Tool,
  STROKE_SIZE_MAX,
  STROKE_SIZE_MIN,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
} from "./project-document";
import "./styles.css";

type ImportedPng = {
  dataBase64: string;
  width: number;
  height: number;
};

type DrawGesture = {
  kind: "draw";
  pointerId: number;
  start: Point;
  object: PathObject | LineObject | RectObject;
};

type TransformGesture = {
  kind: "move" | "resize";
  pointerId: number;
  start: Point;
  before: FwbDocumentV1;
  original: BoardObject;
  handle: ResizeHandle | null;
  changed: boolean;
};

type Gesture = DrawGesture | TransformGesture;

type TextSession = {
  mode: "create" | "edit";
  id: string;
  anchor: Point;
  before: FwbDocumentV1;
  style: TextStyle;
};

const boardLayer = document.querySelector<HTMLDivElement>(".board-layer")!;
const canvas = document.getElementById("paint") as HTMLCanvasElement;
const interactionCanvas = document.getElementById("interaction") as HTMLCanvasElement;
const textEditor = document.getElementById("textEditor") as HTMLTextAreaElement;
const colorPicker = document.getElementById("colorPicker") as HTMLInputElement;
const sizeInput = document.getElementById("toolSize") as HTMLInputElement;
const sizeValue = document.getElementById("sizeValue") as HTMLOutputElement;
const colorValue = document.getElementById("colorValue") as HTMLElement;
const rangeFill = document.getElementById("rangeFill") as HTMLDivElement;
const textFormatControls = document.getElementById("textFormatControls") as HTMLDivElement;
const boldBtn = document.getElementById("boldBtn") as HTMLButtonElement;
const italicBtn = document.getElementById("italicBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const saveProjectBtn = document.getElementById("saveProjectBtn") as HTMLButtonElement;
const openProjectBtn = document.getElementById("openProjectBtn") as HTMLButtonElement;
const importPngBtn = document.getElementById("importPngBtn") as HTMLButtonElement;
const exportPngBtn = document.getElementById("exportPngBtn") as HTMLButtonElement;
const undoBtn = document.getElementById("undoBtn") as HTMLButtonElement;
const redoBtn = document.getElementById("redoBtn") as HTMLButtonElement;
const sceneImage = document.getElementById("sceneImage") as HTMLImageElement;
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-tool]"),
);

const renderer = new CanvasRenderer(canvas, interactionCanvas);
const strokeDefaults: StrokeStyle = { color: "#111111", width: 5 };
const textDefaults: TextStyle = {
  color: "#111111",
  font: "system-sans",
  fontSize: 32,
  bold: false,
  italic: false,
  lineHeight: TEXT_LINE_HEIGHT,
};

const initialBoardRect = canvas.getBoundingClientRect();
let history = new DocumentHistory(
  createDocument(initialBoardRect.width || 1, initialBoardRect.height || 1),
);
let activeTool: Tool = "brush";
let selectedId: string | null = null;
let gesture: Gesture | null = null;
let transientObject: BoardObject | null = null;
let textSession: TextSession | null = null;
let propertyEditBefore: FwbDocumentV1 | null = null;
let currentProjectPath: string | null = null;

function currentDocument(): FwbDocumentV1 {
  return history.current;
}

function selectedObject(): BoardObject | null {
  return findObject(currentDocument(), selectedId);
}

function replaceObject(
  document: FwbDocumentV1,
  replacement: BoardObject,
): FwbDocumentV1 {
  const next = cloneDocument(document);
  const index = next.objects.findIndex((object) => object.id === replacement.id);
  if (index >= 0) next.objects[index] = replacement;
  return next;
}

function render(): void {
  const selected = selectedObject();
  if (selectedId && !selected) selectedId = null;
  renderer.render(currentDocument(), {
    selected: selectedId ? findObject(currentDocument(), selectedId) : null,
    transient: transientObject,
  });
  updateHistoryButtons();
  updateTextEditorLayout();
}

function updateHistoryButtons(): void {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
}

function updateTextEditorLayout(): void {
  if (!textSession) return;
  const position = renderer.documentToCss(textSession.anchor);
  const availableWidth = Math.max(1, renderer.viewportWidth - position.x);
  const availableHeight = Math.max(1, renderer.viewportHeight - position.y);
  textEditor.style.left = `${position.x}px`;
  textEditor.style.top = `${position.y}px`;
  textEditor.style.width = `${availableWidth}px`;
  textEditor.style.maxHeight = `${availableHeight}px`;
  textEditor.style.fontSize = `${textSession.style.fontSize * renderer.scale}px`;
  textEditor.style.lineHeight = String(textSession.style.lineHeight);
  textEditor.style.height = "auto";
  textEditor.style.height = `${Math.min(textEditor.scrollHeight, availableHeight)}px`;
}

function syncTextEditorStyle(): void {
  if (!textSession) return;
  textEditor.style.color = textSession.style.color;
  textEditor.style.fontFamily = TEXT_FONT_FAMILY;
  textEditor.style.fontWeight = textSession.style.bold ? "700" : "400";
  textEditor.style.fontStyle = textSession.style.italic ? "italic" : "normal";
  updateTextEditorLayout();
}

function closeTextEditor(): void {
  textSession = null;
  textEditor.hidden = true;
  textEditor.value = "";
  for (const property of ["left", "top", "width", "height", "max-height", "font-size"]) {
    textEditor.style.removeProperty(property);
  }
}

function cancelTextSession(): boolean {
  if (!textSession) return false;
  closeTextEditor();
  syncControls();
  interactionCanvas.focus({ preventScroll: true });
  render();
  return true;
}

function startTextSession(point: Point, object: TextObject | null = null): void {
  const before = cloneDocument(currentDocument());
  const style = object ? structuredClone(object.style) : structuredClone(textDefaults);
  textSession = {
    mode: object ? "edit" : "create",
    id: object?.id ?? createObjectId(),
    anchor: object ? { x: object.x, y: object.y } : point,
    before,
    style,
  };
  selectedId = object?.id ?? null;
  textEditor.value = object?.value ?? "";
  textEditor.hidden = false;
  syncTextEditorStyle();
  syncControls();
  textEditor.focus({ preventScroll: true });
  textEditor.select();
  render();
}

function commitTextSession(): boolean {
  const session = textSession;
  if (!session) return false;
  const value = textEditor.value.replace(/\r\n?/g, "\n");
  const next = cloneDocument(session.before);
  const existingIndex = next.objects.findIndex((object) => object.id === session.id);

  if (/\S/u.test(value)) {
    const object: TextObject = {
      id: session.id,
      type: "text",
      x: session.anchor.x,
      y: session.anchor.y,
      value,
      style: structuredClone(session.style),
    };
    if (existingIndex >= 0) next.objects[existingIndex] = object;
    else next.objects.push(object);
    selectedId = object.id;
  } else if (existingIndex >= 0) {
    next.objects.splice(existingIndex, 1);
    selectedId = null;
  } else {
    closeTextEditor();
    syncControls();
    render();
    return false;
  }

  closeTextEditor();
  history.commit(next, session.before);
  syncControls();
  render();
  return true;
}

function setTool(tool: Tool): void {
  if (textSession) commitTextSession();
  activeTool = tool;
  if (tool !== "select") selectedId = null;
  toolButtons.forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  boardLayer.dataset.tool = tool;
  propertyEditBefore = null;
  syncControls();
  render();
}

function controlTarget(): BoardObject | null {
  return activeTool === "select" ? selectedObject() : null;
}

function syncControls(): void {
  const selected = controlTarget();
  const textTarget = textSession || selected?.type === "text";
  const strokeTarget = selected && isStrokeObject(selected) ? selected : null;
  const disabled = activeTool === "select" && !selected && !textSession;

  let color = activeTool === "text" ? textDefaults.color : strokeDefaults.color;
  let size = activeTool === "text" ? textDefaults.fontSize : strokeDefaults.width;
  if (textSession) {
    color = textSession.style.color;
    size = textSession.style.fontSize;
  } else if (selected?.type === "text") {
    color = selected.style.color;
    size = selected.style.fontSize;
  } else if (strokeTarget) {
    color = strokeTarget.stroke.color;
    size = strokeTarget.stroke.width;
  }

  const textMode = Boolean(textTarget) || (!selected && activeTool === "text");
  colorPicker.value = color;
  colorPicker.disabled = disabled;
  sizeInput.min = String(textMode ? TEXT_SIZE_MIN : STROKE_SIZE_MIN);
  sizeInput.max = String(textMode ? TEXT_SIZE_MAX : STROKE_SIZE_MAX);
  sizeInput.value = String(size);
  sizeInput.disabled = disabled;
  sizeInput.setAttribute("aria-label", textMode ? "Text size" : "Stroke size");
  textFormatControls.hidden = !textMode;
  boldBtn.disabled = !textMode;
  italicBtn.disabled = !textMode;

  const textStyle = textSession?.style ?? (selected?.type === "text" ? selected.style : textDefaults);
  boldBtn.classList.toggle("is-active", textStyle.bold);
  boldBtn.setAttribute("aria-pressed", String(textStyle.bold));
  italicBtn.classList.toggle("is-active", textStyle.italic);
  italicBtn.setAttribute("aria-pressed", String(textStyle.italic));
  updateControlReadouts();
}

function updateControlReadouts(): void {
  colorValue.textContent = colorPicker.value.toUpperCase();
  const min = Number.parseInt(sizeInput.min, 10);
  const max = Number.parseInt(sizeInput.max, 10);
  const value = Number.parseInt(sizeInput.value, 10);
  sizeValue.value = `${value}PX`;
  rangeFill.style.width = `${((value - min) / (max - min)) * 100}%`;
}

function mutateSelected(mutator: (object: BoardObject) => BoardObject): void {
  const selected = selectedObject();
  if (!selected) return;
  propertyEditBefore ??= cloneDocument(currentDocument());
  history.preview(replaceObject(currentDocument(), mutator(selected)));
  render();
}

function commitPropertyEdit(): void {
  if (!propertyEditBefore) return;
  const before = propertyEditBefore;
  propertyEditBefore = null;
  history.commit(currentDocument(), before);
  render();
}

function updateColor(value: string): void {
  if (textSession) {
    textSession.style.color = value;
    syncTextEditorStyle();
  } else if (activeTool === "select") {
    mutateSelected((object) => {
      if (object.type === "text") return { ...object, style: { ...object.style, color: value } };
      return { ...object, stroke: { ...object.stroke, color: value } };
    });
  } else if (activeTool === "text") {
    textDefaults.color = value;
  } else {
    strokeDefaults.color = value;
  }
  updateControlReadouts();
}

function updateSize(value: number): void {
  if (textSession) {
    textSession.style.fontSize = value;
    syncTextEditorStyle();
  } else if (activeTool === "select") {
    mutateSelected((object) => {
      if (object.type === "text") return { ...object, style: { ...object.style, fontSize: value } };
      return { ...object, stroke: { ...object.stroke, width: value } };
    });
  } else if (activeTool === "text") {
    textDefaults.fontSize = value;
  } else {
    strokeDefaults.width = value;
  }
  updateControlReadouts();
}

function toggleTextStyle(property: "bold" | "italic"): void {
  if (textSession) {
    textSession.style[property] = !textSession.style[property];
    syncTextEditorStyle();
  } else if (activeTool === "select") {
    const selected = selectedObject();
    if (selected?.type !== "text") return;
    const before = cloneDocument(currentDocument());
    const next = replaceObject(currentDocument(), {
      ...selected,
      style: { ...selected.style, [property]: !selected.style[property] },
    });
    history.commit(next, before);
  } else {
    textDefaults[property] = !textDefaults[property];
  }
  syncControls();
  render();
}

function pointerPoint(event: MouseEvent, clamp = true): Point {
  const point = renderer.clientToDocument(event.clientX, event.clientY);
  return clamp
    ? clampPoint(point, currentDocument().board.width, currentDocument().board.height)
    : point;
}

function hitObject(point: Point): BoardObject | null {
  const tolerance = 6 / renderer.scale;
  for (let index = currentDocument().objects.length - 1; index >= 0; index -= 1) {
    const object = currentDocument().objects[index];
    if (hitTestObject(object, point, tolerance, renderer.measureTextBounds)) return object;
  }
  return null;
}

function beginSelectGesture(event: PointerEvent, point: Point): void {
  const selected = selectedObject();
  if (selected) {
    const handle = hitResizeHandle(
      selected,
      point,
      9 / renderer.scale,
      renderer.measureTextBounds,
    );
    if (handle) {
      gesture = {
        kind: "resize",
        pointerId: event.pointerId,
        start: point,
        before: cloneDocument(currentDocument()),
        original: structuredClone(selected),
        handle,
        changed: false,
      };
      interactionCanvas.setPointerCapture(event.pointerId);
      return;
    }
  }

  const hit = hitObject(point);
  selectedId = hit?.id ?? null;
  syncControls();
  render();
  if (!hit) return;
  gesture = {
    kind: "move",
    pointerId: event.pointerId,
    start: point,
    before: cloneDocument(currentDocument()),
    original: structuredClone(hit),
    handle: null,
    changed: false,
  };
  interactionCanvas.setPointerCapture(event.pointerId);
}

function beginDrawGesture(event: PointerEvent, point: Point): void {
  if (activeTool === "brush") {
    const object: PathObject = {
      id: createObjectId(),
      type: "path",
      points: [point],
      stroke: structuredClone(strokeDefaults),
    };
    gesture = { kind: "draw", pointerId: event.pointerId, start: point, object };
    transientObject = object;
  } else if (activeTool === "line") {
    const object: LineObject = {
      id: createObjectId(),
      type: "line",
      start: point,
      end: point,
      stroke: structuredClone(strokeDefaults),
    };
    gesture = { kind: "draw", pointerId: event.pointerId, start: point, object };
    transientObject = object;
  } else if (activeTool === "rect") {
    const object: RectObject = {
      id: createObjectId(),
      type: "rect",
      ...normalizeRect(point, point),
      stroke: structuredClone(strokeDefaults),
    };
    gesture = { kind: "draw", pointerId: event.pointerId, start: point, object };
    transientObject = object;
  }
  if (gesture) interactionCanvas.setPointerCapture(event.pointerId);
  render();
}

function updateGesture(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  const point = pointerPoint(event);
  if (gesture.kind === "draw") {
    if (gesture.object.type === "path") {
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const sample of events) {
        const nextPoint = pointerPoint(sample);
        const last = gesture.object.points[gesture.object.points.length - 1];
        if (Math.hypot(nextPoint.x - last.x, nextPoint.y - last.y) >= 0.25) {
          gesture.object.points.push(nextPoint);
        }
      }
    } else if (gesture.object.type === "line") {
      gesture.object.end = point;
    } else {
      Object.assign(gesture.object, normalizeRect(gesture.start, point));
    }
    transientObject = structuredClone(gesture.object);
    render();
    return;
  }

  const transformGesture = gesture;
  const next = cloneDocument(transformGesture.before);
  const index = next.objects.findIndex((object) => object.id === transformGesture.original.id);
  if (index < 0) return;
  if (transformGesture.kind === "move") {
    next.objects[index] = moveObject(
      transformGesture.original,
      point.x - transformGesture.start.x,
      point.y - transformGesture.start.y,
    );
  } else if (transformGesture.original.type === "line" && (transformGesture.handle === "start" || transformGesture.handle === "end")) {
    next.objects[index] = resizeLine(transformGesture.original, transformGesture.handle, point);
  } else if (transformGesture.original.type === "rect" && isCornerHandle(transformGesture.handle)) {
    next.objects[index] = resizeRect(transformGesture.original, transformGesture.handle, point);
  } else if (transformGesture.original.type === "path" && isCornerHandle(transformGesture.handle)) {
    next.objects[index] = resizePath(
      transformGesture.original,
      objectBounds(transformGesture.original, renderer.measureTextBounds),
      transformGesture.handle,
      point,
    );
  }
  transformGesture.changed = true;
  history.preview(next);
  render();
}

function finishGesture(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  updateGesture(event);
  if (interactionCanvas.hasPointerCapture(event.pointerId)) {
    interactionCanvas.releasePointerCapture(event.pointerId);
  }
  if (gesture.kind === "draw") {
    const next = cloneDocument(currentDocument());
    next.objects.push(structuredClone(gesture.object));
    history.commit(next);
    selectedId = null;
  } else if (gesture.changed) {
    history.commit(currentDocument(), gesture.before);
  } else {
    history.preview(gesture.before);
  }
  gesture = null;
  transientObject = null;
  syncControls();
  render();
}

function cancelGesture(): boolean {
  if (!gesture) return false;
  if (gesture.kind !== "draw") history.preview(gesture.before);
  gesture = null;
  transientObject = null;
  syncControls();
  render();
  return true;
}

function isCornerHandle(handle: ResizeHandle | null): handle is CornerHandle {
  return handle === "nw" || handle === "ne" || handle === "se" || handle === "sw";
}

async function invokeStrict<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function ensureExtension(path: string, extension: ".fwb" | ".png"): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return `${path}${extension}`;
  if (path.slice(dot).toLowerCase() !== extension) {
    throw new Error(`Choose a ${extension} file.`);
  }
  return path;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openProject(): Promise<void> {
  try {
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Funny Whiteboard Project", extensions: ["fwb"] }],
    });
    if (!chosen) return;
    const path = ensureExtension(chosen, ".fwb");
    const project = await invokeStrict<FwbDocumentV1>("load_project", { path });
    await renderer.prepareDocument(project);
    history.replace(project);
    currentProjectPath = path;
    selectedId = null;
    gesture = null;
    transientObject = null;
    cancelTextSession();
    syncControls();
    render();
  } catch (error) {
    alert(`Open failed: ${describeError(error)}`);
  }
}

async function saveProject(): Promise<void> {
  try {
    if (textSession) commitTextSession();
    const chosen = await save({
      defaultPath: currentProjectPath ?? "drawing.fwb",
      filters: [{ name: "Funny Whiteboard Project", extensions: ["fwb"] }],
    });
    if (!chosen) return;
    const path = ensureExtension(chosen, ".fwb");
    currentProjectPath = await invokeStrict<string>("save_project", {
      path,
      document: currentDocument(),
    });
    alert(`Project saved as ${currentProjectPath}`);
  } catch (error) {
    alert(`Save failed: ${describeError(error)}`);
  }
}

async function importPng(): Promise<void> {
  try {
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (!chosen) return;
    const path = ensureExtension(chosen, ".png");
    const imported = await invokeStrict<ImportedPng>("load_png", { path });
    const before = cloneDocument(currentDocument());
    const next = cloneDocument(before);
    const empty = next.objects.length === 0 && next.background === null;
    if (empty) {
      next.board.width = imported.width;
      next.board.height = imported.height;
    }
    next.background = createBackground(imported, next);
    await renderer.prepareDocument(next);
    history.commit(next, before);
    selectedId = null;
    syncControls();
    render();
  } catch (error) {
    alert(`PNG import failed: ${describeError(error)}`);
  }
}

function createBackground(imported: ImportedPng, document: FwbDocumentV1): ProjectBackground {
  const scale = Math.min(
    document.board.width / imported.width,
    document.board.height / imported.height,
  );
  const width = imported.width * scale;
  const height = imported.height * scale;
  return {
    mimeType: "image/png",
    dataBase64: imported.dataBase64,
    intrinsicWidth: imported.width,
    intrinsicHeight: imported.height,
    placement: {
      x: (document.board.width - width) / 2,
      y: (document.board.height - height) / 2,
      width,
      height,
    },
  };
}

async function exportPng(): Promise<void> {
  try {
    if (textSession) commitTextSession();
    const chosen = await save({
      defaultPath: "drawing.png",
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (!chosen) return;
    const path = ensureExtension(chosen, ".png");
    const data = await renderer.exportPng(currentDocument());
    const savedPath = await invokeStrict<string>("save_png", { path, data });
    alert(`PNG exported as ${savedPath}`);
  } catch (error) {
    alert(`PNG export failed: ${describeError(error)}`);
  }
}

async function loadRuntimeMascotImage(): Promise<void> {
  try {
    const dataUrl = await invokeStrict<string | null>("load_mascot_image");
    if (dataUrl) sceneImage.src = dataUrl;
  } catch (error) {
    console.warn("Runtime mascot load failed", error);
  }
}

interactionCanvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  interactionCanvas.focus({ preventScroll: true });
  commitPropertyEdit();
  const point = pointerPoint(event);
  if (activeTool === "text") {
    if (textSession) commitTextSession();
    startTextSession(point);
  } else if (activeTool === "select") {
    beginSelectGesture(event, point);
  } else {
    beginDrawGesture(event, point);
  }
});

interactionCanvas.addEventListener("pointermove", (event) => {
  event.preventDefault();
  updateGesture(event);
});

interactionCanvas.addEventListener("pointerup", (event) => {
  event.preventDefault();
  finishGesture(event);
});

interactionCanvas.addEventListener("pointercancel", () => {
  cancelGesture();
});

interactionCanvas.addEventListener("dblclick", (event) => {
  if (activeTool !== "select") return;
  const hit = hitObject(pointerPoint(event));
  if (hit?.type === "text") startTextSession({ x: hit.x, y: hit.y }, hit);
});

textEditor.addEventListener("input", updateTextEditorLayout);
textEditor.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelTextSession();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    commitTextSession();
    interactionCanvas.focus({ preventScroll: true });
  }
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tool = button.dataset.tool;
    if (tool === "select" || tool === "brush" || tool === "line" || tool === "rect" || tool === "text") {
      setTool(tool);
    }
  });
});

colorPicker.addEventListener("input", () => updateColor(colorPicker.value));
colorPicker.addEventListener("change", commitPropertyEdit);
sizeInput.addEventListener("input", () => updateSize(Number.parseInt(sizeInput.value, 10)));
sizeInput.addEventListener("change", () => {
  commitPropertyEdit();
  if (textSession) textEditor.focus({ preventScroll: true });
});
boldBtn.addEventListener("click", () => toggleTextStyle("bold"));
italicBtn.addEventListener("click", () => toggleTextStyle("italic"));

clearBtn.addEventListener("click", () => {
  cancelTextSession();
  const before = cloneDocument(currentDocument());
  const next = createDocument(before.board.width, before.board.height);
  history.commit(next, before);
  selectedId = null;
  currentProjectPath = null;
  void renderer.prepareDocument(next).then(render);
});

undoBtn.addEventListener("click", () => {
  if (cancelTextSession()) return;
  commitPropertyEdit();
  if (!history.undo()) return;
  if (!selectedObject()) selectedId = null;
  void renderer.prepareDocument(currentDocument()).then(() => {
    syncControls();
    render();
  });
});

redoBtn.addEventListener("click", () => {
  if (cancelTextSession()) return;
  commitPropertyEdit();
  if (!history.redo()) return;
  if (!selectedObject()) selectedId = null;
  void renderer.prepareDocument(currentDocument()).then(() => {
    syncControls();
    render();
  });
});

openProjectBtn.addEventListener("click", () => void openProject());
saveProjectBtn.addEventListener("click", () => void saveProject());
importPngBtn.addEventListener("click", () => void importPng());
exportPngBtn.addEventListener("click", () => void exportPng());

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "Escape") {
    if (cancelGesture() || cancelTextSession()) return;
    selectedId = null;
    syncControls();
    render();
  } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
    event.preventDefault();
    const before = cloneDocument(currentDocument());
    const next = cloneDocument(before);
    next.objects = next.objects.filter((object) => object.id !== selectedId);
    history.commit(next, before);
    selectedId = null;
    syncControls();
    render();
  }
});

const resizeObserver = new ResizeObserver(() => render());
resizeObserver.observe(boardLayer);

requestAnimationFrame(async () => {
  const rect = canvas.getBoundingClientRect();
  history.replace(createDocument(rect.width, rect.height));
  await loadRuntimeMascotImage();
  await renderer.prepareDocument(currentDocument());
  setTool(activeTool);
});
