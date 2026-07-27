export type Tool = "select" | "brush" | "line" | "rect" | "text";

export type Point = {
  x: number;
  y: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StrokeStyle = {
  color: string;
  width: number;
};

export type PathObject = {
  id: string;
  type: "path";
  points: Point[];
  stroke: StrokeStyle;
};

export type LineObject = {
  id: string;
  type: "line";
  start: Point;
  end: Point;
  stroke: StrokeStyle;
};

export type RectObject = {
  id: string;
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: StrokeStyle;
};

export type TextStyle = {
  color: string;
  font: "system-sans";
  fontSize: number;
  bold: boolean;
  italic: boolean;
  lineHeight: number;
};

export type TextObject = {
  id: string;
  type: "text";
  x: number;
  y: number;
  value: string;
  style: TextStyle;
};

export type BoardObject = PathObject | LineObject | RectObject | TextObject;

export type ProjectBackground = {
  mimeType: "image/png";
  dataBase64: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  placement: Rect;
};

export type FwbDocumentV1 = {
  format: "funny-whiteboard";
  version: 1;
  board: {
    width: number;
    height: number;
  };
  background: ProjectBackground | null;
  objects: BoardObject[];
};

export const STROKE_SIZE_MIN = 1;
export const STROKE_SIZE_MAX = 30;
export const TEXT_SIZE_MIN = 8;
export const TEXT_SIZE_MAX = 96;
export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_FONT_FAMILY = '"Segoe UI", Arial, sans-serif';
export const HISTORY_LIMIT = 50;

export function createDocument(width: number, height: number): FwbDocumentV1 {
  return {
    format: "funny-whiteboard",
    version: 1,
    board: {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    },
    background: null,
    objects: [],
  };
}

export function cloneDocument(document: FwbDocumentV1): FwbDocumentV1 {
  return structuredClone(document);
}

export function createObjectId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function isStrokeObject(
  object: BoardObject,
): object is PathObject | LineObject | RectObject {
  return object.type === "path" || object.type === "line" || object.type === "rect";
}

export function findObject(
  document: FwbDocumentV1,
  id: string | null,
): BoardObject | null {
  if (!id) return null;
  return document.objects.find((object) => object.id === id) ?? null;
}

