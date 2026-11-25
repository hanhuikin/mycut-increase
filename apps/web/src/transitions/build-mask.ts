import { getMaskDefinition, masksRegistry } from "@/masks";
import type { Mask, MaskByType } from "@/masks/types";
import type { TransitionMask } from "@/transitions/resolve";

/**
 * 转场窗口里的合成蒙版：擦除用矩形、圆形扩展用椭圆，参数由进度直接算，
 * 每帧都变（contentHash 随之变化 → 逐帧重绘，正是我们要的）。
 *
 * 坐标系与内置蒙版一致：centerX/centerY/width/height 都是元素尺寸的比例，
 * 0 表示居中。所以「从左往右揭开 p」= 宽度 p 且左边缘固定：
 * centerX = -(1-p)/2。
 */

/** 按方向把「从一侧揭开」翻译成矩形的位置/尺寸。 */
function resolveRevealRect({
	direction,
	progress,
}: {
	direction: TransitionMask["direction"];
	progress: number;
}): { centerX: number; centerY: number; width: number; height: number } {
	switch (direction) {
		case "left":
			return {
				centerX: -(1 - progress) / 2,
				centerY: 0,
				width: progress,
				height: 1,
			};
		case "right":
			return {
				centerX: (1 - progress) / 2,
				centerY: 0,
				width: progress,
				height: 1,
			};
		case "up":
			return {
				centerX: 0,
				centerY: -(1 - progress) / 2,
				width: 1,
				height: progress,
			};
		case "down":
			return {
				centerX: 0,
				centerY: (1 - progress) / 2,
				width: 1,
				height: progress,
			};
	}
}

/**
 * 生成逐帧蒙版。蒙版注册表在 EditorCore 构造时填充；未注册时返回 null，
 * 转场退化成纯淡入（不会崩）。
 */
export function buildTransitionMask({
	mask,
	progress,
	feather,
}: {
	mask: TransitionMask;
	progress: number;
	feather: number;
}): Mask | null {
	const p = Math.min(1, Math.max(0, progress));
	// 定义的 feather 是 0..1 的强度，蒙版自身按 0..100 计量
	const featherValue = Math.round(Math.min(1, Math.max(0, feather)) * 100);

	if (mask.shape === "ellipse") {
		if (!masksRegistry.has("ellipse")) return null;
		const ellipse = getMaskDefinition("ellipse");
		const params: MaskByType<"ellipse">["params"] = {
			...ellipse.buildDefault({}).params,
			centerX: 0,
			centerY: 0,
			width: p,
			height: p,
			rotation: 0,
			scale: 1,
			feather: featherValue,
			inverted: false,
		};
		return { id: "transition-mask", type: "ellipse", params };
	}

	if (!masksRegistry.has("rectangle")) return null;
	const rectangle = getMaskDefinition("rectangle");
	const params: MaskByType<"rectangle">["params"] = {
		...rectangle.buildDefault({}).params,
		...resolveRevealRect({ direction: mask.direction, progress: p }),
		rotation: 0,
		scale: 1,
		feather: featherValue,
		inverted: false,
	};
	return { id: "transition-mask", type: "rectangle", params };
}
