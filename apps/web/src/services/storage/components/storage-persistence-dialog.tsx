"use client";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useStoragePersistence } from "@/services/storage/use-storage-persistence";
import { useLocale } from "@/locale/locale-context";

export function StoragePersistenceDialog() {
	const { showDialog, onConfirm, onDismiss } = useStoragePersistence();
	const { t } = useLocale();

	return (
		<Dialog open={showDialog} onOpenChange={(open) => !open && onDismiss()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t["storage.persistence_title"]}</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-base text-muted-foreground">
						{t["storage.persistence_warning"]}
					</p>
					<p className="text-base text-muted-foreground">
						{t["storage.persistence_question"]}
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onDismiss}>
						{t["storage.not_now"]}
					</Button>
					<Button onClick={onConfirm}>{t["storage.allow"]}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
