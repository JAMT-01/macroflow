import type { CaptureMetadata } from "./types";

type PreparedPhoto = { file: File; metadata: CaptureMetadata };

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This photo format could not be opened. Try taking a new photo with the camera.")); };
    image.src = url;
  });
}

function analyzePixels(data: Uint8ClampedArray, width: number, height: number) {
  const pixels = width * height;
  const gray = new Float32Array(pixels);
  let sum = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const value = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    gray[index] = value;
    sum += value;
  }
  const mean = sum / Math.max(1, pixels);
  let variance = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  const contrast = Math.sqrt(variance / Math.max(1, pixels)) / 128;

  let laplacianSum = 0;
  let laplacianSquared = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian = gray[index - 1] + gray[index + 1] + gray[index - width] + gray[index + width] - 4 * gray[index];
      laplacianSum += laplacian;
      laplacianSquared += laplacian * laplacian;
      laplacianCount += 1;
    }
  }
  const laplacianMean = laplacianSum / Math.max(1, laplacianCount);
  const laplacianVariance = laplacianSquared / Math.max(1, laplacianCount) - laplacianMean ** 2;
  return {
    brightness: mean / 255,
    contrast: Math.min(1, contrast),
    sharpness: Math.min(1, Math.max(0, laplacianVariance) / 650)
  };
}

export async function prepareMealPhoto(source: File): Promise<PreparedPhoto> {
  const image = await loadImage(source);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error("The photo has no readable dimensions.");

  const sampleScale = Math.min(1, 256 / Math.max(sourceWidth, sourceHeight));
  const sample = document.createElement("canvas");
  sample.width = Math.max(1, Math.round(sourceWidth * sampleScale));
  sample.height = Math.max(1, Math.round(sourceHeight * sampleScale));
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) throw new Error("Photo processing is not available in this browser.");
  sampleContext.drawImage(image, 0, 0, sample.width, sample.height);
  const pixelMetrics = analyzePixels(sampleContext.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);

  const shortSide = Math.min(sourceWidth, sourceHeight);
  const resolutionScore = Math.min(1, shortSide / 1000);
  const exposureScore = pixelMetrics.brightness < 0.18
    ? pixelMetrics.brightness / 0.18
    : pixelMetrics.brightness > 0.9
      ? Math.max(0, (1 - pixelMetrics.brightness) / 0.1)
      : 1;
  const contrastScore = Math.min(1, pixelMetrics.contrast / 0.22);
  const sharpnessScore = Math.min(1, pixelMetrics.sharpness / 0.18);
  const qualityScore = Math.round(100 * (resolutionScore * 0.2 + exposureScore * 0.3 + contrastScore * 0.2 + sharpnessScore * 0.3));
  const issues: string[] = [];
  if (shortSide < 900) issues.push("Low resolution");
  if (pixelMetrics.brightness < 0.18) issues.push("Too dark");
  if (pixelMetrics.brightness > 0.9) issues.push("Overexposed");
  if (pixelMetrics.contrast < 0.1) issues.push("Low contrast");
  if (pixelMetrics.sharpness < 0.07) issues.push("Possibly blurry");

  const outputScale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(sourceWidth * outputScale));
  output.height = Math.max(1, Math.round(sourceHeight * outputScale));
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("Photo processing is not available in this browser.");
  outputContext.drawImage(image, 0, 0, output.width, output.height);
  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("The photo could not be prepared for upload.");

  return {
    file: new File([blob], `${source.name.replace(/\.[^.]+$/, "") || "meal"}.jpg`, { type: "image/jpeg", lastModified: Date.now() }),
    metadata: {
      width: sourceWidth,
      height: sourceHeight,
      brightness: Math.round(pixelMetrics.brightness * 1000) / 1000,
      contrast: Math.round(pixelMetrics.contrast * 1000) / 1000,
      sharpness: Math.round(pixelMetrics.sharpness * 1000) / 1000,
      qualityScore,
      issues
    }
  };
}
