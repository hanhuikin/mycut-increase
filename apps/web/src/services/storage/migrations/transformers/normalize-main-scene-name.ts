/**
 * Normalize main scene names to use the internal identifier __main_scene__
 * This migration handles backward compatibility for projects created with
 * hardcoded localized names like "Main scene" or "主场景"
 */

import type { MigrationResult, ProjectRecord } from "./types";
import { isRecord } from "./utils";

export function normalizeMainSceneName({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	const scenesValue = project.scenes;

	if (!Array.isArray(scenesValue) || scenesValue.length === 0) {
		return { project, skipped: true, reason: "no scenes to migrate" };
	}

	let hasChanges = false;
	const updatedScenes = scenesValue.map((scene: any) => {
		if (!isRecord(scene)) {
			return scene;
		}

		// If it's the main scene and has a localized name, normalize it
		if (scene.isMain === true) {
			const name = scene.name;
			// Check if it's using old hardcoded names
			if (name === "Main scene" || name === "主场景" || name === "main scene") {
				hasChanges = true;
				return {
					...scene,
					name: "__main_scene__",
				};
			}
		}

		return scene;
	});

	if (!hasChanges) {
		return { project, skipped: true, reason: "no main scene names to normalize" };
	}

	const updatedProject: ProjectRecord = {
		...project,
		scenes: updatedScenes,
	};

	const now = new Date();
	const updatedAt = now.toISOString();
	if (isRecord(project.metadata)) {
		updatedProject.metadata = {
			...project.metadata,
			updatedAt,
		};
	} else {
		updatedProject.updatedAt = updatedAt;
	}

	return { project: updatedProject, skipped: false };
}

export { getProjectId } from "./utils";
