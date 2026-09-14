import { toast } from "sonner";
import { zh, type LocaleStrings } from "@/locale";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
}

function getAssetLabel({
	count,
	t,
}: {
	count: number;
	t: LocaleStrings;
}): string {
	return count === 1
		? t["media.upload.asset_singular"]
		: t["media.upload.assets_plural"];
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
	t,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
	/**
	 * Resolved dictionary from the calling React component. This module cannot
	 * use `useLocale`, so callers thread it in. Falls back to the default
	 * dictionary for callers that have no access to one.
	 */
	t?: LocaleStrings;
}) {
	const strings = t ?? zh;
	const run = typeof promise === "function" ? promise : () => promise;
	const assetLabel = getAssetLabel({ count: filesCount, t: strings });
	const toastPromise = toast.promise(async () => {
		await waitForNextPaint();
		return run();
	}, {
		loading: strings["media.upload.uploading"].replace("{label}", assetLabel),
		success: ({ uploadedCount, assetNames }) => {
			if (uploadedCount === 1) {
				const assetName = assetNames?.[0];
				return assetName
					? strings["media.upload.success_single_named"].replace(
							"{name}",
							assetName,
						)
					: strings["media.upload.success_single"];
			}

			if (uploadedCount > 1) {
				return strings["media.upload.success_multiple"].replace(
					"{count}",
					String(uploadedCount),
				);
			}

			return strings["media.upload.none"];
		},
		error: strings["media.upload.failed"].replace("{label}", assetLabel),
	});

	return toastPromise.unwrap();
}
