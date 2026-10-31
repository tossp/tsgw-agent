import type { Metadata } from "next";
import { I18nProvider } from "@/hooks/useI18n";
import { DebugPage } from "@/tsgw/debug/DebugPage";

export const metadata: Metadata = { title: "TSGW · Task Control" };

export default function Debug() {
  return (
    <I18nProvider>
      <DebugPage />
    </I18nProvider>
  );
}
