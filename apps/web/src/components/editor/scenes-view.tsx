"use client";
import { useLocale } from "@/locale/locale-context";
import type { TScene } from "@/timeline";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Check, ListCheck, Trash2 } from "lucide-react";
import { cn } from "@/utils/ui";
import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogTrigger,
} from "@/components/ui/dialog";
import { canDeleteScene, getMainScene } from "@/timeline/scenes";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";

export function ScenesView({ children }: { children: React.ReactNode }) {
	const editor = useEditor();
	const scenes = editor.scenes.getScenes();
	const currentScene = editor.scenes.getActiveScene();
	const [isSelectMode, setIsSelectMode] = useState(false);
	const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
	const { t } = useLocale();

	// Helper function to get localized scene name
	const getSceneName = (scene: TScene) => {
		// If it's the main scene, always use the translated name
		if (scene.isMain) {
			return t["scene.main_scene"];
		}
		// Handle generic identifier (for new projects)
		if (scene.name === "__main_scene__") {
			return t["scene.main_scene"];
		}
		// Handle old translated names (for backward compatibility)
		if (scene.name === "Main scene" || scene.name === "主场景") {
			return t["scene.main_scene"];
		}
		// For other scenes, use the stored name
		return scene.name;
	};

	const handleSceneSwitch = async (sceneId: string) => {
		if (isSelectMode) {
			toggleSceneSelection({ sceneId });
			return;
		}

		try {
			await editor.scenes.switchToScene({ sceneId });
		} catch (error) {
			console.error("Failed to switch scene:", error);
		}
	};

	const toggleSceneSelection = ({ sceneId }: { sceneId: string }) => {
		setSelectedScenes((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(sceneId)) {
				newSet.delete(sceneId);
			} else {
				newSet.add(sceneId);
			}
			return newSet;
		});
	};

	const handleSelectMode = () => {
		setIsSelectMode(!isSelectMode);
		setSelectedScenes(new Set());
	};

	const handleDeleteSelected = async () => {
		for (const sceneId of selectedScenes) {
			const scene = scenes.find((scene) => scene.id === sceneId);
			if (!scene) {
				continue;
			}

			const { canDelete, reasonKey } = canDeleteScene({ scene });
			if (!canDelete) {
				toast.error(reasonKey ? t[reasonKey] : t["toast.failed_delete_scene"]);
				continue;
			}

			try {
				await editor.scenes.deleteScene({ sceneId });
			} catch (error) {
				console.error("Failed to delete scene:", error);
			}
		}
		setSelectedScenes(new Set());
		setIsSelectMode(false);
	};

	const isMainSceneSelected = (() => {
		const mainScene = getMainScene({ scenes });
		return Boolean(mainScene?.id && selectedScenes.has(mainScene.id));
	})();

	return (
		<Sheet>
			<SheetTrigger asChild>{children}</SheetTrigger>
			<SheetContent>
				<SheetHeader>
					<SheetTitle>
						{isSelectMode ? t["scene.select_scenes"].replace("{count}", String(selectedScenes.size)) : t["scene.scenes"]}
					</SheetTitle>
					<SheetDescription>
						{isSelectMode
							? t["scene.select_to_delete"]
							: t["scene.switch_between"]}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 py-4">
					<div className="flex items-center gap-2">
						<Button
							className="rounded-md"
							variant={isSelectMode ? "default" : "outline"}
							size="sm"
							onClick={handleSelectMode}
						>
							<ListCheck />
							{isSelectMode ? t["scene.cancel"] : t["scene.select"]}
						</Button>
						{isSelectMode && (
							<DeleteDialog
								count={selectedScenes.size}
								onDelete={handleDeleteSelected}
								disabled={isMainSceneSelected}
								trigger={
									<Button
										className="rounded-md"
										variant="destructive"
										disabled={isMainSceneSelected}
										size="sm"
									>
										<Trash2 />
										{t["scene.delete_count"].replace(
											"{count}",
											String(selectedScenes.size),
										)}
									</Button>
								}
							/>
						)}
					</div>
					{scenes.length === 0 ? (
						<div className="text-muted-foreground text-sm">
							{t["scene.no_scenes"]}
						</div>
					) : (
						<div className="space-y-2">
							{scenes.map((scene) => (
								<Button
									key={scene.id}
									variant="outline"
									className={cn(
										"w-full justify-between font-normal",
										currentScene?.id === scene.id &&
											!isSelectMode &&
											"border-primary !text-primary",
										isSelectMode &&
											selectedScenes.has(scene.id) &&
											"bg-accent border-foreground/30",
									)}
									onClick={() => handleSceneSwitch(scene.id)}
								>
									<span>{getSceneName(scene)}</span>
									<div className="flex items-center gap-2">
										{((isSelectMode && selectedScenes.has(scene.id)) ||
											(!isSelectMode && currentScene?.id === scene.id)) && (
											<Check className="size-4" />
										)}
									</div>
								</Button>
							))}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function DeleteDialog({
	count,
	onDelete,
	disabled,
	trigger,
}: {
	count: number;
	onDelete: () => void;
	disabled?: boolean;
	trigger: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const { t } = useLocale();

	const handleDelete = () => {
		onDelete();
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t["scene.delete_scenes_title"]}</DialogTitle>
					<DialogDescription>
						{t["scene.delete_confirmation"].replace("{count}", String(count))}{" "}
						{t["scene.this_action_cannot_be_undone"]}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						{t["common.cancel"]}
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={disabled}
					>
						{t["common.delete"]}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
