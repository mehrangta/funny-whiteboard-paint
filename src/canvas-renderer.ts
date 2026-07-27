import {
  BoardObject,
  FwbDocumentV1,
  Point,
  ProjectBackground,
  Rect,
  TextObject,
  TEXT_FONT_FAMILY,
} from "./project-document";
import { objectBounds, objectHandles } from "./geometry";

export type OverlayState = {
  selected: BoardObject | null;
  transient: BoardObject | null;
};

type ViewTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

export class CanvasRenderer {
  private readonly contentContext: CanvasRenderingContext2D;
  private readonly overlayContext: CanvasRenderingContext2D;
  private transform: ViewTransform = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    width: 1,
    height: 1,
  };
  private backgroundKey = "";
  private backgroundImage: HTMLImageElement | null = null;

  constructor(
    private readonly contentCanvas: HTMLCanvasElement,
    private readonly overlayCanvas: HTMLCanvasElement,
  ) {
    const contentContext = contentCanvas.getContext("2d");
    const overlayContext = overlayCanvas.getContext("2d");
    if (!contentContext || !overlayContext) throw new Error("Canvas 2D context unavailable");
    this.contentContext = contentContext;
    this.overlayContext = overlayContext;
  }

  resize(document: FwbDocumentV1): void {
    const rect = this.contentCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    for (const canvas of [this.contentCanvas, this.overlayCanvas]) {
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
    }
    const scale = Math.min(width / document.board.width, height / document.board.height);
    this.transform = {
      scale,
      offsetX: (width - document.board.width * scale) / 2,
      offsetY: (height - document.board.height * scale) / 2,
      width,
      height,
    };
  }

  async prepareDocument(document: FwbDocumentV1): Promise<void> {
    const background = document.background;
    const key = background?.dataBase64 ?? "";
    if (key === this.backgroundKey) return;
    const image = background ? await loadImage(background) : null;
    this.backgroundKey = key;
    this.backgroundImage = image;
  }

  render(document: FwbDocumentV1, overlay: OverlayState): void {
    this.resize(document);
    this.renderContent(this.contentContext, document, this.transform, this.backgroundImage);
    this.renderOverlay(overlay);
  }

  clientToDocument(clientX: number, clientY: number, clampToBoard = false): Point {
    const rect = this.overlayCanvas.getBoundingClientRect();
    let x = (clientX - rect.left - this.transform.offsetX) / this.transform.scale;
    let y = (clientY - rect.top - this.transform.offsetY) / this.transform.scale;
    if (clampToBoard) {
      x = Math.min(Math.max(x, 0), this.documentWidth);
      y = Math.min(Math.max(y, 0), this.documentHeight);
    }
    return { x, y };
  }

  documentToCss(point: Point): Point {
    return {
      x: this.transform.offsetX + point.x * this.transform.scale,
      y: this.transform.offsetY + point.y * this.transform.scale,
    };
  }

  get scale(): number {
    return this.transform.scale;
  }

  get viewportWidth(): number {
    return this.transform.width;
  }

  get viewportHeight(): number {
    return this.transform.height;
  }

  get documentWidth(): number {
    return (this.transform.width - this.transform.offsetX * 2) / this.transform.scale;
  }

  get documentHeight(): number {
    return (this.transform.height - this.transform.offsetY * 2) / this.transform.scale;
  }

  measureTextBounds = (object: TextObject): Rect => {
    const context = this.contentContext;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.font = textFont(object);
    const lines = object.value.split("\n");
    const width = Math.max(1, ...lines.map((line) => context.measureText(line).width));
    context.restore();
    return {
      x: object.x,
      y: object.y,
      width,
      height: Math.max(1, lines.length * object.style.fontSize * object.style.lineHeight),
    };
  };

  async exportPng(project: FwbDocumentV1): Promise<string> {
    await this.prepareDocument(project);
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = project.board.width;
    canvas.height = project.board.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Export canvas is unavailable");
    this.renderContent(
      context,
      project,
      {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        width: project.board.width,
        height: project.board.height,
      },
      this.backgroundImage,
    );
    return canvas.toDataURL("image/png");
  }

  private renderContent(
    context: CanvasRenderingContext2D,
    document: FwbDocumentV1,
    transform: ViewTransform,
    backgroundImage: HTMLImageElement | null,
  ): void {
    const dpr = context.canvas === this.contentCanvas ? window.devicePixelRatio || 1 : 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, transform.width, transform.height);
    context.save();
    context.translate(transform.offsetX, transform.offsetY);
    context.scale(transform.scale, transform.scale);
    if (document.background && backgroundImage) {
      const placement = document.background.placement;
      context.drawImage(
        backgroundImage,
        placement.x,
        placement.y,
        placement.width,
        placement.height,
      );
    }
    for (const object of document.objects) drawObject(context, object);
    context.restore();
  }

  private renderOverlay(overlay: OverlayState): void {
    const context = this.overlayContext;
    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, this.transform.width, this.transform.height);
    context.save();
    context.translate(this.transform.offsetX, this.transform.offsetY);
    context.scale(this.transform.scale, this.transform.scale);
    if (overlay.transient) {
      context.save();
      context.globalAlpha = 0.8;
      drawObject(context, overlay.transient);
      context.restore();
    }
    if (overlay.selected) {
      const bounds = objectBounds(overlay.selected, this.measureTextBounds);
      context.save();
      context.strokeStyle = "#f29100";
      context.fillStyle = "#ffffff";
      context.lineWidth = 1.5 / this.transform.scale;
      context.setLineDash([5 / this.transform.scale, 4 / this.transform.scale]);
      context.strokeRect(bounds.x, bounds.y, Math.max(bounds.width, 1), Math.max(bounds.height, 1));
      context.setLineDash([]);
      const handleSize = 8 / this.transform.scale;
      for (const handle of objectHandles(overlay.selected, this.measureTextBounds)) {
        context.fillRect(
          handle.point.x - handleSize / 2,
          handle.point.y - handleSize / 2,
          handleSize,
          handleSize,
        );
        context.strokeRect(
          handle.point.x - handleSize / 2,
          handle.point.y - handleSize / 2,
          handleSize,
          handleSize,
        );
      }
      context.restore();
    }
    context.restore();
  }
}

function drawObject(context: CanvasRenderingContext2D, object: BoardObject): void {
  context.save();
  if (object.type === "text") {
    context.fillStyle = object.style.color;
    context.font = textFont(object);
    context.textBaseline = "top";
    const lineHeight = object.style.fontSize * object.style.lineHeight;
    object.value.split("\n").forEach((line, index) => {
      context.fillText(line, object.x, object.y + index * lineHeight);
    });
    context.restore();
    return;
  }

  context.strokeStyle = object.stroke.color;
  context.fillStyle = object.stroke.color;
  context.lineWidth = object.stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (object.type === "path") {
    if (object.points.length === 1) {
      const point = object.points[0];
      context.beginPath();
      context.arc(point.x, point.y, object.stroke.width / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(object.points[0].x, object.points[0].y);
      for (const point of object.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  } else if (object.type === "line") {
    context.beginPath();
    context.moveTo(object.start.x, object.start.y);
    context.lineTo(object.end.x, object.end.y);
    context.stroke();
  } else {
    context.strokeRect(object.x, object.y, object.width, object.height);
  }
  context.restore();
}

function textFont(object: TextObject): string {
  return `${object.style.italic ? "italic" : "normal"} ${object.style.bold ? 700 : 400} ${object.style.fontSize}px ${TEXT_FONT_FAMILY}`;
}

function loadImage(background: ProjectBackground): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Embedded PNG background could not be decoded"));
    image.src = `data:${background.mimeType};base64,${background.dataBase64}`;
  });
}
