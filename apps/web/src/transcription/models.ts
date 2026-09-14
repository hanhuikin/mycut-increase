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
		id: "whisper-small",
		name: "Small",
		labelKey: "transcription.model.small",
		huggingFaceId: "onnx-community/whisper-small",
		descriptionKey: "transcription.model.small_desc",
	},
	{
		id: "whisper-medium",
		name: "Medium",
		labelKey: "transcription.model.medium",
		huggingFaceId: "onnx-community/whisper-medium",
		descriptionKey: "transcription.model.medium_desc",
	},
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
