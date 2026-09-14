"use client";

import { useState } from "react";
import { PanelView } from "./base-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { useLocale } from "@/locale/locale-context";
import type { LocaleKey } from "@/locale";
import { generateVideo } from "@/services/ai-video/generate";
import { readVideoFile } from "@/media/mediabunny";
type Duration = 4 | 5 | 8 | 10 | 12 | 15 | "auto";
type Resolution = "480p" | "720p" | "1080p";
type AspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "21:9" | "adaptive";

const DURATIONS: Duration[] = [4, 5, 8, 10, 12, 15, "auto"];
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

export function AIVideoView() {
  const editor = useEditor();
  const activeProject = useEditor((e) => e.project.getActive());
  const { t } = useLocale();

  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<Duration>("auto");
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [generateAudio, setGenerateAudio] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState("");

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error(t["ai_video.no_prompt"]);
      return;
    }
    if (!activeProject) {
      toast.error(t["ai_video.no_project"]);
      return;
    }

    setIsGenerating(true);
    setProgress("");

    try {
      const result = await generateVideo({
        prompt: prompt.trim(),
        duration,
        resolution,
        aspectRatio,
        generateAudio,
        onProgress: (msg) => setProgress(msg),
      });

      if (!result.success) {
        toast.error(t["ai_video.failed"], {
          description: result.error,
        });
        return;
      }

      // 下载生成的视频
      setProgress(t["ai_video.downloading"]);
      // 走服务端代理下载，绕过 TOS 的 CORS 限制
      const proxyUrl = `/api/media/download?url=${encodeURIComponent(result.videoUrl!)}`;
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
      const file = new File([blob], `seedance-${Date.now()}.mp4`, {
        type: "video/mp4",
      });

      // 读取视频元数据和缩略图（否则素材面板会显示空占位符）
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

      // 加入媒体资产库
      await editor.media.addMediaAsset({
        projectId: activeProject.metadata.id,
        asset: {
          name: `AI视频-${Date.now()}`,
          file,
          type: "video",
          thumbnailUrl,
          duration: videoDuration,
          width,
          height,
        },
      });

      const providerName =
        result.provider === "ark"
          ? t["ai_video.provider_ark"]
          : result.provider === "atlas"
            ? t["ai_video.provider_atlas"]
            : t["ai_video.provider_wavespeed"];
      toast.success(t["ai_video.success"], {
        description: t["ai_video.generated_via"].replace(
          "{provider}",
          providerName,
        ),
      });
      setPrompt("");
    } catch (error) {
      console.error("视频生成失败:", error);
      toast.error(t["ai_video.failed"], {
        description: error instanceof Error ? error.message : t["toast.please_try_again"],
      });
    } finally {
      setIsGenerating(false);
      setProgress("");
    }
  };

  const selectClasses =
    "h-9 w-full rounded-md border bg-background px-3 text-sm";

  return (
    <PanelView title={t["tab.ai_video"]}>
      <div className="flex flex-col gap-4 p-3">
        {/* Prompt 输入 */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-video-prompt">{t["ai_video.prompt_label"]}</Label>
          <textarea
            id="ai-video-prompt"
            className="min-h-[100px] w-full rounded-md border bg-background px-3 py-2 text-sm resize-y"
            placeholder={t["ai_video.prompt_placeholder"]}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            disabled={isGenerating}
          />
        </div>

        {/* Duration */}
        <div className="flex flex-col gap-1.5">
          <Label>{t["ai_video.duration"]}</Label>
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value === "auto" ? "auto" : Number(e.target.value) as Duration)}
            className={selectClasses}
            disabled={isGenerating}
          >
            {DURATIONS.map((d) => (
              <option key={String(d)} value={String(d)}>
                {d === "auto"
                  ? t["ai_video.duration_auto"]
                  : `${d} ${t["common.seconds"]}`}
              </option>
            ))}
          </select>
        </div>

        {/* Resolution */}
        <div className="flex flex-col gap-1.5">
          <Label>{t["ai_video.resolution"]}</Label>
          <select
            value={resolution}
            onChange={(e) => setResolution(e.target.value as Resolution)}
            className={selectClasses}
            disabled={isGenerating}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}（{r.price}）
              </option>
            ))}
          </select>
        </div>

        {/* Aspect Ratio */}
        <div className="flex flex-col gap-1.5">
          <Label>{t["ai_video.aspect_ratio"]}</Label>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            className={selectClasses}
            disabled={isGenerating}
          >
            {ASPECT_RATIOS.map((a) => (
              <option key={a.value} value={a.value}>
                {t[a.labelKey]}
              </option>
            ))}
          </select>
        </div>

        {/* Audio toggle */}
        <div className="flex items-center gap-2">
          <input
            id="ai-video-audio"
            type="checkbox"
            checked={generateAudio}
            onChange={(e) => setGenerateAudio(e.target.checked)}
            disabled={isGenerating}
            className="size-4 rounded"
          />
          <Label htmlFor="ai-video-audio" className="text-sm cursor-pointer">
            {t["ai_video.generate_audio_label"]}
          </Label>
        </div>

        {/* Generate 按钮 */}
        <Button
          onClick={handleGenerate}
          disabled={isGenerating || !prompt.trim()}
          className="w-full"
        >
          {isGenerating ? (progress || t["ai_video.generating"]) : t["ai_video.generate"]}
        </Button>

        {/* Provider 提示 */}
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t["ai_video.provider_primary"]}
          {t["ai_video.provider_ark"]} → {t["ai_video.provider_fallback"]}
          {t["ai_video.provider_atlas"]} → {t["ai_video.provider_wavespeed"]}
          {t["ai_video.hint"]}
        </p>
      </div>
    </PanelView>
  );
}
