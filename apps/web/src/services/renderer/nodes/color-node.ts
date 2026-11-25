import { BaseNode } from "./base-node";
import type { TransitionFamily } from "@/transitions/types";

export type ColorNodeParams = {
	color: string;
	/**
	 * 转场闪白：给出窗口后，每帧按进度算一层白色叠加的透明度
	 * （0 在两端、1 在切点），由 resolve 写进 resolved.opacity。
	 */
	transitionFlash?: {
		kind: TransitionFamily;
		windowStart: number;
		windowEnd: number;
	};
};

export type ResolvedColorNodeState = {
	opacity: number;
};

export class ColorNode extends BaseNode<
	ColorNodeParams,
	ResolvedColorNodeState
> {}
