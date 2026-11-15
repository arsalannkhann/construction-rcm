/** pdf.js ships no types for its worker module. The app only hands it to pdf.js (see pdf-text.ts). */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
