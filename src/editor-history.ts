import {
  cloneDocument,
  FwbDocumentV1,
  HISTORY_LIMIT,
} from "./project-document";

export class DocumentHistory {
  private past: FwbDocumentV1[] = [];
  private future: FwbDocumentV1[] = [];
  private present: FwbDocumentV1;

  constructor(document: FwbDocumentV1) {
    this.present = cloneDocument(document);
  }

  get current(): FwbDocumentV1 {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  preview(document: FwbDocumentV1): void {
    this.present = document;
  }

  commit(document: FwbDocumentV1, previous = this.present): void {
    this.past.push(cloneDocument(previous));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.present = cloneDocument(document);
    this.future = [];
  }

  replace(document: FwbDocumentV1): void {
    this.present = cloneDocument(document);
    this.past = [];
    this.future = [];
  }

  undo(): FwbDocumentV1 | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(cloneDocument(this.present));
    this.present = previous;
    return this.present;
  }

  redo(): FwbDocumentV1 | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(cloneDocument(this.present));
    this.present = next;
    return this.present;
  }
}

