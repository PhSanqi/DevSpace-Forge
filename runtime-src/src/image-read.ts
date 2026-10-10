import { createRequire } from "node:module";
import { open, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BATCH_COUNT = 8;
export const MAX_IMAGE_BATCH_BYTES = MAX_IMAGE_BYTES;
export const MAX_IMAGE_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_IMAGE_SOURCE_PIXELS = 200_000_000;
export const MAX_DIRECT_IMAGE_DIMENSION = 8192;

const MAX_DERIVED_IMAGES = 8;
const MAX_DETAIL_TILES = MAX_DERIVED_IMAGES - 1;
const runtimeRequire = createRequire(import.meta.url);

const IMAGE_MIME_TYPES = new Map<string, ReadImageResult["mimeType"]>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

export interface ReadImageRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReadImageResult {
  data: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
  role?: "source" | "overview" | "tile";
  region?: ReadImageRegion;
}

export interface ReadImageBatchResult {
  images: ReadImageResult[];
  totalSizeBytes: number;
}

export interface ReadImageModelResult {
  mode: "direct" | "tiled";
  sourceMimeType: ReadImageResult["mimeType"];
  sourceSizeBytes: number;
  width?: number;
  height?: number;
  images: ReadImageResult[];
  totalOutputBytes: number;
}

interface InspectedImageFile {
  path: string;
  mimeType: ReadImageResult["mimeType"];
  sizeBytes: number;
}

interface SharpMetadata {
  format?: string;
  width?: number;
  height?: number;
  autoOrient?: {
    width: number;
    height: number;
  };
}

interface SharpPipeline {
  metadata(): Promise<SharpMetadata>;
  autoOrient(): SharpPipeline;
  extract(region: ReadImageRegion): SharpPipeline;
  resize(options: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }): SharpPipeline;
  flatten(options: { background: string }): SharpPipeline;
  jpeg(options: {
    quality: number;
    chromaSubsampling: "4:4:4";
  }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

type SharpFactory = (
  input: string,
  options?: { limitInputPixels?: number },
) => SharpPipeline;

let cachedSharp: SharpFactory | null | undefined;

function hasExpectedSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
  }
  return buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff;
}

function loadSharp(): SharpFactory | null {
  if (cachedSharp !== undefined) return cachedSharp;
  try {
    const loaded = runtimeRequire("sharp") as SharpFactory | { default?: SharpFactory };
    cachedSharp = typeof loaded === "function" ? loaded : loaded.default ?? null;
  } catch {
    cachedSharp = null;
  }
  return cachedSharp;
}

async function inspectImageFile(
  path: string,
  toolName: "read_image" | "read_images",
  maxSizeBytes: number,
): Promise<InspectedImageFile> {
  const extension = extname(path).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) {
    throw new Error(`${toolName} only supports .jpg, .jpeg, and .png files`);
  }

  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${toolName} target is not a regular file`);
  if (metadata.size > maxSizeBytes) {
    throw new Error(`${toolName} file exceeds ${maxSizeBytes} bytes`);
  }

  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (!hasExpectedSignature(header.subarray(0, bytesRead), mimeType)) {
      throw new Error(`${toolName} file contents do not match ${mimeType}`);
    }
  } finally {
    await handle.close();
  }

  return { path, mimeType, sizeBytes: metadata.size };
}

async function readInspectedImage(
  inspected: InspectedImageFile,
): Promise<ReadImageResult> {
  const buffer = await readFile(inspected.path);
  if (!hasExpectedSignature(buffer, inspected.mimeType)) {
    throw new Error(`image file contents do not match ${inspected.mimeType}`);
  }

  return {
    data: buffer.toString("base64"),
    mimeType: inspected.mimeType,
    sizeBytes: buffer.byteLength,
    role: "source",
  };
}

async function imageDimensions(
  sharp: SharpFactory,
  inspected: InspectedImageFile,
): Promise<{ width: number; height: number }> {
  const metadata = await sharp(inspected.path, {
    limitInputPixels: MAX_IMAGE_SOURCE_PIXELS,
  }).metadata();
  const expectedFormat = inspected.mimeType === "image/png" ? "png" : "jpeg";
  if (metadata.format && metadata.format !== expectedFormat) {
    throw new Error(`read_image decoded format ${metadata.format} does not match ${inspected.mimeType}`);
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new Error("read_image could not determine image dimensions");
  if (width * height > MAX_IMAGE_SOURCE_PIXELS) {
    throw new Error(`read_image image exceeds ${MAX_IMAGE_SOURCE_PIXELS} source pixels`);
  }
  return { width, height };
}

function chooseTileGrid(width: number, height: number): { columns: number; rows: number } {
  let best = { columns: 1, rows: 2, score: Number.POSITIVE_INFINITY };
  for (let rows = 1; rows <= MAX_DETAIL_TILES; rows += 1) {
    for (let columns = 1; columns <= MAX_DETAIL_TILES; columns += 1) {
      const count = rows * columns;
      if (count < 2 || count > MAX_DETAIL_TILES) continue;
      const tileAspect = (width / columns) / (height / rows);
      const aspectPenalty = Math.abs(Math.log(tileAspect));
      const unusedPenalty = (MAX_DETAIL_TILES - count) * 0.08;
      const score = aspectPenalty + unusedPenalty;
      if (score < best.score) best = { columns, rows, score };
    }
  }
  return { columns: best.columns, rows: best.rows };
}

function tileRegions(width: number, height: number): ReadImageRegion[] {
  const { columns, rows } = chooseTileGrid(width, height);
  const regions: ReadImageRegion[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const baseLeft = Math.floor((width * column) / columns);
      const baseRight = Math.floor((width * (column + 1)) / columns);
      const baseTop = Math.floor((height * row) / rows);
      const baseBottom = Math.floor((height * (row + 1)) / rows);
      const overlapX = Math.min(192, Math.floor((baseRight - baseLeft) * 0.08));
      const overlapY = Math.min(192, Math.floor((baseBottom - baseTop) * 0.08));
      const left = column === 0 ? baseLeft : Math.max(0, baseLeft - overlapX);
      const right = column === columns - 1 ? baseRight : Math.min(width, baseRight + overlapX);
      const top = row === 0 ? baseTop : Math.max(0, baseTop - overlapY);
      const bottom = row === rows - 1 ? baseBottom : Math.min(height, baseBottom + overlapY);
      regions.push({
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      });
    }
  }
  return regions.slice(0, MAX_DETAIL_TILES);
}

async function renderDerivedJpeg(
  sharp: SharpFactory,
  inspected: InspectedImageFile,
  maxDimension: number,
  quality: number,
  role: "overview" | "tile",
  region?: ReadImageRegion,
): Promise<ReadImageResult> {
  let pipeline = sharp(inspected.path, {
    limitInputPixels: MAX_IMAGE_SOURCE_PIXELS,
  }).autoOrient();
  if (region) pipeline = pipeline.extract(region);
  const buffer = await pipeline
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    data: buffer.toString("base64"),
    mimeType: "image/jpeg",
    sizeBytes: buffer.byteLength,
    role,
    region,
  };
}

async function renderTiledImage(
  sharp: SharpFactory,
  inspected: InspectedImageFile,
  width: number,
  height: number,
): Promise<ReadImageModelResult> {
  const regions = tileRegions(width, height);
  const profiles = [
    { maxDimension: 1800, quality: 88 },
    { maxDimension: 1500, quality: 84 },
    { maxDimension: 1200, quality: 80 },
    { maxDimension: 960, quality: 76 },
  ] as const;

  for (const profile of profiles) {
    const images: ReadImageResult[] = [
      await renderDerivedJpeg(
        sharp,
        inspected,
        profile.maxDimension,
        profile.quality,
        "overview",
      ),
    ];
    for (const region of regions) {
      images.push(await renderDerivedJpeg(
        sharp,
        inspected,
        profile.maxDimension,
        profile.quality,
        "tile",
        region,
      ));
    }
    const totalOutputBytes = images.reduce((sum, image) => sum + image.sizeBytes, 0);
    if (totalOutputBytes <= MAX_IMAGE_BYTES) {
      return {
        mode: "tiled",
        sourceMimeType: inspected.mimeType,
        sourceSizeBytes: inspected.sizeBytes,
        width,
        height,
        images,
        totalOutputBytes,
      };
    }
  }

  throw new Error(`read_image derived image payload exceeds ${MAX_IMAGE_BYTES} bytes`);
}

export async function readImageForModel(path: string): Promise<ReadImageModelResult> {
  const inspected = await inspectImageFile(path, "read_image", MAX_IMAGE_SOURCE_BYTES);
  const sharp = loadSharp();
  let dimensions: { width: number; height: number } | undefined;
  if (sharp) {
    dimensions = await imageDimensions(sharp, inspected);
  }

  const needsTiling = inspected.sizeBytes > MAX_IMAGE_BYTES
    || (dimensions !== undefined
      && (dimensions.width > MAX_DIRECT_IMAGE_DIMENSION
        || dimensions.height > MAX_DIRECT_IMAGE_DIMENSION));

  if (!needsTiling) {
    const image = await readInspectedImage(inspected);
    return {
      mode: "direct",
      sourceMimeType: inspected.mimeType,
      sourceSizeBytes: inspected.sizeBytes,
      width: dimensions?.width,
      height: dimensions?.height,
      images: [image],
      totalOutputBytes: image.sizeBytes,
    };
  }

  if (!sharp) {
    throw new Error("read_image large-image backend is unavailable; packaged Runtime must include sharp");
  }
  const resolvedDimensions = dimensions ?? await imageDimensions(sharp, inspected);
  return renderTiledImage(
    sharp,
    inspected,
    resolvedDimensions.width,
    resolvedDimensions.height,
  );
}

export async function readImageFile(path: string): Promise<ReadImageResult> {
  return readInspectedImage(await inspectImageFile(path, "read_image", MAX_IMAGE_BYTES));
}

export async function readImageFiles(paths: string[]): Promise<ReadImageBatchResult> {
  if (paths.length === 0) {
    throw new Error("read_images requires at least one image path");
  }
  if (paths.length > MAX_IMAGE_BATCH_COUNT) {
    throw new Error(`read_images supports at most ${MAX_IMAGE_BATCH_COUNT} images per call`);
  }

  const inspected: InspectedImageFile[] = [];
  let totalSizeBytes = 0;
  for (const path of paths) {
    const image = await inspectImageFile(path, "read_images", MAX_IMAGE_BYTES);
    totalSizeBytes += image.sizeBytes;
    if (totalSizeBytes > MAX_IMAGE_BATCH_BYTES) {
      throw new Error(`read_images total image payload exceeds ${MAX_IMAGE_BATCH_BYTES} bytes`);
    }
    inspected.push(image);
  }

  return {
    images: await Promise.all(inspected.map((image) => readInspectedImage(image))),
    totalSizeBytes,
  };
}
