"use client";

import type {
	ParamDefinition,
	NumberParamDefinition,
	ParamValue,
} from "@/params";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { SectionField } from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/color-picker";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { usePropertyDraft } from "../hooks/use-property-draft";
import { KeyframeToggle } from "./keyframe-toggle";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "@/locale/locale-context";

export function PropertyParamField({
	param,
	value,
	onPreview,
	onCommit,
	keyframe,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	keyframe?: {
		isActive: boolean;
		isDisabled: boolean;
		onToggle: () => void;
	};
}) {
	const { t } = useLocale();
	const label = param.labelKey ? t[param.labelKey] : param.label;

	return (
		<SectionField
			label={label}
			beforeLabel={
				keyframe && param.keyframable !== false ? (
					<KeyframeToggle
						isActive={keyframe.isActive}
						isDisabled={keyframe.isDisabled}
						title={t["properties.toggle_keyframe"].replace(
							"{param}",
							label.toLowerCase(),
						)}
						onToggle={keyframe.onToggle}
					/>
				) : undefined
			}
		>
			<ParamInput
				param={param}
				value={value}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		</SectionField>
	);
}

function ParamInput({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
}) {
	const { t } = useLocale();

	if (param.type === "number") {
		return (
			<NumberParamField
				param={param}
				value={typeof value === "number" ? value : Number(value)}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	if (param.type === "boolean") {
		return (
			<Switch
				checked={Boolean(value)}
				onCheckedChange={(checked) => {
					onPreview(checked);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "select") {
		return (
			<Select
				value={String(value)}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{param.options.map((option) => {
						const optionLabelKey = param.optionLabelKeys?.[option.value];
						return (
							<SelectItem key={option.value} value={option.value}>
								{optionLabelKey ? t[optionLabelKey] : option.label}
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
		);
	}

	if (param.type === "color") {
		return (
			<ColorPicker
				value={String(value).replace(/^#/, "").toUpperCase()}
				onChange={(color) => onPreview(`#${color}`)}
				onChangeEnd={(color) => {
					onPreview(`#${color}`);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "text") {
		return (
			<FreeTextParamField
				value={String(value)}
				onPreview={onPreview}
				onCommit={onCommit}
				multiline={true}
			/>
		);
	}

	if (param.type === "font") {
		return (
			<FreeTextParamField
				value={String(value)}
				onPreview={onPreview}
				onCommit={onCommit}
				multiline={false}
			/>
		);
	}

	return null;
}

/**
 * 文本 / 字体这类自由输入。
 *
 * 不能直接把受控输入框绑到已提交的值上：每次按键都会走 onPreview →
 * previewElements → 通知订阅者重渲染，而属性面板读的是已提交的场景轨道
 * （preview 只存在于 overlay 里），于是 React 把 DOM 值回滚成旧值——表现就是
 * 一个字都敲不进去。这里和数字输入一样用本地 draft：编辑期间显示用户输入，
 * 失焦时才 commit。
 */
function FreeTextParamField({
	value,
	onPreview,
	onCommit,
	multiline,
}: {
	value: string;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	multiline: boolean;
}) {
	const draft = usePropertyDraft<string>({
		displayValue: value,
		parse: (input) => input,
		onPreview,
		onCommit,
		supportsExpressions: false,
	});

	if (multiline) {
		return (
			<Textarea
				value={draft.displayValue}
				onFocus={draft.onFocus}
				onChange={draft.onChange}
				onBlur={draft.onBlur}
			/>
		);
	}

	return (
		<input
			className="border-input bg-accent h-9 w-full rounded-md border px-3 text-sm outline-none"
			value={draft.displayValue}
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
		/>
	);
}

function NumberParamField({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: NumberParamDefinition;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const { min, max, step, displayMultiplier = 1 } = param;
	const displayValue = value * displayMultiplier;
	const clampDisplayValue = (nextDisplayValue: number) =>
		Math.max(
			min,
			max !== undefined ? Math.min(max, nextDisplayValue) : nextDisplayValue,
		);

	const previewFromDisplay = (displayVal: number) => {
		const clamped = clampDisplayValue(snapToStep({ value: displayVal, step }));
		onPreview(clamped / displayMultiplier);
	};

	const maxFractionDigits = getFractionDigitsForStep({ step });

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: displayValue,
			maxFractionDigits,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampDisplayValue(snapToStep({ value: parsed, step }));
		},
		onPreview: previewFromDisplay,
		onCommit,
	});

	const handleReset = () => {
		onPreview(param.default);
		onCommit();
	};

	return (
		<NumberField
			icon={param.shortLabel}
			value={draft.displayValue}
			dragSensitivity="slow"
			isDefault={value === param.default}
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
			onScrub={previewFromDisplay}
			onScrubEnd={onCommit}
			onReset={handleReset}
		/>
	);
}
