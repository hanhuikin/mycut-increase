"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PanelView } from "./base-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { useLocale } from "@/locale/locale-context";
import type { LocaleKey } from "@/locale";
import { generateVideo, type VideoGenResult } from "@/services/ai-video/generate";
import {
	applyCameraMovement,
	CAMERA_MOVEMENTS,
	resolveModelDescription,
	resolveModelLabel,
	type CameraMovement,
	type VideoGenMode,
} from "@/services/ai-video/models";
import { readVideoFile } from "@/media/mediabunny";
import {
	estimateCost,
	useBilling,
} from "@/services/billing/client";
import { BalanceChip, RedeemForm } from "@/components/billing/balance-chip";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { generateUUID } from "@/utils/id";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ImageAdd02Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";

type Duration = 4 | 5 | 8 | 10 | 12 | 15 | "auto";
type Resolution = "480p" | "720p" | "1080p";
type AspectRatio =
	"16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "21:9" | "adaptive";
type ShotDuration = 4 | 5 | 8 | 10;

interface Shot {
	id: string;
	prompt: string;
	duration: ShotDuration;
	/** Image-to-video storyboard: each shot carries its own start frame. */
	imageDataUrl?: string;
	imageName?: string;
}

/**
 * A run the server refused before it spent anything: no credits, a Pro-only
 * model, or the model's daily cap. Carries the reason so the runner can answer
 * with the credit dialog or the matching message.
 */
class RefusedError extends Error {
	constructor(
		readonly code: string,
		readonly cost?: number,
		readonly balance?: number,
	) {
		super(code);
	}
}

const REFUSAL_KEY: Record<string, LocaleKey> = {
	pro_required: "billing.error.pro_required",
	daily_limit: "billing.error.daily_limit",
	unauthenticated: "billing.error.unauthenticated",
};

/** Turns a generation that never started into the error the runner expects. */
function generationError({
	result,
	fallback,
}: {
	result: VideoGenResult;
	fallback: string;
}): Error {
	return result.code
		? new RefusedError(result.code, result.cost, result.balance)
		: new Error(result.error ?? fallback);
}

const DURATIONS: Duration[] = [4, 5, 8, 10, 12, 15, "auto"];
const SHOT_DURATIONS: ShotDuration[] = [4, 5, 8, 10];
const RESOLUTIONS: { value: Resolution; label: string; price: string }[] = [
	{ value: "720p", label: "720p", price: "~$0.10/s" },
	{ value: "1080p", label: "1080p", price: "~$0.25/s" },
];
const ASPECT_RATIOS: { value: AspectRatio; labelKey: LocaleKey }[] = [
	{ value: "16:9", labelKey: "ai_video.aspect_16_9" },
	{ value: "9:16", labelKey: "ai_video.aspect_9_16" },
	{ value: "1:1", labelKey: "ai_video.aspect_1_1" },
	{ value: "4:3", labelKey: "ai_video.aspect_4_3" },
	{ value: "3:4", labelKey: "ai_video.aspect_3_4" },
	{ value: "21:9", labelKey: "ai_video.aspect_21_9" },
	{ value: "adaptive", labelKey: "ai_video.aspect_adaptive" },
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const SELECT_CLASSES =
	"h-9 w-full rounded-md border bg-background px-3 text-sm";

function createShot(): Shot {
	return { id: generateUUID(), prompt: "", duration: 5 };
}

/** Type/size rules shared by the single image picker and the per-shot pickers. */
const validateImageFile = (file: File): LocaleKey | null => {
	if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
		return "ai_video.image_invalid_type";
	}
	if (file.size > MAX_IMAGE_BYTES) {
		return "ai_video.image_too_large";
	}
	return null;
};

const readImageAsDataUrl = ({ file }: { file: File }): Promise<string | null> =>
	new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () =>
			resolve(typeof reader.result === "string" ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});

export function AIVideoView() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const { t } = useLocale();

	const [mode, setMode] = useState<VideoGenMode>("text-to-video");
	const [modelId, setModelId] = useState<string | null>(null);
	const [duration, setDuration] = useState<Duration>("auto");
	const [resolution, setResolution] = useState<Resolution>("720p");
	const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
	const [generateAudio, setGenerateAudio] = useState(false);

	const [prompt, setPrompt] = useState("");

	const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
	const [imageName, setImageName] = useState("");
	const [motionPrompt, setMotionPrompt] = useState("");
	const imageInputRef = useRef<HTMLInputElement>(null);

	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [cameraMovement, setCameraMovement] = useState<CameraMovement>("auto");
	const [storyboardEnabled, setStoryboardEnabled] = useState(false);
	const [shots, setShots] = useState<Shot[]>(() => [createShot()]);
	/** Which storyboard shot the shared per-shot file input is picking for. */
	const [pendingImageShotId, setPendingImageShotId] = useState<string | null>(
		null,
	);
	const shotImageInputRef = useRef<HTMLInputElement>(null);

	const [isGenerating, setIsGenerating] = useState(false);
	const [progress, setProgress] = useState("");

	const billing = useBilling();

	/** Video models the billing API exposes for the current mode. */
	const availableModels = useMemo(
		() =>
			[...billing.models.values()].filter(
				(model) => model.kind === "video" && model.modes.includes(mode),
			),
		[billing.models, mode],
	);
	const selectedModel =
		availableModels.find((model) => model.id === modelId) ??
		availableModels[0] ??
		null;
	const billingModel = selectedModel;

	// The catalogue arrives asynchronously and differs per mode, so re-validate
	// the selection whenever either changes.
	useEffect(() => {
		if (availableModels.length === 0) return;
		if (!availableModels.some((model) => model.id === modelId)) {
			setModelId(availableModels[0].id);
		}
	}, [availableModels, modelId]);

	const proLocked =
		billingModel?.requiresPro === true &&
		billing.plan !== "pro" &&
		!billing.granted.includes(billingModel.id);
	const isStoryboard = storyboardEnabled;
	const isImageStoryboard = mode === "image-to-video" && isStoryboard;
	const totalShotSeconds = shots.reduce((sum, shot) => sum + shot.duration, 0);
	const [insufficient, setInsufficient] = useState<{
		cost: number;
		balance: number;
	} | null>(null);

	/** Estimated points for the current single-generation settings. */
	const estimate =
		billingModel && typeof duration === "number"
			? estimateCost({
					model: billingModel,
					resolution,
					seconds: duration,
				})
			: null;

	/**
	 * Runs one generation and keeps the UI honest about its cost. The charge is
	 * the server's: it froze the estimate when the job was submitted, so success
	 * only needs the balance refreshed. A refusal — no credits, Pro-only, over
	 * the model's daily cap — comes back as a code and is answered here.
	 */
	const runGeneration = async ({
		run,
	}: {
		run: () => Promise<void>;
	}): Promise<boolean> => {
		try {
			await run();
			await billing.refreshBalance();
			return true;
		} catch (error) {
			if (error instanceof RefusedError && error.code === "insufficient") {
				setInsufficient({
					cost: error.cost ?? 0,
					balance: error.balance ?? 0,
				});
				return false;
			}
			if (error instanceof RefusedError) {
				const key = REFUSAL_KEY[error.code];
				if (key) {
					toast.error(t[key]);
					return false;
				}
			}
			throw error;
		}
	};

	const handleModeChange = (nextMode: string) => {
		// The effect above re-selects a valid model for the new mode.
		setMode(nextMode as VideoGenMode);
	};

	const handleImagePick = async (file: File | undefined) => {
		if (!file) return;

		const errorKey = validateImageFile(file);
		if (errorKey) {
			toast.error(t[errorKey]);
			return;
		}

		const dataUrl = await readImageAsDataUrl({ file });
		if (!dataUrl) {
			toast.error(t["ai_video.image_read_failed"]);
			return;
		}

		setImageDataUrl(dataUrl);
		setImageName(file.name);
	};

	/** Reads a picked start frame for one storyboard shot. */
	const handleShotImagePick = async (file: File | undefined) => {
		if (!file || !pendingImageShotId) return;

		const errorKey = validateImageFile(file);
		if (errorKey) {
			toast.error(t[errorKey]);
			return;
		}

		const dataUrl = await readImageAsDataUrl({ file });
		if (!dataUrl) {
			toast.error(t["ai_video.image_read_failed"]);
			return;
		}

		updateShot({
			id: pendingImageShotId,
			changes: { imageDataUrl: dataUrl, imageName: file.name },
		});
	};

	const openShotImagePicker = ({ id }: { id: string }) => {
		setPendingImageShotId(id);
		shotImageInputRef.current?.click();
	};

	const updateShot = ({
		id,
		changes,
	}: {
		id: string;
		changes: Partial<Omit<Shot, "id">>;
	}) => {
		setShots((current) =>
			current.map((shot) => (shot.id === id ? { ...shot, ...changes } : shot)),
		);
	};

	const removeShot = ({ id }: { id: string }) => {
		if (shots.length <= 1) {
			toast.error(t["ai_video.storyboard_min"]);
			return;
		}
		setShots((current) => current.filter((shot) => shot.id !== id));
	};

	/**
	 * Pulls the finished video through the download proxy, registers it as a media
	 * asset and drops it on the timeline. Returns the clip length so a storyboard
	 * run can lay the next shot down after this one.
	 */
	const importGeneratedVideo = async ({
		videoUrl,
		name,
		startSeconds,
		fallbackSeconds,
	}: {
		videoUrl: string;
		name: string;
		startSeconds: number;
		fallbackSeconds: number;
	}): Promise<number> => {
		if (!activeProject) {
			throw new Error(t["ai_video.no_project"]);
		}

		setProgress(t["ai_video.downloading"]);
		// Proxied server-side: the TOS URLs carry no CORS headers.
		const proxyUrl = `/api/media/download?url=${encodeURIComponent(videoUrl)}`;
		const response = await fetch(proxyUrl);
		if (!response.ok) {
			throw new Error(
				t["ai_video.download_failed"].replace(
					"{status}",
					String(response.status),
				),
			);
		}

		const blob = await response.blob();
		const file = new File([blob], `${name}.mp4`, { type: "video/mp4" });

		let thumbnailUrl: string | undefined;
		let videoDuration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		try {
			const videoData = await readVideoFile({ file });
			thumbnailUrl = videoData.thumbnailUrl ?? undefined;
			videoDuration = videoData.duration;
			width = videoData.width;
			height = videoData.height;
		} catch (err) {
			console.warn("读取视频缩略图失败，将使用占位符:", err);
		}

		const asset = await editor.media.addMediaAsset({
			projectId: activeProject.metadata.id,
			asset: {
				name,
				file,
				type: "video",
				// The preview's scene builder skips assets without one, and storage
				// only mints URLs when re-loading a project — so this run needs it.
				url: URL.createObjectURL(file),
				thumbnailUrl,
				duration: videoDuration,
				width,
				height,
			},
		});

		const clipSeconds = videoDuration ?? fallbackSeconds;

		if (asset) {
			editor.timeline.insertElement({
				element: buildElementFromMedia({
					mediaId: asset.id,
					mediaType: "video",
					name,
					duration: mediaTimeFromSeconds({ seconds: clipSeconds }),
					startTime: mediaTimeFromSeconds({ seconds: startSeconds }),
				}),
				placement: { mode: "auto", trackType: "video" },
			});
		}

		return clipSeconds;
	};

	const runStoryboard = async (): Promise<void> => {
		if (isImageStoryboard) {
			// 图生视频分镜：每个镜头都必须有起始帧；运动描述可留空（与单图模式一致，走兜底指令）。
			const missingImageIndex = shots.findIndex((shot) => !shot.imageDataUrl);
			if (missingImageIndex !== -1) {
				toast.error(
					t["ai_video.storyboard_no_image"].replace(
						"{index}",
						String(missingImageIndex + 1),
					),
				);
				return;
			}
		} else {
			const emptyIndex = shots.findIndex((shot) => !shot.prompt.trim());
			if (emptyIndex !== -1) {
				toast.error(
					t["ai_video.storyboard_empty_shot"].replace(
						"{index}",
						String(emptyIndex + 1),
					),
				);
				return;
			}
		}

		let startSeconds = 0;
		let successCount = 0;
		const failures: string[] = [];

		for (const [index, shot] of shots.entries()) {
			setProgress(
				t["ai_video.storyboard_progress"]
					.replace("{current}", String(index + 1))
					.replace("{total}", String(shots.length)),
			);

			try {
				// 图生视频分镜的空描述与单图模式一致：发一条兜底指令，方舟拒绝空 prompt。
				const shotPrompt = isImageStoryboard
					? shot.prompt.trim() || t["ai_video.image_default_prompt"]
					: shot.prompt.trim();

				const ran = await runGeneration({
					run: async () => {
						const result = await generateVideo({
							prompt: applyCameraMovement({
								prompt: shotPrompt,
								movement: cameraMovement,
							}),
							duration: shot.duration,
							resolution,
							aspectRatio,
							generateAudio: selectedModel?.supportsAudio
								? generateAudio
								: false,
							modelId: selectedModel?.id ?? "",
							imageUrl: isImageStoryboard ? shot.imageDataUrl : undefined,
							onProgress: (msg) =>
								setProgress(
									`${t["ai_video.storyboard_progress"]
										.replace("{current}", String(index + 1))
										.replace("{total}", String(shots.length))} ${msg}`,
								),
						});

						if (!result.success || !result.videoUrl) {
							throw generationError({
								result,
								fallback: t["ai_video.failed"],
							});
						}

						const clipSeconds = await importGeneratedVideo({
							videoUrl: result.videoUrl,
							name: `${t["ai_video.shot_asset_name"].replace(
								"{index}",
								String(index + 1),
							)}-${Date.now()}`,
							startSeconds,
							fallbackSeconds: shot.duration,
						});

						startSeconds += clipSeconds;
						successCount += 1;
					},
				});
				// 被拒（余额不足 / 需专业版 / 超日限额）：后续镜头同样过不去，直接中止。
				if (!ran) {
					return;
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : t["toast.please_try_again"];
				failures.push(
					t["ai_video.storyboard_shot_failed"]
						.replace("{index}", String(index + 1))
						.replace("{error}", message),
				);
			}
		}

		if (successCount === 0) {
			toast.error(t["ai_video.storyboard_all_failed"], {
				description: failures.join("\n"),
			});
			return;
		}

		if (failures.length > 0) {
			toast.warning(
				t["ai_video.storyboard_partial"]
					.replace("{success}", String(successCount))
					.replace("{total}", String(shots.length)),
				{ description: failures.join("\n") },
			);
			return;
		}

		toast.success(t["ai_video.added_to_timeline"]);
		setShots([createShot()]);
	};

	const runSingleGeneration = async (): Promise<void> => {
		const basePrompt =
			mode === "image-to-video" ? motionPrompt.trim() : prompt.trim();
		const seconds = duration === "auto" ? 5 : duration;

		const ran = await runGeneration({
			run: async () => {
				const result = await generateVideo({
					prompt: applyCameraMovement({
						// Ark rejects an empty prompt, so an image-only run still needs an
						// instruction the model can act on.
						prompt: basePrompt || t["ai_video.image_default_prompt"],
						movement: cameraMovement,
					}),
					duration,
					resolution,
					aspectRatio,
					generateAudio: selectedModel?.supportsAudio ? generateAudio : false,
					modelId: selectedModel?.id ?? "",
					imageUrl:
						mode === "image-to-video" ? (imageDataUrl ?? undefined) : undefined,
					onProgress: (msg) => setProgress(msg),
				});

				if (!result.success || !result.videoUrl) {
					// Thrown so the runner can answer a refusal; the outer
					// handleGenerate catch owns every other failure.
					throw generationError({
						result,
						fallback: t["ai_video.failed"],
					});
				}

				await importGeneratedVideo({
					videoUrl: result.videoUrl,
					name: `${t["ai_video.asset_name"]}-${Date.now()}`,
					startSeconds: 0,
					fallbackSeconds: seconds,
				});

				toast.success(t["ai_video.added_to_timeline"]);
				if (mode === "image-to-video") {
					setMotionPrompt("");
				} else {
					setPrompt("");
				}
			},
		});
		if (!ran) {
			return; // refused — the dialog or toast is already up
		}
	};

	const handleGenerate = async () => {
		if (!activeProject) {
			toast.error(t["ai_video.no_project"]);
			return;
		}
		if (mode === "image-to-video" && !isStoryboard && !imageDataUrl) {
			toast.error(t["ai_video.no_image"]);
			return;
		}
		if (mode === "text-to-video" && !isStoryboard && !prompt.trim()) {
			toast.error(t["ai_video.no_prompt"]);
			return;
		}

		setIsGenerating(true);
		setProgress("");

		try {
			if (isStoryboard) {
				await runStoryboard();
			} else {
				await runSingleGeneration();
			}
		} catch (error) {
			console.error("视频生成失败:", error);
			toast.error(t["ai_video.failed"], {
				description:
					error instanceof Error ? error.message : t["toast.please_try_again"],
			});
		} finally {
			setIsGenerating(false);
			setProgress("");
		}
	};

	const isGenerateDisabled =
		isGenerating ||
		proLocked ||
		// The catalogue loads asynchronously; nothing to run until it lands.
		!selectedModel ||
		(mode === "image-to-video" && !isStoryboard && !imageDataUrl) ||
		(mode === "text-to-video" && !isStoryboard && !prompt.trim());

	const generateLabel = isGenerating
		? progress || t["ai_video.generating"]
		: proLocked
			? t["model.pro_locked"]
			: isStoryboard
				? t["ai_video.storyboard_generate"]
						.replace("{count}", String(shots.length))
						.replace("{duration}", String(totalShotSeconds))
				: t["ai_video.generate"];

	const estimateLine =
		billing.signedIn && billingModel ? (
			<p className="text-muted-foreground text-xs leading-relaxed">
				{billingModel.kind === "local"
					? t["billing.estimate_free"]
					: estimate != null
						? `${t["billing.estimate"].replace("{count}", String(estimate))} · ${t["billing.estimate_note"]}`
						: t["billing.estimate_note"]}
			</p>
		) : null;

	const modelDescription = selectedModel
		? resolveModelDescription(t, selectedModel)
		: null;

	const modelSelect = (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor="ai-video-model">{t["ai_video.model_label"]}</Label>
			{availableModels.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					{billing.loading ? "…" : t["ai_video.no_models"]}
				</p>
			) : (
				<>
					<select
						id="ai-video-model"
						value={selectedModel?.id ?? ""}
						onChange={(e) => setModelId(e.target.value)}
						className={SELECT_CLASSES}
						disabled={isGenerating}
					>
						{availableModels.map((model) => (
							<option key={model.id} value={model.id}>
								{resolveModelLabel(t, model)}
							</option>
						))}
					</select>
					{modelDescription && (
						<p className="text-muted-foreground text-xs leading-relaxed">
							{modelDescription}
						</p>
					)}
				</>
			)}
		</div>
	);

	const resolutionSelect = (
		<div className="flex flex-col gap-1.5">
			<Label>{t["ai_video.resolution"]}</Label>
			<select
				value={resolution}
				onChange={(e) => setResolution(e.target.value as Resolution)}
				className={SELECT_CLASSES}
				disabled={isGenerating}
			>
				{RESOLUTIONS.map((r) => (
					<option key={r.value} value={r.value}>
						{r.label}（{r.price}）
					</option>
				))}
			</select>
		</div>
	);

	const aspectRatioSelect = (
		<div className="flex flex-col gap-1.5">
			<Label>{t["ai_video.aspect_ratio"]}</Label>
			<select
				value={aspectRatio}
				onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
				className={SELECT_CLASSES}
				disabled={isGenerating}
			>
				{ASPECT_RATIOS.map((a) => (
					<option key={a.value} value={a.value}>
						{t[a.labelKey]}
					</option>
				))}
			</select>
		</div>
	);

	const audioToggle = selectedModel?.supportsAudio ? (
		<div className="flex items-center gap-2">
			<input
				id="ai-video-audio"
				type="checkbox"
				checked={generateAudio}
				onChange={(e) => setGenerateAudio(e.target.checked)}
				disabled={isGenerating}
				className="size-4 rounded"
			/>
			<Label htmlFor="ai-video-audio" className="cursor-pointer text-sm">
				{t["ai_video.generate_audio_label"]}
			</Label>
		</div>
	) : null;

	const advancedSection = (
		<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
			<CollapsibleTrigger className="bg-accent hover:bg-accent/70 flex w-full cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm font-medium">
				<span>{t["ai_video.advanced"]}</span>
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className={`size-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col gap-4 rounded-b-md border border-t-0 p-3">
				<div className="flex flex-col gap-1.5">
					<Label>{t["ai_video.camera_movement"]}</Label>
					<select
						value={cameraMovement}
						onChange={(e) =>
							setCameraMovement(e.target.value as CameraMovement)
						}
						className={SELECT_CLASSES}
						disabled={isGenerating}
					>
						{CAMERA_MOVEMENTS.map((movement) => (
							<option key={movement.value} value={movement.value}>
								{t[movement.labelKey]}
							</option>
						))}
					</select>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t["ai_video.camera_hint"]}
					</p>
				</div>

				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2">
						<input
							id="ai-video-storyboard"
							type="checkbox"
							checked={storyboardEnabled}
							onChange={(e) => setStoryboardEnabled(e.target.checked)}
							disabled={isGenerating}
							className="size-4 rounded"
						/>
						<Label
							htmlFor="ai-video-storyboard"
							className="cursor-pointer text-sm font-medium"
						>
							{t["ai_video.storyboard_label"]}
						</Label>
					</div>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t["ai_video.storyboard_hint"]}
					</p>

					<input
						ref={shotImageInputRef}
						type="file"
						accept={ACCEPTED_IMAGE_TYPES.join(",")}
						className="hidden"
						onChange={(e) => {
							handleShotImagePick(e.target.files?.[0]);
							// Reset so re-picking the same file still fires onChange.
							e.target.value = "";
						}}
					/>

					{storyboardEnabled && (
						<div className="flex flex-col gap-2">
							{shots.map((shot, index) => (
								<div
									key={shot.id}
									className="bg-background flex items-start gap-2 rounded-md border p-2"
								>
									<div className="bg-secondary text-secondary-foreground flex size-7 shrink-0 items-center justify-center rounded text-xs font-semibold">
										{index + 1}
									</div>
									<div className="flex min-w-0 flex-1 flex-col gap-2">
										{isImageStoryboard &&
											(shot.imageDataUrl ? (
												<div className="flex items-center gap-2">
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img
														src={shot.imageDataUrl}
														alt={shot.imageName ?? ""}
														className="bg-accent h-12 w-20 rounded border object-contain"
													/>
													<Button
														variant="outline"
														size="sm"
														onClick={() => openShotImagePicker({ id: shot.id })}
														disabled={isGenerating}
													>
														{t["ai_video.storyboard_shot_replace_image"]}
													</Button>
													<Button
														variant="text"
														size="sm"
														className="text-muted-foreground hover:text-destructive !opacity-100"
														onClick={() =>
															updateShot({
																id: shot.id,
																changes: {
																	imageDataUrl: undefined,
																	imageName: undefined,
																},
															})
														}
														disabled={isGenerating}
													>
														{t["ai_video.storyboard_shot_remove_image"]}
													</Button>
												</div>
											) : (
												<Button
													variant="outline"
													size="sm"
													className="w-full border-dashed"
													onClick={() => openShotImagePicker({ id: shot.id })}
													disabled={isGenerating}
												>
													<HugeiconsIcon icon={ImageAdd02Icon} />
													{t["ai_video.storyboard_shot_add_image"]}
												</Button>
											))}
										<input
											type="text"
											value={shot.prompt}
											onChange={(e) =>
												updateShot({
													id: shot.id,
													changes: { prompt: e.target.value },
												})
											}
											placeholder={t["ai_video.storyboard_shot_placeholder"]}
											disabled={isGenerating}
											className="h-8 w-full rounded border bg-transparent px-2 text-sm"
										/>
										<div className="flex items-center gap-2">
											<select
												value={shot.duration}
												onChange={(e) =>
													updateShot({
														id: shot.id,
														changes: {
															duration: Number(e.target.value) as ShotDuration,
														},
													})
												}
												disabled={isGenerating}
												className="h-7 rounded border bg-transparent px-2 text-xs"
											>
												{SHOT_DURATIONS.map((seconds) => (
													<option key={seconds} value={seconds}>
														{seconds} {t["common.seconds"]}
													</option>
												))}
											</select>
											<Button
												variant="text"
												size="sm"
												className="text-muted-foreground hover:text-destructive h-7 !opacity-100"
												onClick={() => removeShot({ id: shot.id })}
												disabled={isGenerating}
											>
												{t["ai_video.storyboard_remove"]}
											</Button>
										</div>
									</div>
								</div>
							))}

							<Button
								variant="outline"
								className="w-full border-dashed"
								onClick={() =>
									setShots((current) => [...current, createShot()])
								}
								disabled={isGenerating}
							>
								<HugeiconsIcon icon={PlusSignIcon} />
								{t["ai_video.storyboard_add"]}
							</Button>

							<p className="text-muted-foreground text-xs leading-relaxed">
								{t["ai_video.storyboard_transition_hint"]}
							</p>
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);

	return (
		<PanelView
			title={t["tab.ai_video"]}
			actions={
				billing.signedIn ? (
					<BalanceChip
						balance={billing.balance}
						onRedeemed={billing.refreshBalance}
					/>
				) : undefined
			}
		>
			<Tabs
				value={mode}
				onValueChange={handleModeChange}
				variant="underline"
				className="flex flex-col"
			>
				<TabsList>
					<TabsTrigger value="text-to-video" disabled={isGenerating}>
						{t["ai_video.tab_text"]}
					</TabsTrigger>
					<TabsTrigger value="image-to-video" disabled={isGenerating}>
						{t["ai_video.tab_image"]}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="text-to-video" className="mt-0 px-0">
					<div className="flex flex-col gap-4 p-3">
						{modelSelect}

						{!isStoryboard && (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="ai-video-prompt">
									{t["ai_video.prompt_label"]}
								</Label>
								<textarea
									id="ai-video-prompt"
									className="min-h-[100px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
									placeholder={t["ai_video.prompt_placeholder"]}
									value={prompt}
									onChange={(e) => setPrompt(e.target.value)}
									rows={4}
									disabled={isGenerating}
								/>
							</div>
						)}

						{!isStoryboard && (
							<div className="flex flex-col gap-1.5">
								<Label>{t["ai_video.duration"]}</Label>
								<select
									value={String(duration)}
									onChange={(e) =>
										setDuration(
											e.target.value === "auto"
												? "auto"
												: (Number(e.target.value) as Duration),
										)
									}
									className={SELECT_CLASSES}
									disabled={isGenerating}
								>
									{DURATIONS.filter(
										(d) =>
											d === "auto" ||
											!selectedModel ||
											d <= selectedModel.maxDuration,
									).map((d) => (
										<option key={String(d)} value={String(d)}>
											{d === "auto"
												? t["ai_video.duration_auto"]
												: `${d} ${t["common.seconds"]}`}
										</option>
									))}
								</select>
							</div>
						)}

						{resolutionSelect}
						{aspectRatioSelect}
						{audioToggle}
						{advancedSection}

						{estimateLine}

						<Button
							onClick={handleGenerate}
							disabled={isGenerateDisabled}
							className="w-full"
						>
							{generateLabel}
						</Button>

						<p className="text-muted-foreground text-xs leading-relaxed">
							{t["ai_video.provider_primary"]}
							{t["ai_video.provider_ark"]} → {t["ai_video.provider_fallback"]}
							{t["ai_video.provider_atlas"]} →{" "}
							{t["ai_video.provider_wavespeed"]}
							{t["ai_video.hint"]}
						</p>
					</div>
				</TabsContent>

				<TabsContent value="image-to-video" className="mt-0 px-0">
					<div className="flex flex-col gap-4 p-3">
						{modelSelect}

						{!isStoryboard && (
							<>
								<div className="flex flex-col gap-1.5">
									<Label>{t["ai_video.image_label"]}</Label>
									<input
										ref={imageInputRef}
										type="file"
										accept={ACCEPTED_IMAGE_TYPES.join(",")}
										className="hidden"
										onChange={(e) => {
											handleImagePick(e.target.files?.[0]);
											// Reset so re-picking the same file still fires onChange.
											e.target.value = "";
										}}
									/>

									{imageDataUrl ? (
										<div className="flex flex-col gap-2">
											<div className="bg-accent relative overflow-hidden rounded-md border">
												{/* eslint-disable-next-line @next/next/no-img-element */}
												<img
													src={imageDataUrl}
													alt={imageName}
													className="max-h-40 w-full object-contain"
												/>
											</div>
											<div className="flex items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													onClick={() => imageInputRef.current?.click()}
													disabled={isGenerating}
												>
													{t["ai_video.image_replace"]}
												</Button>
												<Button
													variant="text"
													size="sm"
													className="text-muted-foreground hover:text-destructive !opacity-100"
													onClick={() => {
														setImageDataUrl(null);
														setImageName("");
													}}
													disabled={isGenerating}
												>
													{t["ai_video.image_remove"]}
												</Button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => imageInputRef.current?.click()}
											disabled={isGenerating}
											className="hover:border-primary hover:bg-secondary/40 flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 transition-colors"
										>
											<HugeiconsIcon
												icon={ImageAdd02Icon}
												className="text-muted-foreground size-8"
											/>
											<span className="text-muted-foreground text-sm">
												{t["ai_video.image_upload_cta"]}
											</span>
											<span className="text-muted-foreground text-xs">
												{t["ai_video.image_upload_hint"]}
											</span>
										</button>
									)}
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="ai-video-motion">
										{t["ai_video.motion_prompt_label"]}
									</Label>
									<textarea
										id="ai-video-motion"
										className="min-h-[72px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
										placeholder={t["ai_video.motion_prompt_placeholder"]}
										value={motionPrompt}
										onChange={(e) => setMotionPrompt(e.target.value)}
										rows={3}
										disabled={isGenerating}
									/>
									<p className="text-muted-foreground text-xs leading-relaxed">
										{t["ai_video.motion_prompt_hint"]}
									</p>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label>{t["ai_video.duration"]}</Label>
									<select
										value={String(duration)}
										onChange={(e) =>
											setDuration(
												e.target.value === "auto"
													? "auto"
													: (Number(e.target.value) as Duration),
											)
										}
										className={SELECT_CLASSES}
										disabled={isGenerating}
									>
										{DURATIONS.filter(
											(d) =>
												d === "auto" ||
												!selectedModel ||
												d <= selectedModel.maxDuration,
										).map((d) => (
											<option key={String(d)} value={String(d)}>
												{d === "auto"
													? t["ai_video.duration_auto"]
													: `${d} ${t["common.seconds"]}`}
											</option>
										))}
									</select>
								</div>
							</>
						)}

						{resolutionSelect}
						{aspectRatioSelect}
						{audioToggle}
						{advancedSection}

						{estimateLine}

						<Button
							onClick={handleGenerate}
							disabled={isGenerateDisabled}
							className="w-full"
						>
							{generateLabel}
						</Button>

						<p className="text-muted-foreground text-xs leading-relaxed">
							{t["ai_video.image_only_ark"]}
						</p>
					</div>
				</TabsContent>
			</Tabs>

			{insufficient && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onClick={() => setInsufficient(null)}
				>
					<div
						className="bg-card border-border mx-4 w-full max-w-xs rounded-xl border p-4"
						onClick={(event) => event.stopPropagation()}
					>
						<h3 className="mb-1 text-sm font-semibold">
							{t["billing.insufficient"]}
						</h3>
						<p className="text-muted-foreground mb-3 text-xs">
							{t["billing.insufficient_body"]
								.replace("{estimate}", String(insufficient.cost))
								.replace("{balance}", String(insufficient.balance))}
						</p>
						<RedeemForm
							onDone={() => {
								setInsufficient(null);
								billing.refreshBalance();
							}}
						/>
						<button
							type="button"
							onClick={() => setInsufficient(null)}
							className="text-muted-foreground hover:text-foreground mt-2 w-full text-center text-xs"
						>
							{t["common.cancel"]}
						</button>
					</div>
				</div>
			)}
		</PanelView>
	);
}
