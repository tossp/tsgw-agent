import type { Metadata } from "next";
import { I18nProvider } from "@/hooks/useI18n";
import { DebugPage } from "@/components/tsgw-debug/DebugPage";

export const metadata: Metadata = { title: "TSGW · Debug" };

export default function Debug() {
  return (
    <I18nProvider>
      <DebugPage />
    </I18nProvider>
  );
}
