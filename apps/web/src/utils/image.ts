"use client";

/**
 * Client-side image downscale for vendor payloads.
 *
 * A multi-image prompt carries every reference as a data URL in one request
 * body — raw photos would blow it up to tens of MB. Resampling to a max edge
 * and re-encoding as JPEG keeps each reference at a few hundred KB.
 */

export const IMG2IMG_MAX_EDGE = 1536;
export const IMG2IMG_JPEG_QUALITY = 0.9;

export async function compressImageToDataUrl({
	file,
	maxEdge = IMG2IMG_MAX_EDGE,
	quality = IMG2IMG_JPEG_QUALITY,
}: {
	file: File;
	maxEdge?: number;
	quality?: number;
}): Promise<string> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("canvas 2d context unavailable");
		}
		ctx.drawImage(bitmap, 0, 0, width, height);
		return canvas.toDataURL("image/jpeg", quality);
	} finally {
		bitmap.close();
	}
}
