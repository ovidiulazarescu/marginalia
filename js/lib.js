// Central place for third-party modules, pinned to exact versions.
// Heavy libraries (pdf.js, pdf-lib, JSZip) load lazily on first use.
export {
  h, html, render, Component, createContext,
  useState, useReducer, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext,
} from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
export { getStroke } from 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.2/+esm';
export { default as MiniSearch } from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.0/+esm';
export { diffWords } from 'https://cdn.jsdelivr.net/npm/diff@5.2.0/+esm';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
let pdfjsP;
export function loadPdfjs() {
  return pdfjsP ||= import(PDFJS + 'pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return m;
  });
}
let pdfLibP;
export const loadPdfLib = () => (pdfLibP ||= import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm'));
let zipP;
export const loadJSZip = () => (zipP ||= import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm').then((m) => m.default || m));
