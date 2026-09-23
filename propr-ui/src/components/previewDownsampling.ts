/**
 * The backing store is drawn at the display's pixel density, capped so a 4x
 * phone screen cannot demand 16x the pixels. Shared with the preview cache so a
 * cached thumbnail is keyed by the density it was actually rendered at.
 */
export function previewPixelRatio(): number {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 4);
}

/**
 * Browsers resample large downscales in a single pass, which aliases text and
 * fine UI lines in 4K captures shown at thumbnail size. Halve repeatedly so each
 * pass stays within the filter's support, then draw the final contain-fit size
 * at the display's pixel density. Returns false when a canvas is unavailable.
 */
export function downsampleToCanvas(sourceImg: HTMLImageElement, canvas: HTMLCanvasElement, targetWidth: number, targetHeight: number): boolean {
  const naturalWidth = sourceImg.naturalWidth;
  const naturalHeight = sourceImg.naturalHeight;
  if (!naturalWidth || !naturalHeight || targetWidth <= 0 || targetHeight <= 0) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight, 1);
  const cssWidth = Math.max(1, Math.round(naturalWidth * scale));
  const cssHeight = Math.max(1, Math.round(naturalHeight * scale));
  const ratio = previewPixelRatio();
  const width = Math.min(naturalWidth, Math.round(cssWidth * ratio));
  const height = Math.min(naturalHeight, Math.round(cssHeight * ratio));

  let source: CanvasImageSource = sourceImg;
  let sourceWidth = naturalWidth;
  let sourceHeight = naturalHeight;
  while (sourceWidth / 2 >= width && sourceHeight / 2 >= height) {
    const step = document.createElement('canvas');
    step.width = Math.floor(sourceWidth / 2);
    step.height = Math.floor(sourceHeight / 2);
    const stepContext = step.getContext('2d');
    if (!stepContext) break;
    stepContext.imageSmoothingEnabled = true;
    stepContext.imageSmoothingQuality = 'high';
    stepContext.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, step.width, step.height);
    source = step;
    sourceWidth = step.width;
    sourceHeight = step.height;
  }

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  return true;
}
