import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { getElementLocalTime } from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import { effectsRegistry, resolveEffectPasses } from "@/effects";
import type { Effect, EffectPass } from "@/effects/types";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { videoCache } from "@/services/video-cache/service";
import { buildTransitionMask } from "@/transitions/build-mask";
import {
	resolveTransitionModifiers,
	resolveTransitionProgress,
	type TransitionModifiers,
} from "@/transitions/resolve";
import type { CanvasRenderer } from "./canvas-renderer";
import type { AnyBaseNode } from "./nodes/base-node";
import { ColorNode } from "./nodes/color-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { StickerNode, loadStickerSource } from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";

type ResolveContext = {
	renderer: CanvasRenderer;
	time: number;
};

export async function resolveRenderTree({
	node,
	renderer,
	time,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	time: number;
}): Promise<void> {
	await resolveNode({
		node,
		context: {
			renderer,
			time,
		},
	});
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	if (node instanceof ColorNode) {
		node.resolved = resolveColorNode({ node, context });
	} else if (node instanceof VideoNode) {
		node.resolved = await resolveVideoNode({ node, context });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}

	await Promise.all(
		node.children.map((child) => resolveNode({ node: child, context })),
	);
}

function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	width: number;
	height: number;
}): EffectPass[][] {
	return (effects ?? [])
		.filter((effect) => effect.enabled)
		.map((effect) => {
			const resolvedParams = resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime,
			});
			const definition = effectsRegistry.get(effect.type);
			return resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
			});
		});
}

function resolveVisualState({
	params,
	context,
	sourceWidth,
	sourceHeight,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	sourceWidth: number;
	sourceHeight: number;
}): ResolvedVisualNodeState | null {
	const clipTime = context.time - params.timeOffset;
	const activeTransitions = resolveActiveTransitions({
		transitions: params.transitions,
		time: context.time,
	});
	const withinTransitionWindow = activeTransitions.length > 0;
	// 参与转场的片段要在窗口内出画，哪怕时间已经越出自身区间（借素材手柄）
	if (
		(clipTime < 0 || clipTime >= params.duration) &&
		!withinTransitionWindow
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const transform = resolveTransformAtTime({
		baseTransform: params.transform,
		animations: params.animations,
		localTime,
	});
	const opacity = resolveOpacityAtTime({
		baseOpacity: params.opacity,
		animations: params.animations,
		localTime,
	});
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
	);
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);

	const baseEffectPasses = resolveEffectPassGroups({
		effects: params.effects,
		animations: params.animations,
		localTime,
		width: effectWidth,
		height: effectHeight,
	});

	if (!withinTransitionWindow) {
		return {
			localTime,
			transform,
			opacity,
			effectPasses: baseEffectPasses,
		};
	}

	// 转场窗口内：按进度改写透明度 / 位移 / 缩放 / 旋转，并叠加擦除蒙版与模糊
	const modifiers = activeTransitions.reduce<TransitionModifiers>(
		(accumulated, transition) => {
			const progress = resolveTransitionProgress({
				time: context.time,
				windowStart: transition.windowStart,
				windowEnd: transition.windowEnd,
			});
			const next = resolveTransitionModifiers({
				kind: transition.kind,
				direction: transition.direction,
				feather: transition.feather,
				intensity: transition.intensity,
				role: transition.role,
				progress,
			});
			return {
				opacity: accumulated.opacity * next.opacity,
				translateX: accumulated.translateX + next.translateX,
				translateY: accumulated.translateY + next.translateY,
				scale: accumulated.scale * next.scale,
				rotateDegrees: accumulated.rotateDegrees + next.rotateDegrees,
				mask: next.mask ?? accumulated.mask,
				blur: Math.max(accumulated.blur, next.blur),
			};
		},
		{
			opacity: 1,
			translateX: 0,
			translateY: 0,
			scale: 1,
			rotateDegrees: 0,
			mask: null,
			blur: 0,
		},
	);

	// 命中的窗口可能不止一个：取进度最大的那个算蒙版铺开程度
	const maskProgress = activeTransitions.reduce((best, transition) => {
		const progress = resolveTransitionProgress({
			time: context.time,
			windowStart: transition.windowStart,
			windowEnd: transition.windowEnd,
		});
		return Math.max(best, progress);
	}, 0);

	const translateX = modifiers.translateX * context.renderer.width;
	const translateY = modifiers.translateY * context.renderer.height;
	const transitionedTransform = {
		...transform,
		position: {
			x: transform.position.x + translateX,
			y: transform.position.y + translateY,
		},
		scaleX: transform.scaleX * modifiers.scale,
		scaleY: transform.scaleY * modifiers.scale,
		rotate: transform.rotate + modifiers.rotateDegrees,
	};

	const maskOverride = modifiers.mask
		? buildTransitionMask({
				mask: modifiers.mask,
				progress: maskProgress,
				feather: modifiers.mask.feather,
			})
		: undefined;

	const transitionedEffectPasses =
		modifiers.blur > 0
			? [
					...baseEffectPasses,
					...buildTransitionBlurPasses({
						intensity: modifiers.blur,
						width: effectWidth,
						height: effectHeight,
					}),
				]
			: baseEffectPasses;

	return {
		localTime,
		transform: transitionedTransform,
		opacity: opacity * modifiers.opacity,
		effectPasses: transitionedEffectPasses,
		maskOverride,
	};
}

/** 转场用的高斯模糊：复用 blur 效果定义，参数按强度缩放。 */
function buildTransitionBlurPasses({
	intensity,
	width,
	height,
}: {
	intensity: number;
	width: number;
	height: number;
}): EffectPass[][] {
	const blurEffect = effectsRegistry.get("blur");
	return [
		resolveEffectPasses({
			definition: blurEffect,
			effectParams: { intensity: Math.max(1, Math.round(intensity * 100)) },
			width,
			height,
		}),
	];
}

function resolveActiveTransitions({
	transitions,
	time,
}: {
	transitions: VisualNodeParams["transitions"];
	time: number;
}): NonNullable<VisualNodeParams["transitions"]> {
	if (!transitions) return [];
	return transitions.filter(
		(transition) =>
			time >= transition.windowStart && time < transition.windowEnd,
	);
}

function resolveColorNode({
	node,
	context,
}: {
	node: ColorNode;
	context: ResolveContext;
}): { opacity: number } | null {
	const flash = node.params.transitionFlash;
	if (!flash) {
		return { opacity: 1 };
	}
	if (context.time < flash.windowStart || context.time >= flash.windowEnd) {
		return null;
	}
	// 闪白/闪黑：亮度在切点达到峰值，两端为 0
	const progress = resolveTransitionProgress({
		time: context.time,
		windowStart: flash.windowStart,
		windowEnd: flash.windowEnd,
	});
	const peak = 1 - Math.abs(progress * 2 - 1);
	return { opacity: Math.min(1, Math.max(0, peak)) };
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	const withinTransitionWindow =
		resolveActiveTransitions({
			transitions: node.params.transitions,
			time: context.time,
		}).length > 0;
	// 转场窗口内允许越出自身区间：越界部分按素材手柄取帧（素材没余量时
	// videoCache 会钳到首/尾帧，等价于冻结帧，这也是主流软件的行为）。
	if (
		(clipTime < 0 || clipTime >= node.params.duration) &&
		!withinTransitionWindow
	) {
		return null;
	}

	const sourceTimeTicks =
		node.params.trimStart +
		getSourceTimeAtClipTime({
			clipTime,
			retime: node.params.retime,
		});
	const frame = await videoCache.getFrameAt({
		mediaId: node.params.mediaId,
		file: node.params.file,
		time: mediaTimeToSeconds({
			time: roundMediaTime({ time: sourceTimeTicks }),
		}),
	});
	if (!frame) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: frame.canvas,
		sourceWidth: frame.canvas.width,
		sourceHeight: frame.canvas.height,
	};
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth: source.width,
		sourceHeight: source.height,
	};
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadStickerSource({ stickerId: node.params.stickerId });
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth,
		sourceHeight,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): ResolvedGraphicNodeState | null {
	const visualState = resolveVisualState({
		params: node.params,
		context,
		sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
		sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
	});
	if (!visualState) {
		return null;
	}

	return {
		...visualState,
		resolvedParams: resolveGraphicElementParamsAtTime({
			element: node.params,
			localTime: visualState.localTime,
		}),
	};
}

function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): ResolvedTextNodeState | null {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });

	return {
		transform: resolveTransformAtTime({
			baseTransform: node.params.transform,
			animations: node.params.animations,
			localTime,
		}),
		opacity: resolveOpacityAtTime({
			baseOpacity: node.params.opacity,
			animations: node.params.animations,
			localTime,
		}),
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		effectPasses: resolveEffectPassGroups({
			effects: node.params.effects,
			animations: node.params.animations,
			localTime,
			width: context.renderer.width,
			height: context.renderer.height,
		}),
		measuredText: measureTextElement({
			element: node.params,
			canvasHeight: node.params.canvasHeight,
			localTime,
			ctx: getTextMeasurementContext(),
		}),
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const backdropSource = await resolveBackdropSource({ node, clipTime });
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.height,
				reference: 1080,
			}),
		}),
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
}): Promise<BackdropSource | null> {
	if (node.params.mediaType === "video") {
		const sourceTimeTicks =
			node.params.trimStart +
			getSourceTimeAtClipTime({
				clipTime,
				retime: node.params.retime,
			});
		const frame = await videoCache.getFrameAt({
			mediaId: node.params.mediaId,
			file: node.params.file,
			time: mediaTimeToSeconds({
				time: roundMediaTime({ time: sourceTimeTicks }),
			}),
		});
		if (!frame) {
			return null;
		}

		return {
			source: frame.canvas,
			width: frame.canvas.width,
			height: frame.canvas.height,
		};
	}

	const source = await loadImageSource({ url: node.params.url });
	return {
		source: source.source,
		width: source.width,
		height: source.height,
	};
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const definition = effectsRegistry.get(node.params.effectType);
	const passes = resolveEffectPasses({
		definition,
		effectParams: node.params.effectParams,
		width: context.renderer.width,
		height: context.renderer.height,
	});
	if (passes.length === 0) {
		return null;
	}

	return {
		passes,
	};
}
