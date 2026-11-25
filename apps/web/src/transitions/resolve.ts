import { readTransitionDirection } from "./definitions";
import type {
	TransitionDefinition,
	TransitionDirection,
	TransitionFamily,
} from "./types";

/**
 * 转场的纯逻辑：切点查找、窗口钳制、进度 → 渲染修饰。
 *
 * 刻意不依赖 @/wasm 与 @/timeline：这些函数只读「标识 + 起点 + 时长 + 参数」，
 * 用结构类型收口。好处是单测能用普通数字构造数据——bun 多文件同跑时 @/wasm
 * 会在模块初始化期 TDZ（见 timeline/placement 的测试注释）。
 */

/**
 * 一 tick 的时钟刻度：与 rust/crates/time 的 TICKS_PER_SECOND 一致。
 * 只在容差换算里用；调用方传进来的是真实时长（tick），所以不会漂移。
 */
const TICKS_PER_SECOND = 120_000;

/** 插入时允许吸附到切点的最大距离（秒）。 */
export const CUT_SNAP_TOLERANCE_SECONDS = 0.5;

/**
 * 切点计算只需要「标识 + 起点 + 时长」。收窄成结构类型：纯函数不依赖完整
 * 元素（那要 wasm 的 MediaTime），单测可以直接用普通数字构造。
 */
export interface TransitionCandidate {
	id: string;
	startTime: number;
	duration: number;
}

/**
 * 可放转场的「通道」：主轨 + 每条 overlay 视频轨。
 * 转场只关心同一条通道内两段相接的片段——跨轨道的叠放不是切点。
 */
export interface CutLane {
	elements: readonly TransitionCandidate[];
}

export interface CutTracks {
	lanes: readonly CutLane[];
}

export interface CutPoint {
	/** 切点时间（tick）。结构类型里是普通数字，生产链路上就是 MediaTime。 */
	time: number;
	/** 切点前的片段（结束于切点）。 */
	before: TransitionCandidate;
	/** 切点后的片段（开始于切点）。 */
	after: TransitionCandidate;
}

/**
 * 主轨上所有「前一段结束 == 后一段开始」的位置。
 * 按 startTime 排序后两两比较；中间留空隙的位置不算切点。
 */
export function findCutPoints({ tracks }: { tracks: CutTracks }): CutPoint[] {
	const cuts: CutPoint[] = [];
	for (const lane of tracks.lanes) {
		const elements = lane.elements
			.slice()
			.sort((a, b) => a.startTime - b.startTime);
		for (let index = 0; index < elements.length - 1; index += 1) {
			const before = elements[index];
			const after = elements[index + 1];
			if (before.startTime + before.duration === after.startTime) {
				cuts.push({ time: after.startTime, before, after });
			}
		}
	}
	return cuts;
}

/** 播放头附近最近的切点；超出容差返回 null。 */
export function findCutNear({
	tracks,
	time,
	toleranceSeconds = CUT_SNAP_TOLERANCE_SECONDS,
}: {
	tracks: CutTracks;
	time: number;
	toleranceSeconds?: number;
}): CutPoint | null {
	let best: CutPoint | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const cut of findCutPoints({ tracks })) {
		const distance = Math.abs(cut.time - time);
		if (distance < bestDistance) {
			best = cut;
			bestDistance = distance;
		}
	}
	if (!best) return null;
	return bestDistance <= toleranceSeconds * TICKS_PER_SECOND ? best : null;
}

/**
 * 找出转场块对应的切点：按块中心找最近的切点，偏差不超过半个块宽才算绑定。
 *
 * 只看几何位置、不看插入时记录的 cutTime——不然把块拖走之后它还偷偷作用在
 * 原来的切点上。cutTime 只用于面板回显与「重新吸附」。
 */
export function resolveTransitionCut({
	tracks,
	transition,
}: {
	tracks: CutTracks;
	transition: { startTime: number; duration: number };
}): CutPoint | null {
	const center = transition.startTime + transition.duration / 2;
	let best: CutPoint | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const cut of findCutPoints({ tracks })) {
		const distance = Math.abs(cut.time - center);
		if (distance < bestDistance) {
			best = cut;
			bestDistance = distance;
		}
	}
	if (!best) return null;
	// 容差：半个块宽（拖到别处就不再是这条切点的转场）
	const tolerance = Math.max(transition.duration / 2, TICKS_PER_SECOND / 30);
	return bestDistance <= tolerance ? best : null;
}

/**
 * 转场窗口：以切点为中心，两侧各占 duration/2。
 * 时长会被两侧片段长度钳制——转场最多吃掉较短那一侧的全部长度。
 */
export function resolveTransitionWindow({
	transition,
	cut,
}: {
	transition: { duration: number };
	cut: CutPoint;
}): {
	start: number;
	end: number;
	cutTime: number;
	duration: number;
} {
	const maxHalf = Math.min(cut.before.duration, cut.after.duration);
	const duration = Math.min(transition.duration, maxHalf * 2);
	const half = duration / 2;
	return {
		start: Math.round(cut.time - half),
		end: Math.round(cut.time + half),
		cutTime: cut.time,
		duration: Math.round(duration),
	};
}

/** 元素在转场中的角色：出画（前一段）/ 入画（后一段）。 */
export type TransitionRole = "from" | "to";

/** 挂在参与节点上的转场上下文（渲染期算进度用）。 */
export interface TransitionNodeContext {
	kind: TransitionFamily;
	direction: TransitionDirection;
	feather: number;
	intensity: number;
	role: TransitionRole;
	windowStart: number;
	windowEnd: number;
}

export interface TransitionMask {
	shape: "rectangle" | "ellipse";
	direction: TransitionDirection;
	feather: number;
}

export interface TransitionModifiers {
	/** 乘到图层透明度上。 */
	opacity: number;
	/** 平移：画布宽/高的倍数（-1..1）。 */
	translateX: number;
	translateY: number;
	/** 额外缩放倍数（1 = 原样）。 */
	scale: number;
	/** 额外旋转（度）。 */
	rotateDegrees: number;
	/** 擦除 / 圆形：入画片段用渐变蒙版揭开（进度由 resolved progress 决定）。 */
	mask: TransitionMask | null;
	/** 高斯模糊强度（0..1），复用现有 blur pass。 */
	blur: number;
}

const NEUTRAL: TransitionModifiers = {
	opacity: 1,
	translateX: 0,
	translateY: 0,
	scale: 1,
	rotateDegrees: 0,
	mask: null,
	blur: 0,
};

function clamp01({ value }: { value: number }): number {
	return Math.min(1, Math.max(0, value));
}

/** 位移常出现 -0（0 乘负数），归一成 0，避免写进 uniform 后比较失配。 */
function normalizeZero({ value }: { value: number }): number {
	return value === 0 ? 0 : value;
}

/** 平滑缓动：两端慢、中间快，接近主流剪辑软件的默认观感。 */
export function easeInOut({ value }: { value: number }): number {
	const p = clamp01({ value });
	return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
}

/**
 * 进度 → 两个角色的渲染修饰。
 *
 * 叠加模型：出画片段保持不透明铺底，入画片段在其上淡入 / 被蒙版揭开 /
 * 位移入场。这样不改渲染器就能得到正确的交叉过渡（B*p + A*(1-p)），
 * 也避免了「先淡出再淡入」在 A 有透明区域时出现双重曝光。
 */
export function resolveTransitionModifiers({
	kind,
	direction,
	feather,
	intensity,
	role,
	progress,
}: {
	kind: TransitionFamily;
	direction: TransitionDirection;
	feather: number;
	intensity: number;
	role: TransitionRole;
	progress: number;
}): TransitionModifiers {
	const eased = easeInOut({ value: progress });
	const isFrom = role === "from";
	const strength = clamp01({ value: intensity / 100 });
	const featherAmount = clamp01({ value: feather / 100 });
	// 方向决定入画片段从哪一侧进来
	const axis = direction === "left" || direction === "right" ? "x" : "y";
	const sign = direction === "left" || direction === "up" ? -1 : 1;

	switch (kind) {
		case "dissolve":
			return { ...NEUTRAL, opacity: isFrom ? 1 : eased };

		case "fade-black":
		case "fade-white":
			// 前半段出画片段淡到背景色，后半段入画片段从背景色淡入
			return isFrom
				? { ...NEUTRAL, opacity: clamp01({ value: 1 - eased * 2 }) }
				: { ...NEUTRAL, opacity: clamp01({ value: eased * 2 - 1 }) };

		case "push": {
			// 两块拼满画面：出画片段沿方向滑出，入画片段从对侧跟进
			const outgoing = sign * eased;
			const incoming = -sign * (1 - eased);
			const offset = isFrom ? outgoing : incoming;
			return axis === "x"
				? { ...NEUTRAL, translateX: normalizeZero({ value: offset }) }
				: { ...NEUTRAL, translateY: normalizeZero({ value: offset }) };
		}

		case "wipe":
			return {
				...NEUTRAL,
				mask: isFrom
					? null
					: { shape: "rectangle", direction, feather: featherAmount },
			};

		case "circle":
			return {
				...NEUTRAL,
				mask: isFrom
					? null
					: { shape: "ellipse", direction, feather: featherAmount },
			};

		case "zoom": {
			const scaleRange = 0.25 * Math.max(strength, 0.05);
			return isFrom
				? { ...NEUTRAL, scale: 1 + scaleRange * eased }
				: { ...NEUTRAL, opacity: eased, scale: 1 + scaleRange * (1 - eased) };
		}

		case "rotate": {
			const maxDegrees = 90 * Math.max(strength, 0.05);
			return isFrom
				? { ...NEUTRAL, rotateDegrees: -maxDegrees * eased }
				: {
						...NEUTRAL,
						opacity: eased,
						rotateDegrees: maxDegrees * (1 - eased),
					};
		}

		case "blur": {
			const maxBlur = Math.max(strength, 0.05);
			return isFrom
				? { ...NEUTRAL, opacity: 1 - eased, blur: maxBlur * eased }
				: { ...NEUTRAL, opacity: eased, blur: maxBlur * (1 - eased) };
		}
	}
}

export function readNumberParam({
	value,
	fallback,
}: {
	value: unknown;
	fallback: number;
}): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 元素参数（存储值）→ 渲染上下文。未知预设退化成叠化。 */
export function buildTransitionNodeContext({
	transition,
	definition,
	role,
	window,
}: {
	transition: { params: Record<string, unknown> };
	definition: TransitionDefinition | null;
	role: TransitionRole;
	window: { start: number; end: number };
}): TransitionNodeContext {
	return {
		kind: definition?.family ?? "dissolve",
		direction: readTransitionDirection({ value: transition.params.direction }),
		feather: readNumberParam({ value: transition.params.feather, fallback: 8 }),
		intensity: readNumberParam({
			value: transition.params.intensity,
			fallback: 40,
		}),
		role,
		windowStart: window.start,
		windowEnd: window.end,
	};
}

/** 渲染期用：时间 → 0..1 进度。 */
export function resolveTransitionProgress({
	time,
	windowStart,
	windowEnd,
}: {
	time: number;
	windowStart: number;
	windowEnd: number;
}): number {
	if (windowEnd <= windowStart) return 0;
	return clamp01({ value: (time - windowStart) / (windowEnd - windowStart) });
}
