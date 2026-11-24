import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "./types";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "Tiny",
		labelKey: "transcription.model.tiny",
		huggingFaceId: "onnx-community/whisper-tiny",
		descriptionKey: "transcription.model.tiny_desc",
	},
	{
		id: "whisper-base",
		name: "Base",
		labelKey: "transcription.model.base",
		huggingFaceId: "onnx-community/whisper-base",
		descriptionKey: "transcription.model.base_desc",
	},
	{
		id: "whisper-small",
		name: "Small",
		labelKey: "transcription.model.small",
		huggingFaceId: "onnx-community/whisper-small",
		descriptionKey: "transcription.model.small_desc",
	},
	// whisper-medium 暂不提供：默认模型源（魔搭，见 services/transcription/worker.ts）
	// 没有镜像 onnx-community/whisper-medium，选中会在加载阶段失败。魔搭补货后
	// 加回：{ id: "whisper-medium", huggingFaceId: "onnx-community/whisper-medium" }
	{
		id: "whisper-large-v3-turbo",
		name: "Large v3 Turbo",
		labelKey: "transcription.model.large_v3_turbo",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		descriptionKey: "transcription.model.large_v3_turbo_desc",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";
