"use client";

import {
	createContext,
	useContext,
	useState,
	useEffect,
	type ReactNode,
} from "react";
import type { Locale, LocaleStrings } from "./index";
import { getLocale } from "./index";

interface LocaleContextType {
	locale: Locale;
	setLocale: (locale: Locale) => void;
	t: LocaleStrings;
}

const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

export function LocaleProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>("zh");
	const [t, setT] = useState<LocaleStrings>(() => getLocale("zh"));

	useEffect(() => {
		// Load saved locale from localStorage only on client
		const savedLocale = localStorage.getItem("locale") as Locale | null;
		if (savedLocale && (savedLocale === "zh" || savedLocale === "en")) {
			setLocaleState(savedLocale);
			setT(getLocale(savedLocale));
		}
	}, []);

	// Keep <html lang> in step with the active locale (SSR renders the zh
	// default; layout.tsx hardcodes the same value so there is no mismatch).
	useEffect(() => {
		document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
	}, [locale]);

	const setLocale = (newLocale: Locale) => {
		setLocaleState(newLocale);
		setT(getLocale(newLocale));
		localStorage.setItem("locale", newLocale);
	};

	return (
		<LocaleContext.Provider value={{ locale, setLocale, t }}>
			{children}
		</LocaleContext.Provider>
	);
}

export function useLocale() {
	const context = useContext(LocaleContext);
	if (context === undefined) {
		throw new Error("useLocale must be used within a LocaleProvider");
	}
	return context;
}
