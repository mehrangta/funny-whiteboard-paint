import {
  BoardObject,
  LineObject,
  PathObject,
  Point,
  Rect,
  RectObject,
  TextObject,
} from "./project-document";

export type CornerHandle = "nw" | "ne" | "se" | "sw";
export type ResizeHandle = CornerHandle | "start" | "end";

export type TextBoundsMeasurer = (object: TextObject) => Rect;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: clamp(point.x, 0, width),
    y: clamp(point.y, 0, height),
  };
}

export function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
  };
}

export function objectBounds(
  object: BoardObject,
  measureText: TextBoundsMeasurer,
): Rect {
  if (object.type === "rect") {
    return { x: object.x, y: object.y, width: object.width, height: object.height };
  }
  if (object.type === "text") return measureText(object);

  const points = object.type === "line" ? [object.start, object.end] : object.points;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function cornerPoints(rect: Rect): Record<CornerHandle, Point> {
  return {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
    sw: { x: rect.x, y: rect.y + rect.height },
  };
}

export function objectHandles(
  object: BoardObject,
  measureText: TextBoundsMeasurer,
): Array<{ handle: ResizeHandle; point: Point }> {
  if (object.type === "line") {
    return [
      { handle: "start", point: object.start },
      { handle: "end", point: object.end },
    ];
  }
  if (object.type === "rect" || object.type === "path") {
    const corners = cornerPoints(objectBounds(object, measureText));
    return (Object.entries(corners) as Array<[CornerHandle, Point]>).map(
      ([handle, point]) => ({ handle, point }),
    );
  }
  return [];
}

export function hitResizeHandle(
  object: BoardObject,
  point: Point,
  tolerance: number,
  measureText: TextBoundsMeasurer,
): ResizeHandle | null {
  for (const candidate of objectHandles(object, measureText)) {
    if (Math.hypot(point.x - candidate.point.x, point.y - candidate.point.y) <= tolerance) {
      return candidate.handle;
    }
  }
  return null;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

function pathHit(object: PathObject, point: Point, tolerance: number): boolean {
  if (object.points.length === 1) {
    return Math.hypot(point.x - object.points[0].x, point.y - object.points[0].y) <= tolerance;
  }
  for (let index = 1; index < object.points.length; index += 1) {
    if (distanceToSegment(point, object.points[index - 1], object.points[index]) <= tolerance) {
      return true;
    }
  }
  return false;
}

export function hitTestObject(
  object: BoardObject,
  point: Point,
  visualTolerance: number,
  measureText: TextBoundsMeasurer,
): boolean {
  if (object.type === "path") {
    return pathHit(object, point, visualTolerance + object.stroke.width / 2);
  }
  if (object.type === "line") {
    return distanceToSegment(point, object.start, object.end) <= visualTolerance + object.stroke.width / 2;
  }
  if (object.type === "rect") {
    const outer = {
      x: object.x - visualTolerance - object.stroke.width / 2,
      y: object.y - visualTolerance - object.stroke.width / 2,
      width: object.width + visualTolerance * 2 + object.stroke.width,
      height: object.height + visualTolerance * 2 + object.stroke.width,
    };
    const innerInset = visualTolerance + object.stroke.width / 2;
    const insideOuter = pointInRect(point, outer);
    const insideInner =
      object.width > innerInset * 2 &&
      object.height > innerInset * 2 &&
      pointInRect(point, {
        x: object.x + innerInset,
        y: object.y + innerInset,
        width: object.width - innerInset * 2,
        height: object.height - innerInset * 2,
      });
    return insideOuter && !insideInner;
  }
  return pointInRect(point, measureText(object));
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

export function moveObject(object: BoardObject, dx: number, dy: number): BoardObject {
  if (object.type === "path") {
    return {
      ...object,
      points: object.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    };
  }
  if (object.type === "line") {
    return {
      ...object,
      start: { x: object.start.x + dx, y: object.start.y + dy },
      end: { x: object.end.x + dx, y: object.end.y + dy },
    };
  }
  return { ...object, x: object.x + dx, y: object.y + dy };
}

export function resizeLine(
  object: LineObject,
  handle: "start" | "end",
  point: Point,
): LineObject {
  return { ...object, [handle]: point };
}

function oppositeCorner(rect: Rect, handle: CornerHandle): Point {
  const corners = cornerPoints(rect);
  if (handle === "nw") return corners.se;
  if (handle === "ne") return corners.sw;
  if (handle === "se") return corners.nw;
  return corners.ne;
}

export function resizeRect(
  object: RectObject,
  handle: CornerHandle,
  point: Point,
): RectObject {
  const fixed = oppositeCorner(object, handle);
  return { ...object, ...normalizeRect(fixed, point) };
}

export function resizePath(
  object: PathObject,
  originalBounds: Rect,
  handle: CornerHandle,
  point: Point,
): PathObject {
  const fixed = oppositeCorner(originalBounds, handle);
  const handleWest = handle === "nw" || handle === "sw";
  const handleNorth = handle === "nw" || handle === "ne";
  return {
    ...object,
    points: object.points.map((source) => {
      const amountX =
        originalBounds.width === 0 ? null : (source.x - originalBounds.x) / originalBounds.width;
      const amountY =
        originalBounds.height === 0 ? null : (source.y - originalBounds.y) / originalBounds.height;
      return {
        x:
          amountX === null
            ? source.x
            : handleWest
              ? point.x + amountX * (fixed.x - point.x)
              : fixed.x + amountX * (point.x - fixed.x),
        y:
          amountY === null
            ? source.y
            : handleNorth
              ? point.y + amountY * (fixed.y - point.y)
              : fixed.y + amountY * (point.y - fixed.y),
      };
    }),
  };
}
