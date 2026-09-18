import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map<string, ReadImageResult["mimeType"]>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

export interface ReadImageResult {
  data: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
}

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

export async function readImageFile(path: string): Promise<ReadImageResult> {
  const extension = extname(path).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) {
    throw new Error("read_image only supports .jpg, .jpeg, and .png files");
  }

  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("read_image target is not a regular file");
  if (metadata.size > MAX_IMAGE_BYTES) {
    throw new Error(`read_image file exceeds ${MAX_IMAGE_BYTES} bytes`);
  }

  const buffer = await readFile(path);
  if (!hasExpectedSignature(buffer, mimeType)) {
    throw new Error(`read_image file contents do not match ${mimeType}`);
  }

  return {
    data: buffer.toString("base64"),
    mimeType,
    sizeBytes: buffer.byteLength,
  };
}
