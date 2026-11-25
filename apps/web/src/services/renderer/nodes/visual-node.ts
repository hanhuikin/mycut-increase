import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline";
import type { TransitionNodeContext } from "@/transitions/resolve";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/**
	 * 参与转场时由 scene-builder 注入：角色 + 窗口 + 预设参数。
	 * 一个片段两端都可能有转场（片头入画、片尾出画），因此是数组。
	 */
	transitions?: TransitionNodeContext[];
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	/**
	 * 转场窗口里逐帧合成的蒙版（擦除 / 圆形）。优先于元素自带的静态蒙版，
	 * 参数每帧变化，frame-descriptor 据此重绘蒙版纹理。
	 */
	maskOverride?: Mask | null;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
