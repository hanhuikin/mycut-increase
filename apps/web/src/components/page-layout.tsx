"use client";

import { ReactNode } from "react";
import { cn } from "@/utils/ui";

interface PageLayoutProps {
	children: ReactNode;
	className?: string;
	variant?: "default" | "minimal";
}

export function PageLayout({ children, className, variant = "default" }: PageLayoutProps) {
	if (variant === "minimal") {
		return <div className={cn("min-h-screen", className)}>{children}</div>;
	}

	return (
		<div className={cn("relative min-h-screen overflow-hidden", className)}>
			{/* Animated Background */}
			<div className="fixed inset-0 -z-50">
				{/* Gradient Background */}
				<div className="absolute inset-0 bg-gradient-to-br from-blue-50/50 via-indigo-50/50 to-purple-50/50 dark:from-gray-950 dark:via-blue-950/50 dark:to-purple-950/50" />

				{/* Animated Grid */}
				<div
					className="absolute inset-0 opacity-10 dark:opacity-5"
					style={{
						backgroundImage: `linear-gradient(to right, rgb(99 102 241 / 0.2) 1px, transparent 1px),
						                  linear-gradient(to bottom, rgb(99 102 241 / 0.2) 1px, transparent 1px)`,
						backgroundSize: '4rem 4rem',
					}}
				/>

				{/* Glowing Orbs */}
				<div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-blue-400/20 blur-3xl dark:bg-blue-600/10" />
				<div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-purple-400/20 blur-3xl dark:bg-purple-600/10" />
			</div>

			{/* Content */}
			<div className="relative z-10">{children}</div>
		</div>
	);
}

interface PageHeaderProps {
	title: string;
	description?: string;
	children?: ReactNode;
	className?: string;
}

export function PageHeader({ title, description, children, className }: PageHeaderProps) {
	return (
		<div className={cn("mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8", className)}>
			<div className="text-center">
				<h1 className="bg-gradient-to-r from-gray-900 via-indigo-900 to-purple-900 bg-clip-text text-4xl font-bold tracking-tight text-transparent dark:from-white dark:via-indigo-200 dark:to-purple-200 md:text-5xl">
					{title}
				</h1>
				{description && (
					<p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600 dark:text-gray-300">
						{description}
					</p>
				)}
				{children && <div className="mt-8">{children}</div>}
			</div>
		</div>
	);
}

interface PageContentProps {
	children: ReactNode;
	className?: string;
	maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "4xl" | "6xl" | "7xl" | "full";
}

export function PageContent({ children, className, maxWidth = "7xl" }: PageContentProps) {
	const maxWidthClasses = {
		sm: "max-w-sm",
		md: "max-w-md",
		lg: "max-w-lg",
		xl: "max-w-xl",
		"2xl": "max-w-2xl",
		"4xl": "max-w-4xl",
		"6xl": "max-w-6xl",
		"7xl": "max-w-7xl",
		full: "max-w-full",
	};

	return (
		<div className={cn("mx-auto px-4 pb-12 sm:px-6 lg:px-8", maxWidthClasses[maxWidth], className)}>
			{children}
		</div>
	);
}
