import { ThemeProvider } from "next-themes";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { BotIdClient } from "botid/client";
import { webEnv } from "@/env/web";
import { Inter } from "next/font/google";
import { LocaleProvider } from "@/locale/locale-context";
import { LogBootstrap } from "@/services/logging/log-bootstrap";
import { TRACE_BOOT_SNIPPET } from "@/services/logging/trace";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<BotIdClient protect={protectedRoutes} />
				{/* Trace id + fetch wrap must exist before the app bundle evaluates:
				    better-auth snapshots `fetch` at module-evaluation time. */}
				<Script id="trace-boot" strategy="beforeInteractive">
					{TRACE_BOOT_SNIPPET}
				</Script>
			</head>
			<body
				className={`${siteFont.className} font-sans antialiased`}
				suppressHydrationWarning
			>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<LocaleProvider>
						<TooltipProvider>
							<LogBootstrap />
							<Toaster />
							<Script
								src="https://cdn.databuddy.cc/databuddy.js"
								strategy="afterInteractive"
								async
								data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
								data-disabled={webEnv.NODE_ENV === "development"}
								data-track-attributes={false}
								data-track-errors={true}
								data-track-outgoing-links={false}
								data-track-web-vitals={false}
								data-track-sessions={false}
							/>
							{children}
						</TooltipProvider>
					</LocaleProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
